/*
 * Scheduled Driver Unassign - EventBridge Scheduler naming
 * AdvantageOne
 *
 * EventBridge Scheduler accepts only `[0-9a-zA-Z-_.]{1,64}` for schedule and
 * group names — no slashes, no colons. The logical path
 * `UnassignDriverSchedules/<database>/<hash>` therefore becomes:
 *   group  UnassignDriverSchedules-<dbPrefix>
 *   name   <scopeSlug>-<HHMM>-<hash8>        recurring
 *          run-<compactUtc>-<hash8>          one-time
 *
 * The name is derived from (database, scope, mode, time, timezone), which is
 * what makes duplicate schedules impossible: the same plan always maps to the
 * same name, and creating it twice is an update. See
 * docs/aws-port-implementation-prompt.md section 5.5.
 */
"use strict";

const crypto = require("node:crypto");
const { appError } = require("./errors");

const NAME_MAX_LENGTH = 64;
const NAME_PATTERN = /^[0-9a-zA-Z-_.]+$/;
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const DB_PREFIX_MAX = 40;
const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function hash8(parts) {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 8);
}

function assertValidName(name, what) {
  if (!name || name.length > NAME_MAX_LENGTH || !NAME_PATTERN.test(name)) {
    throw appError("BAD_REQUEST", `${what} "${name}" is not a valid EventBridge name (1-64 of 0-9a-zA-Z-_.).`);
  }
  return name;
}

function sanitiseSegment(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-_.]+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
}

function dbPrefix(database) {
  const cleaned = sanitiseSegment(database);
  if (!cleaned) throw appError("BAD_REQUEST", "The Geotab database name has no usable characters.");
  return cleaned.slice(0, DB_PREFIX_MAX);
}

/** `all`, or the sorted, comma-joined group ids — the identity of a scope. */
function normaliseScope(scope) {
  const ids = Array.isArray(scope) ? scope : (scope && scope.groupIds) || [];
  return Array.from(
    new Set(
      ids
        .map((id) => String(id || "").trim())
        .filter((id) => id.length > 0 && id.length <= 64)
    )
  ).sort();
}

function scopeKey(scope) {
  const ids = normaliseScope(scope);
  return ids.length ? ids.join(",") : "all";
}

function scopeSlug(key) {
  if (key === "all") return "all";
  const first = key.split(",")[0];
  return "g" + sanitiseSegment(first).slice(0, 8);
}

function assertTime(time) {
  const match = TIME_PATTERN.exec(String(time || ""));
  if (!match) throw appError("BAD_REQUEST", `Time must be HH:MM (got "${time}").`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch (error) {
    throw appError("BAD_REQUEST", `Unknown time zone "${timeZone}".`);
  }
  if (String(timeZone).length > 50) throw appError("BAD_REQUEST", "The time zone name is too long for EventBridge Scheduler.");
  return timeZone;
}

function assertDays(days) {
  const list = Array.isArray(days) ? days : [];
  const parsed = list.map((day) => Number(day));
  if (!parsed.length) throw appError("BAD_REQUEST", "Pick at least one day for a weekly schedule.");
  const unique = Array.from(new Set(parsed)).sort((a, b) => a - b);
  for (const day of unique) {
    if (!Number.isInteger(day) || day < 0 || day > 6) throw appError("BAD_REQUEST", `Invalid weekday: ${day}`);
  }
  return unique;
}

function assertMode(mode) {
  if (mode !== "daily" && mode !== "weekly") {
    throw appError("BAD_REQUEST", `mode must be "daily" or "weekly" (got "${mode}").`);
  }
  return mode;
}

function hhmm(time) {
  const { hour, minute } = assertTime(time);
  return String(hour).padStart(2, "0") + String(minute).padStart(2, "0");
}

function scheduleName(spec) {
  const key = scopeKey(spec.scope);
  const name = [scopeSlug(key), hhmm(spec.time), hash8([spec.database, key, spec.mode, spec.time, spec.timeZone])].join("-");
  return assertValidName(name, "Schedule name");
}

function compactUtc(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function runName(spec) {
  const key = scopeKey(spec.scope);
  const name = ["run", compactUtc(spec.at), hash8([spec.database, key, "once", spec.at.toISOString()])].join("-");
  return assertValidName(name, "Run name");
}

function groupName(prefix, database) {
  return assertValidName(`${prefix}-${dbPrefix(database)}`, "Schedule group name");
}

function cronExpression(spec) {
  const { hour, minute } = assertTime(spec.time);
  const mode = assertMode(spec.mode);
  if (mode === "daily") return `cron(${minute} ${hour} * * ? *)`;
  const days = assertDays(spec.days).map((day) => DAY_NAMES[day]);
  return `cron(${minute} ${hour} ? * ${days.join(",")} *)`;
}

function atExpression(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw appError("BAD_REQUEST", "The run time is not a valid date.");
  }
  return `at(${date.toISOString().replace(/\.\d{3}Z$/, "")})`;
}

/** Normalises what the add-in sends into the stored schedule spec. */
function buildSpec(input) {
  const mode = assertMode(input.mode);
  const spec = {
    mode,
    time: input.time,
    timeZone: assertTimeZone(input.timeZone),
    days: mode === "weekly" ? assertDays(input.days) : []
  };
  assertTime(spec.time);
  return spec;
}

module.exports = {
  NAME_MAX_LENGTH,
  NAME_PATTERN,
  DAY_NAMES,
  hash8,
  dbPrefix,
  scopeKey,
  scopeSlug,
  normaliseScope,
  assertValidName,
  assertTime,
  assertTimeZone,
  assertDays,
  assertMode,
  scheduleName,
  runName,
  groupName,
  cronExpression,
  atExpression,
  compactUtc,
  buildSpec,
  sanitiseSegment
};
