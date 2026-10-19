/*
 * Scheduled Driver Unassign - structured logging
 * AdvantageOne
 *
 * One JSON object per line, because CloudWatch metric filters read these
 * fields (see infra/modules/unassign). Field names that matter to alarms:
 *   outcome   ran | idle | failed | denied | missed | disabled | checked
 *   action    the API action or "scheduler"
 *   database  the tenant key
 *   failed, stillAssigned, unassigned, skipped   integer counts
 *
 * Credentials are never logged. Redaction is applied to field values by key
 * name, so a careless caller cannot leak a session through `logger.info`.
 */
"use strict";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /password|passphrase|secret|session|credential|authorization|token|api[-_]?key/i;

const MAX_DEPTH = 6;

function redact(value, depth) {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    // A sensitive-looking key with a boolean or a number cannot be carrying a
    // credential, and those flags are exactly what an operator needs to read
    // (`hasSession: false` says the add-in never sent one).
    const scalar = typeof item === "boolean" || typeof item === "number" || item === null;
    out[key] = SECRET_KEY.test(key) && !scalar ? "[redacted]" : redact(item, depth + 1);
  }
  return out;
}

function createLogger(options) {
  const options_ = options || {};
  const threshold = LEVELS[options_.level] || LEVELS.info;
  const base = options_.context ? redact(options_.context, 0) : {};
  const sink = options_.sink || ((line) => process.stdout.write(line + "\n"));
  const now = options_.now || (() => new Date());

  function emit(level, message, fields) {
    if (LEVELS[level] < threshold) return;
    const line = Object.assign({ ts: now().toISOString(), level, msg: String(message) }, base, redact(fields || {}, 0));
    sink(JSON.stringify(line));
  }

  function describeError(error) {
    if (!error) return {};
    return {
      error: error.message ? error.message : String(error),
      errorName: error.name || "Error",
      errorCode: error.code || undefined
    };
  }

  return {
    level: options_.level || "info",
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, error, fields) => emit("error", message, Object.assign({}, describeError(error), fields || {})),
    child: (extra) => createLogger(Object.assign({}, options_, { context: Object.assign({}, base, extra) }))
  };
}

module.exports = { createLogger, redact };
