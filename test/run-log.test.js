/*
 * The deployment's run log (src/lambda/lib/run-log.js).
 *
 * One small object per database recording every run *attempt* the service made:
 * whether the scheduled task ran, and how it ended — including attempts that
 * never reached Geotab, which is the only place those exist. The add-in reads it
 * through the listRuns action and merges it with the tenant's own history.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const runLog = require("../src/lambda/lib/run-log");
const { createFakeRunLogStore } = require("./support/fakes");
const { createLogger } = require("../src/lambda/lib/logger");

function loggerLines() {
  const lines = [];
  return { logger: createLogger({ level: "debug", sink: (line) => lines.push(JSON.parse(line)) }), lines };
}

test("the object key is one per database, under the prefix", () => {
  assert.equal(runLog.keyFor("runs/", "tenant_a"), "runs/tenant_a.json");
  assert.equal(runLog.keyFor("", "tenant_a"), "runs/tenant_a.json", "a missing prefix falls back to runs/");
});

test("a database with no runs yet reads as empty, not as an error", async () => {
  const store = createFakeRunLogStore();
  const log = runLog.createRunLog({ store });
  assert.deepEqual(await log.list("tenant_a"), []);
});

test("a damaged object does not break the history", () => {
  assert.deepEqual(runLog.parseLog("not json", "tenant_a").runs, []);
  assert.deepEqual(runLog.parseLog('{"runs":"nope"}', "tenant_a").runs, []);
  assert.deepEqual(runLog.parseLog(null, "tenant_a"), { schemaVersion: 1, database: "tenant_a", runs: [] });
});

test("runs are newest first and capped", () => {
  let log = runLog.emptyLog("tenant_a");
  for (let i = 0; i < runLog.MAX_RUNS + 5; i++) {
    log = runLog.addRun(log, runLog.recordFor({ database: "tenant_a", at: `2026-10-16T00:00:${String(i).padStart(2, "0")}.000Z` }));
  }
  assert.equal(log.runs.length, runLog.MAX_RUNS);
  assert.equal(log.runs[0].at, `2026-10-16T00:00:${String(runLog.MAX_RUNS + 4).padStart(2, "0")}.000Z`, "newest first");
});

test("a record always has every field, whatever it was given", () => {
  const record = runLog.recordFor({ database: "tenant_a", outcome: "not-a-word", unassigned: -3 });
  assert.equal(record.database, "tenant_a");
  assert.equal(record.outcome, "ran", "an unknown outcome falls back to the safe one");
  assert.equal(record.unassigned, 0, "a negative count is not carried through");
  for (const key of ["at", "occurrence", "trigger", "by", "unassigned", "skipped", "failed", "stillAssigned", "code", "reason", "requestId"]) {
    assert.ok(key in record, `${key} must be present`);
  }
});

test("the outcome word matches what the handler logs with", () => {
  assert.equal(runLog.outcomeOf(null), "ran");
  assert.equal(runLog.outcomeOf({ skippedReason: "another runner already handled this occurrence" }), "idle");
  assert.equal(runLog.outcomeOf({ dryRun: true }), "checked");
  assert.equal(runLog.outcomeOf({ failed: 2 }), "failed");
  assert.equal(runLog.outcomeOf({ unassigned: 10, failed: 0 }), "ran");
});

test("a run summary becomes a record with its counts", () => {
  const record = runLog.recordFromSummary(
    { database: "tenant_a", trigger: "scheduled", by: "Unassign Service", occurrence: "2026-10-16T22:00:00.000Z" },
    // The shapes the handler actually passes: the summarised counts from
    // actions/unassign.js, or the raw result whose lists are arrays.
    { at: "2026-10-16T22:00:03.000Z", unassigned: 10, skipped: 1, failed: 0, stillAssigned: 2 }
  );
  assert.equal(record.outcome, "ran");
  assert.equal(record.unassigned, 10);
  assert.equal(record.skipped, 1);
  assert.equal(record.stillAssigned, 2);
  assert.equal(record.trigger, "scheduled");
});

test("a raw run result's empty lists do not read as failures", () => {
  const record = runLog.recordFromSummary({ database: "tenant_a" }, {
    at: "2026-10-16T22:00:03.000Z",
    unassigned: [{ deviceId: "b1" }],
    skipped: [],
    failed: [],
    stillAssigned: []
  });
  assert.equal(record.outcome, "ran");
  assert.equal(record.unassigned, 1);
  assert.equal(record.failed, 0);
});

test("recording writes the database's object and reads back newest first", async () => {
  const store = createFakeRunLogStore();
  const log = runLog.createRunLog({ store });
  const first = await log.record(runLog.recordFor({ database: "tenant_a", at: "2026-10-16T21:00:00.000Z", outcome: "ran", unassigned: 10 }));
  const second = await log.record(runLog.recordFor({ database: "tenant_a", at: "2026-10-16T22:00:00.000Z", outcome: "failed", code: "GEOTAB_ERROR" }));

  assert.equal(first.recorded, true);
  assert.equal(second.recorded, true);
  assert.equal(store.objects.size, 1, "one object per database");
  const runs = await log.list("tenant_a");
  assert.equal(runs.length, 2);
  assert.equal(runs[0].outcome, "failed", "newest first");
  assert.equal(runs[1].unassigned, 10);
});

test("a concurrent write is retried rather than dropped", async () => {
  const store = createFakeRunLogStore({ conflicts: 1 });
  const log = runLog.createRunLog({ store });
  const result = await log.record(runLog.recordFor({ database: "tenant_a" }));
  assert.equal(result.recorded, true);
  assert.equal(result.attempts, 2, "the first attempt lost the race, the second won");
  assert.equal((await log.list("tenant_a")).length, 1);
});

test("a failing store never fails the run", async () => {
  for (const settings of [{ failWrites: true }, { failReads: true }]) {
    const { logger, lines } = loggerLines();
    const log = runLog.createRunLog({ store: createFakeRunLogStore(settings), logger });
    const result = await log.record(runLog.recordFor({ database: "tenant_a" }));
    assert.equal(result.recorded, false, "reported, not thrown");
    assert.equal(lines[0].level, "warn");
    assert.equal(lines[0].msg, "could not record the run in the run log");
  }
});

test("a record with no database is not written anywhere", async () => {
  const store = createFakeRunLogStore();
  const log = runLog.createRunLog({ store });
  const result = await log.record(runLog.recordFor({ outcome: "failed" }));
  assert.equal(result.recorded, false);
  assert.equal(store.objects.size, 0);
});
