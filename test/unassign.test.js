/*
 * The worker is the only thing that mutates a tenant database, so it is tested
 * through the shared core with an in-memory MyGeotab: dry runs must not write,
 * the migration lock must stop a double run, and a permission failure must be
 * reported differently depending on whose credentials were used.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runUnassign } = require("../src/lambda/actions/unassign");
const { appError } = require("../src/lambda/lib/errors");
const { createCoreApi } = require("./support/fakes");

const TENANT = "tenant_a";
const SECRET = { database: TENANT, server: "my.geotab.test", userName: "svc-unassign", password: "p" };

/** Two assets, both with a real driver; b1 is driving. */
const CORE = {
  devices: [
    { id: "b1", name: "Truck 1" },
    { id: "b2", name: "Truck 2" }
  ],
  statuses: [{ device: { id: "b1" }, isDriving: true }],
  changes: {
    b1: [{ device: { id: "b1" }, driver: { id: "drv1" }, dateTime: "2026-10-01T10:00:00.000Z", type: "Driver" }],
    b2: [{ device: { id: "b2" }, driver: { id: "drv2" }, dateTime: "2026-10-01T11:00:00.000Z", type: "Driver" }]
  },
  users: { drv1: { id: "drv1", firstName: "Dan", lastName: "River" }, drv2: { id: "drv2", firstName: "Ann", lastName: "Other" } }
};

/** Routes the worker's core calls into the in-memory MyGeotab. */
function geotabFor(state) {
  const { api } = state;
  const promiseCall = (method, params) => new Promise((ok, err) => api.call(method, params, ok, err));
  return () => ({
    server: "my.geotab.test",
    authenticate: async (account) => ({ database: account.database, userName: account.userName, sessionId: "svc-session" }),
    session: (credentials) => ({
      credentials,
      database: credentials.database,
      userName: credentials.userName,
      server: "my.geotab.test",
      call: promiseCall,
      multiCall: (calls) => new Promise((ok, err) => api.multiCall(calls, ok, err))
    })
  });
}

function context(overrides) {
  const state = createCoreApi((overrides && overrides.coreOptions) || CORE);
  return Object.assign(
    {
      state,
      env: { version: "test" },
      logger: null,
      now: () => new Date("2026-10-15T00:00:00.000Z"),
      geotabFor: geotabFor(state),
      scope: { groupIds: [] },
      skipDriving: false,
      trigger: "scheduled",
      by: "Unassign Service",
      occurrence: "2026-10-15T00:00:00.000Z",
      invocationId: "req-1",
      lockWaitMs: 0
    },
    overrides || {}
  );
}

test("a scheduled run unassigns and appends a tenant run record", async () => {
  const ctx = context({ secret: SECRET });
  const result = await runUnassign(ctx);

  assert.equal(result.unassigned, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.stillAssigned, 0);
  assert.equal(result.legacyLock, false);
  assert.equal(ctx.state.behaviour.addedChanges.length, 2);

  const log = ctx.state.state.addInData.find((record) => record.details.type === "log");
  assert.equal(log.details.entries.length, 1);
  assert.equal(log.details.entries[0].trigger, "scheduled");
  assert.equal(log.details.entries[0].by, "Unassign Service");
  assert.equal(log.details.entries[0].occurrence, "2026-10-15T00:00:00.000Z");
  assert.equal(log.details.entries[0].unassigned.length, 2);
});

test("skipDriving leaves driving assets alone", async () => {
  const ctx = context({ secret: SECRET, skipDriving: true });
  const result = await runUnassign(ctx);
  assert.equal(result.unassigned, 1);
  assert.equal(result.skipped, 1);
  assert.equal(ctx.state.behaviour.addedChanges.length, 1);
});

test("a dry run reads but never writes", async () => {
  const ctx = context({ secret: SECRET, dryRun: true });
  const result = await runUnassign(ctx);

  assert.equal(result.dryRun, true);
  assert.equal(result.count, 2);
  assert.equal(result.rows.length, 2);
  assert.equal(ctx.state.behaviour.addedChanges.length, 0);
  assert.equal(ctx.state.state.addInData.length, 0, "a dry run must not touch the run log");
});

test("a legacy AddInData schedule that was already claimed stops the run", async () => {
  const ctx = context({
    secret: SECRET,
    coreOptions: Object.assign({}, CORE, {
      addInData: [
        {
          id: "s1",
          version: "1",
          details: {
            type: "schedule",
            enabled: true,
            mode: "daily",
            time: "23:00",
            timeZone: "UTC",
            lastOccurrence: "2026-10-15T00:00:00.000Z"
          }
        }
      ]
    })
  });
  const result = await runUnassign(ctx);

  assert.match(result.skippedReason, /already handled/);
  assert.equal(ctx.state.behaviour.addedChanges.length, 0);
});

test("a legacy schedule with nothing claimed yet is claimed by this run", async () => {
  const ctx = context({
    secret: SECRET,
    coreOptions: Object.assign({}, CORE, {
      addInData: [
        { id: "s1", version: "1", details: { type: "schedule", enabled: true, mode: "daily", time: "23:00", timeZone: "UTC", lastOccurrence: null } }
      ]
    })
  });
  const result = await runUnassign(ctx);

  assert.equal(result.unassigned, 2);
  assert.equal(result.legacyLock, true);
  const schedule = ctx.state.state.addInData.find((record) => record.details.type === "schedule");
  assert.equal(schedule.details.lastOccurrence, "2026-10-15T00:00:00.000Z");
  assert.match(schedule.details.claimedBy, /^lambda-req-1$/);
});

test("a permission failure on a manual run is reported as a clearance problem", async () => {
  const ctx = context({
    session: { database: TENANT, userName: "user@example.com", sessionId: "session-1" },
    secret: null,
    geotabFor: () => ({
      server: "my.geotab.test",
      authenticate: async () => ({}),
      session: () => ({
        call: async () => {
          throw appError("GEOTAB_ERROR", "PermissionDeniedException: no permission to add DriverChange");
        },
        multiCall: async () => []
      })
    })
  });
  await assert.rejects(() => runUnassign(ctx), (error) => error.code === "CLEARANCE_REQUIRED");
});

test("the same failure on a scheduled run stays a provisioning error", async () => {
  const ctx = context({
    secret: SECRET,
    geotabFor: () => ({
      server: "my.geotab.test",
      authenticate: async () => ({}),
      session: () => ({
        call: async () => {
          throw appError("GEOTAB_ERROR", "PermissionDeniedException: no permission to add DriverChange");
        },
        multiCall: async () => []
      })
    })
  });
  await assert.rejects(() => runUnassign(ctx), (error) => error.code === "GEOTAB_ERROR");
});

test("a bad service-account password fails the run instead of retrying forever", async () => {
  const ctx = context({
    secret: SECRET,
    geotabFor: () => ({
      server: "my.geotab.test",
      authenticate: async () => {
        throw appError("INTERNAL", "InvalidUserException: invalid credentials");
      },
      session: () => ({ call: async () => [], multiCall: async () => [] })
    })
  });
  await assert.rejects(() => runUnassign(ctx), (error) => error.code === "INTERNAL");
});
