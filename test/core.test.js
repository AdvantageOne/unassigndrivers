/*
 * The shared core is the one piece of logic the add-in and the Lambda both run,
 * so it gets the deepest tests: DST-correct time math, the due/missed decision,
 * the cross-writer lock, and the unassign retry path.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/core/unassign-core");
const { createCoreApi, ADDIN_ID } = require("./support/fakes");

function iso(date) {
  return date.toISOString();
}

test("zonedToUtc resolves a wall clock in a fixed-offset zone", () => {
  assert.equal(iso(core.zonedToUtc(2026, 6, 1, 23, 0, "America/New_York")), "2026-06-02T03:00:00.000Z");
  assert.equal(iso(core.zonedToUtc(2026, 1, 15, 23, 0, "America/New_York")), "2026-01-16T04:00:00.000Z");
  assert.equal(iso(core.zonedToUtc(2026, 6, 1, 23, 0, "UTC")), "2026-06-01T23:00:00.000Z");
});

test("zonedToUtc lands on a real instant inside a spring-forward gap", () => {
  // 02:30 does not exist in America/Toronto on 2026-03-08.
  const resolved = core.zonedToUtc(2026, 3, 8, 2, 30, "America/Toronto");
  const parts = core.localParts(resolved, "America/Toronto");
  assert.ok(parts.hh === 2 || parts.hh === 3, `expected a time inside or just after the gap, got ${parts.hh}:${parts.mm}`);
  assert.ok(resolved.getTime() >= Date.UTC(2026, 2, 8, 6, 30), "must not resolve before the requested wall clock");
  assert.ok(resolved.getTime() <= Date.UTC(2026, 2, 8, 8, 30), "must not resolve more than two hours late");
});

test("occurrencesBetween enumerates daily, weekly and one-time slots", () => {
  const from = new Date("2026-06-01T00:00:00.000Z");
  const to = new Date("2026-06-04T00:00:00.000Z");
  const daily = core.occurrencesBetween({ mode: "daily", time: "23:00", timeZone: "UTC" }, from, to);
  assert.deepEqual(daily.map(iso), ["2026-06-01T23:00:00.000Z", "2026-06-02T23:00:00.000Z", "2026-06-03T23:00:00.000Z"]);

  const weekly = core.occurrencesBetween(
    { mode: "weekly", time: "06:30", timeZone: "UTC", days: [1, 3] },
    new Date("2026-06-01T00:00:00.000Z"),
    new Date("2026-06-09T00:00:00.000Z")
  );
  assert.deepEqual(weekly.map(iso), [
    "2026-06-01T06:30:00.000Z", // Monday
    "2026-06-03T06:30:00.000Z", // Wednesday
    "2026-06-08T06:30:00.000Z" // next Monday
  ]);
  assert.deepEqual(core.occurrencesBetween(
    { mode: "weekly", time: "06:30", timeZone: "UTC", days: [1, 3] },
    new Date("2026-06-01T00:00:00.000Z"),
    new Date("2026-06-05T00:00:00.000Z")
  ).map(iso), ["2026-06-01T06:30:00.000Z", "2026-06-03T06:30:00.000Z"]);

  const once = core.occurrencesBetween(
    { mode: "once", time: "12:00", timeZone: "UTC", onceDate: "2026-06-02" },
    from,
    to
  );
  assert.deepEqual(once.map(iso), ["2026-06-02T12:00:00.000Z"]);
});

test("nextOccurrence walks past the last handled slot", () => {
  const schedule = { mode: "daily", time: "23:00", timeZone: "UTC" };
  const next = core.nextOccurrence(schedule, new Date("2026-06-01T23:30:00.000Z"));
  assert.equal(iso(next), "2026-06-02T23:00:00.000Z");
});

test("evaluateDue distinguishes due, missed, disabled and never-activated", () => {
  const base = {
    enabled: true,
    mode: "daily",
    time: "23:00",
    timeZone: "UTC",
    activatedAt: "2026-06-01T00:00:00.000Z",
    lastOccurrence: null
  };
  const occurrence = "2026-06-01T23:00:00.000Z";

  const due = core.evaluateDue(Object.assign({}, base, { graceMinutes: 60 }), new Date("2026-06-01T23:20:00.000Z"));
  assert.equal(due.action, "run");
  assert.equal(iso(due.occurrence), occurrence);

  const missed = core.evaluateDue(Object.assign({}, base, { graceMinutes: 5 }), new Date("2026-06-01T23:20:00.000Z"));
  assert.equal(missed.action, "missed");
  assert.equal(iso(missed.occurrence), occurrence);

  const alreadyHandled = core.evaluateDue(
    Object.assign({}, base, { lastOccurrence: occurrence, graceMinutes: 600 }),
    new Date("2026-06-02T00:10:00.000Z")
  );
  assert.equal(alreadyHandled.action, "none");

  const disabled = core.evaluateDue(Object.assign({}, base, { enabled: false }), new Date("2026-06-01T23:20:00.000Z"));
  assert.equal(disabled.action, "none");

  const beforeActivation = core.evaluateDue(
    Object.assign({}, base, { activatedAt: "2026-06-02T00:00:00.000Z" }),
    new Date("2026-06-01T23:20:00.000Z")
  );
  assert.equal(beforeActivation.action, "none");
});

test("claimOccurrence lets exactly one of two competing runners win", async () => {
  const record = {
    id: "addin-1",
    version: "1",
    details: {
      type: "schedule",
      enabled: true,
      mode: "daily",
      time: "23:00",
      timeZone: "UTC",
      activatedAt: "2026-06-01T00:00:00.000Z",
      lastOccurrence: null
    }
  };
  const first = createCoreApi({ addInData: [JSON.parse(JSON.stringify(record))] });
  const second = createCoreApi({});
  second.state.addInData = first.state.addInData; // same Geotab database, two runners

  const occurrence = "2026-06-01T23:00:00.000Z";
  const [a, b] = await Promise.all([
    core.claimOccurrence(first.api, occurrence, "lambda-a", "Unassign Service", 0),
    core.claimOccurrence(second.api, occurrence, "lambda-b", "Unassign Service", 0)
  ]);
  assert.equal([a, b].filter(Boolean).length, 1, "exactly one runner may hold the occurrence");

  const records = await core.loadRecords(first.api);
  assert.equal(records.schedule.details.lastOccurrence, occurrence);
});

test("getAssignments reports only devices with a real driver", async () => {
  const { api } = createCoreApi({});
  const rows = await core.getAssignments(api, { now: new Date("2026-10-02T00:00:00.000Z") });

  assert.deepEqual(
    rows.map((row) => row.deviceId),
    ["b1"]
  );
  assert.equal(rows[0].driverName, "Dan River");
  assert.equal(rows[0].isDriving, true);
  assert.equal(rows[0].changeType, "Driver");
});

test("getAssignments ignores DriverChanges dated in the future", async () => {
  const { api } = createCoreApi({
    changes: { b1: [{ device: { id: "b1" }, driver: { id: "drv1" }, dateTime: "2026-12-01T00:00:00.000Z", type: "Driver" }] },
    devices: [{ id: "b1", name: "Truck 1" }]
  });
  const rows = await core.getAssignments(api, { now: new Date("2026-10-02T00:00:00.000Z") });
  assert.deepEqual(rows, []);
});

test("unassign skips driving assets when asked and writes UnknownDriverId", async () => {
  const { api, behaviour } = createCoreApi({});
  const rows = [
    { deviceId: "b1", deviceName: "Truck 1", driverName: "Dan River", isDriving: true },
    { deviceId: "b2", deviceName: "Truck 2", driverName: "Ann Other", isDriving: false }
  ];
  const result = await core.unassign(api, rows, { now: new Date("2026-10-02T01:00:00.000Z"), skipDriving: true });

  assert.deepEqual(result.unassigned.map((row) => row.deviceId), ["b2"]);
  assert.deepEqual(result.skipped.map((row) => row.deviceId), ["b1"]);
  assert.equal(behaviour.addedChanges.length, 1);
  assert.equal(behaviour.addedChanges[0].driver.id, "UnknownDriverId");
  assert.equal(behaviour.addedChanges[0].device.id, "b2");
  assert.equal(behaviour.addedChanges[0].type, "Driver");
});

test("unassign recovers from a failed batch by re-reading and retrying only what is still assigned", async () => {
  // multiCall is not transactional: pretend b1's write landed before the batch failed.
  const { api, behaviour } = createCoreApi({
    addBlocks: 1,
    changes: {
      b1: [{ device: { id: "b1" }, driver: { id: "UnknownDriverId" }, dateTime: "2026-10-02T00:59:00.000Z", type: "Driver" }],
      b2: [{ device: { id: "b2" }, driver: { id: "drv1" }, dateTime: "2026-10-01T10:00:00.000Z", type: "Driver" }]
    }
  });
  const rows = [
    { deviceId: "b1", deviceName: "Truck 1", driverName: "Dan River", isDriving: false },
    { deviceId: "b2", deviceName: "Truck 2", driverName: "Ann Other", isDriving: false }
  ];
  const result = await core.unassign(api, rows, { now: new Date("2026-10-02T01:00:00.000Z") });

  assert.deepEqual(result.unassigned.map((row) => row.deviceId).sort(), ["b1", "b2"]);
  assert.deepEqual(result.failed, []);
  assert.equal(behaviour.addedChanges.length, 1, "the device already unassigned must not be written twice");
  assert.equal(behaviour.addedChanges[0].device.id, "b2");
});

test("appendLog records a scheduled occurrence once", async () => {
  const { api } = createCoreApi({});
  const entry = { at: "2026-10-02T01:00:00.000Z", trigger: "scheduled", occurrence: "2026-10-02T01:00:00.000Z", by: "Unassign Service" };

  const first = await core.appendLog(api, entry);
  const second = await core.appendLog(api, entry);

  assert.equal(first.duplicate, undefined);
  assert.equal(second.duplicate, true);
  const records = await core.loadRecords(api);
  assert.equal(records.log.details.entries.length, 1);
  assert.equal(records.log.details.type, "log");
});

test("loadRecords finds the schedule and log written under this add-in id", async () => {
  const { api } = createCoreApi({
    addInData: [
      { id: "s1", version: "1", details: { type: "schedule", enabled: true, time: "23:00", timeZone: "UTC" } },
      { id: "l1", version: "1", details: { type: "log", entries: [] } }
    ]
  });
  const records = await core.loadRecords(api);
  assert.equal(records.schedule.id, "s1");
  assert.equal(records.log.id, "l1");
  assert.equal(core.ADDIN_ID, ADDIN_ID);
});
