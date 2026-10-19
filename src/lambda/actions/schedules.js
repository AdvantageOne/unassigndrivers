/*
 * Scheduled Driver Unassign - schedule actions
 * AdvantageOne
 *
 * The five actions the add-in can call. Every one of them is scoped to the
 * caller's own Geotab database (`session.database`), which is also the
 * EventBridge schedule group, so a caller can never read or change another
 * tenant's schedules.
 *
 *   listSchedules   read
 *   createSchedule  write — upsert, name derived from the plan
 *   updateSchedule  write — same, with an explicit existing name
 *   addRun          write — one-time at() schedule that deletes itself
 *   deleteSchedule  write — idempotent
 */
"use strict";

const core = require("../../core/unassign-core");
const { appError } = require("../lib/errors");
const naming = require("../lib/naming");

function requireString(payload, field) {
  const value = payload && payload[field];
  if (typeof value !== "string" || !value.trim()) {
    throw appError("BAD_REQUEST", `"${field}" is required.`);
  }
  return value.trim();
}

function resolveScope(payload) {
  return { groupIds: naming.normaliseScope(payload && payload.scope) };
}

function resolveTimeZone(payload, customer) {
  const timeZone = (payload && payload.timeZone) || (customer && customer.timeZone);
  if (!timeZone) throw appError("BAD_REQUEST", "A time zone is required (the customer has no default).");
  return naming.assertTimeZone(timeZone);
}

function resolveSkipDriving(payload, config) {
  if (payload && typeof payload.skipDriving === "boolean") return payload.skipDriving;
  const fallback = config && config.defaults ? config.defaults.skipDriving : true;
  return fallback !== false;
}

function describePlan(scope, spec, skipDriving) {
  const where = scope.groupIds.length ? `groups ${scope.groupIds.join(", ")}` : "all assets";
  const when =
    spec.mode === "daily"
      ? `daily ${spec.time} ${spec.timeZone}`
      : `weekly ${spec.time} ${spec.timeZone} (${spec.days.join(",")})`;
  return `${when} for ${where}${skipDriving ? "" : ", including assets that are driving"}`;
}

/** Shared by create/update/addRun: a validated plan for one tenant database. */
function buildPlan(context, payload, options) {
  const database = context.session.database;
  const scope = resolveScope(payload);
  const skipDriving = resolveSkipDriving(payload, context.config);
  const timeZone = resolveTimeZone(payload, context.customer);

  if (options && options.oneTime) {
    const wall = parseWallClock(requireString(payload, "at"));
    const utc = core.zonedToUtc(wall.y, wall.m, wall.d, wall.hh, wall.mm, timeZone);
    if (utc.getTime() < context.now().getTime() + 60000) {
      throw appError("BAD_REQUEST", "Pick a run time at least a minute in the future.");
    }
    const spec = { mode: "once", time: "00:00", timeZone, days: [], onceAt: utc.toISOString() };
    return { database, scope, skipDriving, spec, oneTime: true, at: utc, timeZone };
  }

  const spec = naming.buildSpec({
    mode: requireString(payload, "mode"),
    time: requireString(payload, "time"),
    timeZone,
    days: payload && payload.days
  });
  return { database, scope, skipDriving, spec, oneTime: false, timeZone };
}

/**
 * A one-time run arrives as the tenant's wall clock ("2026-10-16T08:00") with no
 * zone, so it is parsed as text and resolved through the shared core's
 * DST-correct conversion. A value carrying "Z" or an offset is rejected instead
 * of being silently reinterpreted.
 */
function parseWallClock(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value).trim());
  if (!match) {
    throw appError("BAD_REQUEST", `"${value}" must be a local date and time such as 2026-10-16T08:00.`);
  }
  return { y: +match[1], m: +match[2], d: +match[3], hh: +match[4], mm: +match[5] };
}

async function listSchedules(context) {
  const schedules = await context.scheduler.list(context.session.database);
  const now = context.now();
  return {
    database: context.session.database,
    timeZone: context.customer.timeZone || null,
    schedules: schedules.map((schedule) => context.scheduler.toView(schedule, { now }))
  };
}

async function createSchedule(context, payload) {
  const plan = buildPlan(context, payload);
  const result = await context.scheduler.upsert(
    Object.assign(plan, { description: describePlan(plan.scope, plan.spec, plan.skipDriving) })
  );
  return {
    name: result.name,
    arn: result.arn,
    created: result.created,
    nextRun: nextRunFor(plan, context.now())
  };
}

/** Next occurrence of a recurring plan, computed with the shared core. */
function nextRunFor(plan, now) {
  const next = core.nextOccurrence(
    { enabled: true, mode: plan.spec.mode, time: plan.spec.time, timeZone: plan.spec.timeZone, days: plan.spec.days, onceDate: null },
    now
  );
  return next ? next.toISOString() : null;
}

async function updateSchedule(context, payload) {
  const name = requireString(payload, "name");
  if (/^run-/.test(name)) {
    throw appError("BAD_REQUEST", "One-time runs cannot be edited. Delete it and add a new run.");
  }
  const existing = await context.scheduler.describe(context.session.database, name);
  if (!existing) throw appError("NOT_FOUND", `No schedule named "${name}" in this database.`);
  const plan = buildPlan(context, payload);
  const result = await context.scheduler.upsert(
    Object.assign(plan, {
      name,
      description: describePlan(plan.scope, plan.spec, plan.skipDriving),
      state: payload.state === "DISABLED" ? "DISABLED" : "ENABLED"
    })
  );
  return { name: result.name, arn: result.arn, created: result.created, nextRun: nextRunFor(plan, context.now()) };
}

async function addRun(context, payload) {
  const plan = buildPlan(context, payload, { oneTime: true });
  const result = await context.scheduler.upsert(
    Object.assign(plan, {
      description: `One-time run ${plan.at.toISOString()} for ${
        plan.scope.groupIds.length ? `groups ${plan.scope.groupIds.join(", ")}` : "all assets"
      }`
    })
  );
  return { name: result.name, arn: result.arn, at: plan.at.toISOString(), timeZone: plan.timeZone };
}

async function deleteSchedule(context, payload) {
  const name = requireString(payload, "name");
  const deleted = await context.scheduler.remove(context.session.database, name);
  return { name, deleted };
}

module.exports = {
  listSchedules,
  createSchedule,
  updateSchedule,
  addRun,
  deleteSchedule,
  buildPlan,
  parseWallClock,
  nextRunFor,
  resolveScope,
  resolveSkipDriving,
  resolveTimeZone,
  describePlan
};
