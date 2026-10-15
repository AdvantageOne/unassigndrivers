/*
 * Scheduled Driver Unassign - EventBridge Scheduler wrapper
 * AdvantageOne
 *
 * Owns the schedule lifecycle for one tenant database:
 *   group "UnassignDriverSchedules-<dbPrefix>" per database
 *   schedule "<scopeSlug>-<HHMM>-<hash8>"  recurring (daily / weekly)
 *   schedule "run-<compactUtc>-<hash8>"    one-time, deleted after it fires
 *
 * The target payload names exactly one Geotab database; the worker reads the
 * rest of the plan from the payload itself, so no state lives outside
 * EventBridge (plus the tenant's own Geotab run log).
 *
 * The `client` option is a thin adapter (see src/lambda/aws.js) so tests can
 * drive this module without the AWS SDK.
 */
"use strict";

const { appError } = require("./errors");
const naming = require("./naming");
const core = require("../../core/unassign-core");

const CONFLICT = "ConflictException";
const NOT_FOUND = "ResourceNotFoundException";
const MAX_LISTED_SCHEDULES = 200;

function errorName(error) {
  return (error && (error.name || error.code)) || "";
}

/** Converts the stored schedule spec back into the shape the shared core understands. */
function toCoreSchedule(spec) {
  return {
    enabled: true,
    mode: spec.mode,
    time: spec.time,
    timeZone: spec.timeZone,
    days: spec.days || [],
    onceDate: spec.onceAt ? String(spec.onceAt).slice(0, 10) : null,
    graceMinutes: spec.graceMinutes == null ? 15 : spec.graceMinutes
  };
}

/**
 * Accepts either shape a caller may hand over — top-level `{mode,time,timeZone,days}`
 * or a nested `spec` — and returns one canonical plan. The stored payload is
 * always built from the canonical fields, so a schedule created from the add-in
 * and one created from a script describe themselves identically.
 */
function normalisePlan(plan) {
  const spec = plan.spec || {};
  const timeZone = spec.timeZone || plan.timeZone;
  const normalised = Object.assign({}, plan, {
    mode: spec.mode || plan.mode,
    time: spec.time || plan.time,
    timeZone,
    days: spec.days || plan.days || []
  });
  normalised.spec = {
    mode: normalised.mode,
    time: normalised.time,
    timeZone,
    days: normalised.days,
    onceAt: plan.oneTime && plan.at ? plan.at.toISOString() : spec.onceAt || null
  };
  return normalised;
}

function createScheduler(options) {
  const client = options.client;
  const groupPrefix = options.groupPrefix;
  const targetArn = options.targetArn;
  const roleArn = options.roleArn;
  const dlqArn = options.dlqArn || "";
  const retry = options.retry || { maxAttempts: 2, maxAgeSeconds: 3600 };
  const flexibleWindowMode = options.flexibleWindowMode || "OFF";

  function buildInput(plan) {
    return JSON.stringify({
      action: "unassign",
      source: "scheduler",
      geotab_database: plan.database,
      group_ids: naming.normaliseScope(plan.scope),
      skip_driving: plan.skipDriving !== false,
      schedule_name: plan.name,
      scheduled_time: plan.scheduledTime || null,
      spec: {
        mode: plan.spec.mode,
        time: plan.spec.time,
        timeZone: plan.spec.timeZone,
        days: plan.spec.days || [],
        onceAt: plan.spec.onceAt || null
      }
    });
  }

  function parseInput(input) {
    if (!input) return null;
    try {
      const parsed = JSON.parse(input);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  function scheduleInput(plan) {
    if (!targetArn || !roleArn) {
      throw appError("INTERNAL", "This deployment has no schedule target configured (TARGET_FUNCTION_ARN / SCHEDULER_ROLE_ARN).");
    }
    const expression = plan.expression || (plan.oneTime ? naming.atExpression(plan.at) : naming.cronExpression(plan));
    const input = {
      Name: plan.name,
      GroupName: plan.group,
      Description: plan.description,
      ScheduleExpression: expression,
      FlexibleTimeWindow: { Mode: flexibleWindowMode },
      State: plan.state || "ENABLED",
      ActionAfterCompletion: plan.oneTime ? "DELETE" : "NONE",
      // Both of these belong to Target, not to the schedule itself.
      Target: {
        Arn: targetArn,
        RoleArn: roleArn,
        Input: buildInput(plan),
        RetryPolicy: {
          MaximumEventAgeInSeconds: retry.maxAgeSeconds,
          MaximumRetryAttempts: retry.maxAttempts
        }
      }
    };
    if (dlqArn) input.Target.DeadLetterConfig = { Arn: dlqArn };
    // A one-time run is already converted to UTC by the caller, so setting a
    // time zone would make EventBridge reinterpret the instant in local time.
    if (plan.timeZone && !plan.oneTime) input.ScheduleExpressionTimezone = plan.timeZone;
    return input;
  }

  async function ensureGroup(database) {
    const group = naming.groupName(groupPrefix, database);
    try {
      await client.createScheduleGroup({ Name: group });
    } catch (error) {
      if (errorName(error) !== CONFLICT) throw error;
    }
    return group;
  }

  /**
   * Creates or replaces a schedule. The name is derived from the plan, so the
   * same plan created twice updates one schedule instead of adding a second.
   */
  async function upsert(rawPlan) {
    const plan = normalisePlan(rawPlan);
    const group = await ensureGroup(plan.database);
    const name = plan.name || (plan.oneTime ? naming.runName(plan) : naming.scheduleName(plan));
    const full = Object.assign({}, plan, { group, name });
    const input = scheduleInput(full);
    try {
      const created = await client.createSchedule(input);
      return { name, group, arn: created && created.ScheduleArn, created: true, input };
    } catch (error) {
      if (errorName(error) !== CONFLICT) throw error;
    }
    const updated = await client.updateSchedule(input);
    return { name, group, arn: updated && updated.ScheduleArn, created: false, input };
  }

  async function describe(database, name) {
    const group = naming.groupName(groupPrefix, database);
    try {
      const schedule = await client.getSchedule({ Name: name, GroupName: group });
      return Object.assign({ group }, schedule);
    } catch (error) {
      if (errorName(error) === NOT_FOUND) return null;
      throw error;
    }
  }

  async function list(database) {
    const group = naming.groupName(groupPrefix, database);
    let token;
    const names = [];
    do {
      let page;
      try {
        page = await client.listSchedules({ GroupName: group, NextToken: token, MaxResults: 100 });
      } catch (error) {
        if (errorName(error) === NOT_FOUND) return [];
        throw error;
      }
      for (const entry of page.Schedules || []) names.push(entry.Name);
      token = page.NextToken;
    } while (token && names.length < MAX_LISTED_SCHEDULES);

    const out = [];
    for (const name of names.slice(0, MAX_LISTED_SCHEDULES)) {
      const schedule = await describe(database, name);
      if (schedule) out.push(schedule);
    }
    return out;
  }

  async function remove(database, name) {
    const group = naming.groupName(groupPrefix, database);
    try {
      await client.deleteSchedule({ Name: name, GroupName: group });
      return true;
    } catch (error) {
      if (errorName(error) === NOT_FOUND) return false;
      throw error;
    }
  }

  /** The shape the add-in renders: what the plan is and when it runs next. */
  function toView(schedule, options_) {
    const now = (options_ && options_.now) || new Date();
    const payload = parseInput(schedule.Target && schedule.Target.Input) || {};
    const spec = payload.spec || {};
    const oneTime = /^run-/.test(schedule.Name || "");
    let nextRun = null;
    if (oneTime) {
      const at = schedule.ScheduleExpression && /^at\((.+)\)$/.exec(schedule.ScheduleExpression);
      if (at) {
        const parsed = new Date(at[1].endsWith("Z") ? at[1] : at[1] + "Z");
        if (!Number.isNaN(parsed.getTime()) && parsed > now) nextRun = parsed.toISOString();
      }
    } else {
      const next = core.nextOccurrence(toCoreSchedule(spec), now);
      nextRun = next ? next.toISOString() : null;
    }
    return {
      name: schedule.Name,
      arn: schedule.Arn || null,
      group: schedule.GroupName || schedule.group || null,
      state: schedule.State || "ENABLED",
      expression: schedule.ScheduleExpression || null,
      timeZone: schedule.ScheduleExpressionTimezone || spec.timeZone || null,
      kind: oneTime ? "one-time" : "recurring",
      scope: { groupIds: payload.group_ids || [] },
      mode: spec.mode || null,
      time: spec.time || null,
      days: spec.days || [],
      skipDriving: payload.skip_driving !== false,
      nextRun,
      description: schedule.Description || null
    };
  }

  return { ensureGroup, upsert, describe, list, remove, toView, buildInput, parseInput, toCoreSchedule };
}

module.exports = { createScheduler, toCoreSchedule, normalisePlan, MAX_LISTED_SCHEDULES };
