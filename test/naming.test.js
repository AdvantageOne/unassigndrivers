/*
 * Schedule and group names are the deduplication mechanism: the same plan must
 * always produce the same name, and every name must be legal for EventBridge
 * Scheduler ([0-9a-zA-Z-_.]{1,64}).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const naming = require("../src/lambda/lib/naming");

const PLAN = {
  database: "simplot_prod",
  scope: { groupIds: [] },
  mode: "daily",
  time: "23:00",
  timeZone: "America/New_York"
};

test("secretName files each database's service account under the service prefix", () => {
  assert.equal(naming.secretName("jorn"), "unassign/jorn/serviceaccount");
  assert.equal(naming.secretName("advone_matt_dev1"), "unassign/advone_matt_dev1/serviceaccount");
  assert.equal(naming.secretName(" Simplot_Prod "), "unassign/Simplot_Prod/serviceaccount", "trimmed, casing kept");
  assert.equal(naming.SECRET_PREFIX, "unassign/");

  // The segment is checked, not rewritten: it is the identity MyGeotab, the S3
  // record and the schedules all share, and it must not be able to escape its
  // prefix or read as some other system's secret.
  for (const bad of ["", "   ", null, undefined, "../escape", "has/slash", "-leading", "a b", "é"]) {
    assert.throws(() => naming.secretName(bad), /cannot be used in a secret name/, `rejects ${JSON.stringify(bad)}`);
  }
});

test("dbPrefix produces a legal, stable group segment", () => {
  assert.equal(naming.dbPrefix("Simplot_Prod"), "simplot_prod");
  assert.equal(naming.dbPrefix("Tenant A / Prod!"), "tenant-a-prod");
  assert.equal(naming.dbPrefix("A".repeat(80)).length, 40);
  assert.throws(() => naming.dbPrefix("###"), /no usable characters/);
});

test("groupName is prefixed and legal", () => {
  const name = naming.groupName("UnassignDriverSchedules", "simplot_prod");
  assert.equal(name, "UnassignDriverSchedules-simplot_prod");
  assert.ok(naming.NAME_PATTERN.test(name));

  // A long database name is truncated to fit the 64-character limit...
  const long = naming.groupName("UnassignDriverSchedules", "b".repeat(60));
  assert.equal(long.length, 64);
  assert.ok(naming.NAME_PATTERN.test(long));
  // ...but an over-long prefix is a deployment error, not something to hide.
  assert.throws(() => naming.groupName("P".repeat(60), "tenant"), /not a valid EventBridge name/);
});

test("scheduleName is deterministic and depends on the whole plan", () => {
  const base = naming.scheduleName(PLAN);
  assert.equal(base, naming.scheduleName(Object.assign({}, PLAN)));
  assert.match(base, /^all-2300-[0-9a-f]{8}$/);
  assert.ok(base.length <= naming.NAME_MAX_LENGTH);

  const otherTime = naming.scheduleName(Object.assign({}, PLAN, { time: "23:30" }));
  const otherZone = naming.scheduleName(Object.assign({}, PLAN, { timeZone: "America/Chicago" }));
  const otherScope = naming.scheduleName(Object.assign({}, PLAN, { scope: { groupIds: ["b1"] } }));
  const otherDb = naming.scheduleName(Object.assign({}, PLAN, { database: "other_db" }));
  const all = [base, otherTime, otherZone, otherScope, otherDb];
  assert.equal(new Set(all).size, all.length, "every plan field must change the name");
});

test("scope identity is order and duplicate insensitive", () => {
  assert.equal(naming.scopeKey({ groupIds: ["b2", "b1"] }), "b1,b2");
  assert.equal(naming.scopeKey({ groupIds: ["b1", "b1", "b2"] }), "b1,b2");
  assert.equal(naming.scopeKey({ groupIds: [] }), "all");
  assert.equal(naming.scopeKey(null), "all");
  assert.equal(naming.scopeSlug("b1,b2"), "gb1");
  assert.equal(naming.scopeSlug("all"), "all");
});

test("two scopes at the same time are two schedules; one scope is one name", () => {
  const a = naming.scheduleName(Object.assign({}, PLAN, { scope: { groupIds: ["b1"] } }));
  const b = naming.scheduleName(Object.assign({}, PLAN, { scope: { groupIds: ["b2"] } }));
  assert.notEqual(a, b);
  assert.equal(a, naming.scheduleName(Object.assign({}, PLAN, { scope: { groupIds: ["b1"] } })));
});

test("cronExpression covers daily and weekly plans", () => {
  assert.equal(naming.cronExpression(PLAN), "cron(0 23 * * ? *)");
  assert.equal(
    naming.cronExpression(Object.assign({}, PLAN, { mode: "weekly", days: [3, 1] })),
    "cron(0 23 ? * MON,WED *)"
  );
  assert.equal(naming.cronExpression({ mode: "weekly", time: "06:05", days: [0, 6] }), "cron(5 6 ? * SUN,SAT *)");
});

test("atExpression renders a UTC one-time trigger", () => {
  assert.equal(naming.atExpression(new Date("2026-10-16T08:00:00.000Z")), "at(2026-10-16T08:00:00)");
});

test("runName keeps one-time runs apart", () => {
  const at = new Date("2026-10-16T08:00:00.000Z");
  const name = naming.runName({ database: "simplot_prod", scope: { groupIds: [] }, at });
  assert.match(name, /^run-20261016T080000Z-[0-9a-f]{8}$/);
  assert.equal(name, naming.runName({ database: "simplot_prod", scope: { groupIds: [] }, at }));
  assert.notEqual(name, naming.runName({ database: "simplot_prod", scope: { groupIds: [] }, at: new Date("2026-10-16T08:30:00.000Z") }));
});

test("buildSpec rejects plans EventBridge cannot express", () => {
  assert.deepEqual(naming.buildSpec({ mode: "daily", time: "23:00", timeZone: "UTC" }), {
    mode: "daily",
    time: "23:00",
    timeZone: "UTC",
    days: []
  });
  assert.throws(() => naming.buildSpec({ mode: "daily", time: "25:00", timeZone: "UTC" }), /HH:MM/);
  assert.throws(() => naming.buildSpec({ mode: "daily", time: "23:00", timeZone: "Mars/Olympus" }), /Unknown time zone/);
  assert.throws(() => naming.buildSpec({ mode: "weekly", time: "23:00", timeZone: "UTC", days: [] }), /at least one day/);
  assert.throws(() => naming.buildSpec({ mode: "hourly", time: "23:00", timeZone: "UTC" }), /mode must be/);
});
