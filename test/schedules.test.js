/*
 * The action layer turns a form submission into a validated plan. These tests
 * pin the validation, the time-zone handling (including DST), and the fact that
 * a repeated save updates rather than duplicates.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const actions = require("../src/lambda/actions/schedules");
const { createScheduler } = require("../src/lambda/lib/scheduler");
const { createFakeSchedulerClient, createFakeConfig } = require("./support/fakes");

function build(options) {
  const settings = options || {};
  const client = createFakeSchedulerClient();
  const config = createFakeConfig({});
  const scheduler = createScheduler({
    client,
    groupPrefix: "UnassignDriverSchedules",
    targetArn: "arn:aws:lambda:test:000000000000:function:api",
    roleArn: "arn:aws:iam::000000000000:role/scheduler",
    dlqArn: "",
    retry: { maxAttempts: 2, maxAgeSeconds: 3600 }
  });
  return {
    client,
    context: {
      session: { database: "tenant_a", userName: "admin@example.com", sessionId: "session-1", server: "my.geotab.test" },
      config,
      customer: config.customers.tenant_a,
      scheduler,
      now: settings.now || (() => new Date("2026-10-15T00:00:00.000Z")),
      logger: null,
      requestId: "test"
    }
  };
}

const DAILY = { mode: "daily", time: "23:00", timeZone: "America/Toronto" };

test("createSchedule stores a recurring schedule and reports the next run", async () => {
  const { context, client } = build();
  const result = await actions.createSchedule(context, DAILY);

  assert.equal(result.created, true);
  assert.match(result.name, /^all-2300-[0-9a-f]{8}$/);
  // now is 2026-10-15T00:00Z, which is still 2026-10-14 20:00 in Toronto, so the
  // next slot is that evening: 23:00 EDT = 03:00Z on the 15th.
  assert.equal(result.nextRun, "2026-10-15T03:00:00.000Z");
  const stored = client.schedules.get(`UnassignDriverSchedules-tenant_a/${result.name}`);
  assert.equal(stored.ScheduleExpression, "cron(0 23 * * ? *)");
  assert.equal(stored.ScheduleExpressionTimezone, "America/Toronto");
  assert.match(stored.Description, /daily 23:00 America\/Toronto for all assets/);
});

test("the customer's time zone is the default", async () => {
  const { context } = build();
  const result = await actions.createSchedule(context, { mode: "daily", time: "23:00" });
  const view = await actions.listSchedules(context);
  const created = view.schedules.find((schedule) => schedule.name === result.name);
  assert.equal(created.timeZone, "America/Toronto");
});

test("a repeated save updates one schedule instead of adding a second", async () => {
  const { context, client } = build();
  const first = await actions.createSchedule(context, DAILY);
  const second = await actions.createSchedule(context, DAILY);

  assert.equal(first.name, second.name);
  assert.equal(second.created, false);
  assert.equal(client.schedules.size, 1);
});

test("a different scope or time is a different schedule", async () => {
  const { context, client } = build();
  await actions.createSchedule(context, DAILY);
  await actions.createSchedule(context, Object.assign({}, DAILY, { scope: { groupIds: ["b299B"] } }));
  await actions.createSchedule(context, Object.assign({}, DAILY, { time: "06:00" }));
  assert.equal(client.schedules.size, 3);
});

test("plans EventBridge cannot express are rejected with a clear code", async () => {
  const { context } = build();
  await assert.rejects(() => actions.createSchedule(context, { time: "23:00" }), /"mode" is required/);
  await assert.rejects(() => actions.createSchedule(context, { mode: "hourly", time: "23:00" }), /mode must be/);
  await assert.rejects(() => actions.createSchedule(context, { mode: "daily", time: "25:00" }), /HH:MM/);
  await assert.rejects(() => actions.createSchedule(context, { mode: "weekly", time: "23:00" }), /at least one day/);
  await assert.rejects(() => actions.createSchedule(context, { mode: "daily", time: "23:00", timeZone: "Mars/Olympus" }), /Unknown time zone/);
});

test("updateSchedule edits an existing schedule and refuses a one-time run", async () => {
  const { context } = build();
  const created = await actions.createSchedule(context, DAILY);

  const updated = await actions.updateSchedule(context, Object.assign({ name: created.name }, DAILY, { time: "05:30", skipDriving: false }));
  assert.equal(updated.name, created.name);
  assert.equal(updated.nextRun, "2026-10-15T09:30:00.000Z");

  const view = await actions.listSchedules(context);
  assert.equal(view.schedules.length, 1);
  assert.equal(view.schedules[0].time, "05:30");
  assert.equal(view.schedules[0].skipDriving, false);

  await assert.rejects(() => actions.updateSchedule(context, Object.assign({ name: "run-20261016T080000Z-1234abcd" }, DAILY)), /cannot be edited/);
  await assert.rejects(() => actions.updateSchedule(context, Object.assign({ name: "does-not-exist" }, DAILY)), (error) => error.code === "NOT_FOUND");
});

test("addRun schedules a one-time run in the tenant's wall clock", async () => {
  const { context, client } = build();
  const result = await actions.addRun(context, { at: "2026-10-16T08:00", scope: { groupIds: [] } });

  assert.match(result.name, /^run-20261016T120000Z-[0-9a-f]{8}$/);
  assert.equal(result.at, "2026-10-16T12:00:00.000Z", "08:00 America/Toronto in October is 12:00Z");
  const stored = client.schedules.get(`UnassignDriverSchedules-tenant_a/${result.name}`);
  assert.equal(stored.ScheduleExpression, "at(2026-10-16T12:00:00)");
  assert.equal(stored.ScheduleExpressionTimezone, undefined);
  assert.equal(stored.ActionAfterCompletion, "DELETE");
});

test("a one-time run in the DST overlap resolves to the first instant", async () => {
  const { context } = build();
  // 2026-11-01 01:30 America/Toronto happens twice; the earlier (EDT) one wins.
  const result = await actions.addRun(context, { at: "2026-11-01T01:30" });
  assert.equal(result.at, "2026-11-01T05:30:00.000Z");
});

test("a one-time run in the past is rejected", async () => {
  const { context } = build();
  await assert.rejects(() => actions.addRun(context, { at: "2026-10-14T08:00" }), /at least a minute in the future/);
  await assert.rejects(() => actions.addRun(context, { at: "2026-10-16T08:00Z" }), /must be a local date and time/);
  await assert.rejects(() => actions.addRun(context, {}), /"at" is required/);
});

test("deleteSchedule is idempotent", async () => {
  const { context } = build();
  const created = await actions.createSchedule(context, DAILY);
  assert.deepEqual(await actions.deleteSchedule(context, { name: created.name }), { name: created.name, deleted: true });
  assert.deepEqual(await actions.deleteSchedule(context, { name: created.name }), { name: created.name, deleted: false });
  await assert.rejects(() => actions.deleteSchedule(context, {}), /"name" is required/);
});

test("listSchedules is empty for a tenant with no group yet", async () => {
  const { context } = build();
  assert.deepEqual(await actions.listSchedules(context), { database: "tenant_a", timeZone: "America/Toronto", schedules: [] });
});

test("skipDriving follows the payload, then the deployment default", async () => {
  const { context } = build();
  assert.equal(actions.resolveSkipDriving({ skipDriving: false }, context.config), false);
  assert.equal(actions.resolveSkipDriving({}, context.config), true);
  const config = createFakeConfig({ defaults: { skipDriving: false, graceMinutes: 60 } });
  assert.equal(actions.resolveSkipDriving({}, config), false);
});

test("scope is normalised to sorted group ids", () => {
  assert.deepEqual(actions.resolveScope({ scope: { groupIds: ["b2", "b1", "b1"] } }), { groupIds: ["b1", "b2"] });
  assert.deepEqual(actions.resolveScope({}), { groupIds: [] });
  assert.deepEqual(actions.resolveScope(null), { groupIds: [] });
});
