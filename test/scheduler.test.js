/*
 * The scheduler wrapper is where deduplication and the target payload live:
 * the same plan must update one schedule, the payload must name exactly one
 * Geotab database, and one-time runs must delete themselves.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createScheduler } = require("../src/lambda/lib/scheduler");
const { createFakeSchedulerClient } = require("./support/fakes");

const TARGET = "arn:aws:lambda:ca-central-1:000000000000:function:advone-unassign-api";
const ROLE = "arn:aws:iam::000000000000:role/advone-unassign-scheduler";
const DLQ = "arn:aws:sqs:ca-central-1:000000000000:advone-unassign-dlq";

function build(options) {
  const settings = options || {};
  const client = settings.client || createFakeSchedulerClient();
  const scheduler = createScheduler({
    client,
    groupPrefix: "UnassignDriverSchedules",
    targetArn: settings.targetArn === undefined ? TARGET : settings.targetArn,
    roleArn: settings.roleArn === undefined ? ROLE : settings.roleArn,
    dlqArn: settings.dlqArn === undefined ? DLQ : settings.dlqArn,
    retry: { maxAttempts: 2, maxAgeSeconds: 3600 },
    now: settings.now
  });
  return { scheduler, client };
}

const PLAN = {
  database: "simplot_prod",
  scope: { groupIds: [] },
  skipDriving: true,
  mode: "daily",
  time: "23:00",
  timeZone: "America/New_York",
  spec: { mode: "daily", time: "23:00", timeZone: "America/New_York", days: [] }
};

test("upsert creates a schedule with the documented target payload", async () => {
  const { scheduler, client } = build();
  const result = await scheduler.upsert(PLAN);

  assert.equal(result.created, true);
  assert.match(result.name, /^all-2300-[0-9a-f]{8}$/);
  assert.equal(result.group, "UnassignDriverSchedules-simplot_prod");
  assert.ok(client.groups.has(result.group), "the tenant's schedule group is created on demand");

  const stored = client.schedules.get(`${result.group}/${result.name}`);
  assert.equal(stored.ScheduleExpression, "cron(0 23 * * ? *)");
  assert.equal(stored.ScheduleExpressionTimezone, "America/New_York");
  assert.equal(stored.FlexibleTimeWindow.Mode, "OFF");
  assert.equal(stored.ActionAfterCompletion, "NONE");
  assert.equal(stored.State, "ENABLED");
  assert.equal(stored.Target.Arn, TARGET);
  assert.equal(stored.Target.RoleArn, ROLE);
  assert.deepEqual(stored.Target.DeadLetterConfig, { Arn: DLQ });
  assert.deepEqual(stored.Target.RetryPolicy, { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 2 });
  assert.equal(stored.RetryPolicy, undefined, "RetryPolicy belongs to the target, not the schedule");

  const payload = JSON.parse(stored.Target.Input);
  assert.equal(payload.action, "unassign");
  assert.equal(payload.source, "scheduler");
  assert.equal(payload.geotab_database, "simplot_prod");
  assert.deepEqual(payload.group_ids, []);
  assert.equal(payload.skip_driving, true);
  assert.equal(payload.spec.timeZone, "America/New_York");
});

test("the same plan upserts instead of creating a duplicate", async () => {
  const { scheduler, client } = build();
  const first = await scheduler.upsert(PLAN);
  const second = await scheduler.upsert(PLAN);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.name, first.name);
  assert.equal(client.schedules.size, 1, "one plan must map to exactly one schedule");
});

test("two scopes at the same time are two schedules", async () => {
  const { scheduler, client } = build();
  await scheduler.upsert(PLAN);
  await scheduler.upsert(Object.assign({}, PLAN, { scope: { groupIds: ["b299B"] } }));
  assert.equal(client.schedules.size, 2);
});

test("one-time runs fire once and delete themselves", async () => {
  const { scheduler, client } = build();
  const at = new Date("2026-10-16T08:00:00.000Z");
  const result = await scheduler.upsert(Object.assign({}, PLAN, { oneTime: true, at, spec: { mode: "once", time: "00:00", timeZone: "UTC", days: [], onceAt: at.toISOString() } }));

  const stored = client.schedules.get(`${result.group}/${result.name}`);
  assert.equal(stored.ScheduleExpression, "at(2026-10-16T08:00:00)");
  assert.equal(stored.ActionAfterCompletion, "DELETE");
  assert.equal(stored.ScheduleExpressionTimezone, undefined, "one-time runs are expressed in UTC");
});

test("a deployment without a target refuses to create schedules", async () => {
  const { scheduler } = build({ targetArn: "" });
  await assert.rejects(() => scheduler.upsert(PLAN), /no schedule target configured/);
});

test("an existing schedule group is not an error", async () => {
  const client = createFakeSchedulerClient();
  client.groups.add("UnassignDriverSchedules-simplot_prod");
  const { scheduler } = build({ client });
  assert.equal(await scheduler.ensureGroup("simplot_prod"), "UnassignDriverSchedules-simplot_prod");
});

test("list returns everything in the tenant's group and nothing when it is empty", async () => {
  const { scheduler } = build();
  assert.deepEqual(await scheduler.list("simplot_prod"), []);
  await scheduler.upsert(PLAN);
  const listed = await scheduler.list("simplot_prod");
  assert.equal(listed.length, 1);
  assert.match(listed[0].Name, /^all-2300-[0-9a-f]{8}$/);
  assert.equal(listed[0].GroupName, "UnassignDriverSchedules-simplot_prod");
});

test("remove is idempotent", async () => {
  const { scheduler } = build();
  const created = await scheduler.upsert(PLAN);
  assert.equal(await scheduler.remove("simplot_prod", created.name), true);
  assert.equal(await scheduler.remove("simplot_prod", created.name), false);
});

test("toView rebuilds the plan and the next run from the stored payload", async () => {
  const now = new Date("2026-10-15T00:00:00.000Z");
  const { scheduler } = build({ now: () => now });
  const created = await scheduler.upsert(Object.assign({}, PLAN, { scope: { groupIds: ["b299B"] }, skipDriving: false }));
  const schedule = await scheduler.describe("simplot_prod", created.name);
  const view = scheduler.toView(schedule, { now });

  assert.equal(view.kind, "recurring");
  assert.equal(view.mode, "daily");
  assert.equal(view.time, "23:00");
  assert.equal(view.timeZone, "America/New_York");
  assert.deepEqual(view.scope.groupIds, ["b299B"]);
  assert.equal(view.skipDriving, false);
  assert.equal(view.nextRun, "2026-10-15T03:00:00.000Z", "23:00 America/New_York on 2026-10-15 is 03:00Z");
});

test("toView reports a one-time run only while it is still ahead", async () => {
  const at = new Date("2026-10-16T08:00:00.000Z");
  const { scheduler } = build();
  const created = await scheduler.upsert(Object.assign({}, PLAN, { oneTime: true, at, spec: { mode: "once", time: "00:00", timeZone: "UTC", days: [], onceAt: at.toISOString() } }));
  const schedule = await scheduler.describe("simplot_prod", created.name);

  const before = scheduler.toView(schedule, { now: new Date("2026-10-16T07:00:00.000Z") });
  assert.equal(before.kind, "one-time");
  assert.equal(before.nextRun, at.toISOString());

  const after = scheduler.toView(schedule, { now: new Date("2026-10-16T09:00:00.000Z") });
  assert.equal(after.nextRun, null);
});

test("toView reports the zone the run was scheduled in, not EventBridge's default", () => {
  const { scheduler } = build();
  const at = new Date("2026-10-16T08:00:00.000Z");
  const plan = Object.assign({}, PLAN, {
    oneTime: true,
    at,
    name: "run-20261016T080000Z-abcd1234",
    spec: { mode: "once", time: "00:00", timeZone: "America/Vancouver", days: [], onceAt: at.toISOString() }
  });
  // Exactly what GetSchedule returns for a one-time run: an absolute instant,
  // and EventBridge's own default in the field we deliberately leave unset — so
  // the stored payload is the only record of the tenant's zone.
  const view = scheduler.toView(
    {
      Name: plan.name,
      GroupName: "UnassignDriverSchedules-simplot_prod",
      ScheduleExpression: "at(2026-10-16T08:00:00)",
      ScheduleExpressionTimezone: "UTC",
      State: "ENABLED",
      ActionAfterCompletion: "DELETE",
      Target: { Input: scheduler.buildInput(plan) }
    },
    { now: new Date("2026-10-16T07:00:00.000Z") }
  );

  assert.equal(view.kind, "one-time");
  assert.equal(view.timeZone, "America/Vancouver", "08:00Z is 01:00 in the zone the run was created in");
  assert.equal(view.nextRun, at.toISOString());
  assert.equal(view.time, null, "the placeholder 00:00 in the spec is not a time the run happens at");
});

test("the stored payload round-trips", () => {
  const { scheduler } = build();
  const input = scheduler.buildInput(Object.assign({}, PLAN, { name: "all-2300-abcdef12", scheduledTime: "2026-10-16T03:00:00.000Z" }));
  const parsed = scheduler.parseInput(input);
  assert.equal(parsed.geotab_database, "simplot_prod");
  assert.equal(parsed.schedule_name, "all-2300-abcdef12");
  assert.equal(scheduler.parseInput("not json"), null);
  assert.equal(scheduler.parseInput(""), null);
});
