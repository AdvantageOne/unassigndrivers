/*
 * Logs are the alarm signal and the audit trail, so they must be parseable and
 * must never carry a credential — including one nested inside an object a
 * caller passed by accident.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLogger, redact } = require("../src/lambda/lib/logger");

function capture(options) {
  const lines = [];
  const logger = createLogger(Object.assign({ sink: (line) => lines.push(JSON.parse(line)) }, options || {}));
  return { logger, lines };
}

test("each line is JSON with a timestamp, level and message", () => {
  const { logger, lines } = capture({ now: () => new Date("2026-10-15T12:00:00.000Z") });
  logger.info("hello", { action: "health" });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].ts, "2026-10-15T12:00:00.000Z");
  assert.equal(lines[0].level, "info");
  assert.equal(lines[0].msg, "hello");
  assert.equal(lines[0].action, "health");
});

test("credentials are redacted by field name, at any depth", () => {
  assert.deepEqual(redact({ password: "hunter2", sessionId: "abc", credentials: { userName: "u" } }, 0), {
    password: "[redacted]",
    sessionId: "[redacted]",
    credentials: "[redacted]"
  });

  const { logger, lines } = capture();
  logger.info("session forwarded", {
    database: "tenant_a",
    session: { database: "tenant_a", userName: "a@b.c", sessionId: "secret-session" },
    nested: { apiKey: "123", ok: true }
  });

  const line = lines[0];
  assert.equal(line.database, "tenant_a");
  assert.equal(line.session, "[redacted]");
  assert.equal(line.nested.apiKey, "[redacted]");
  assert.equal(line.nested.ok, true);
  assert.equal(JSON.stringify(line).includes("secret-session"), false);
});

test("errors keep their message and code without a stack", () => {
  const { logger, lines } = capture();
  const error = new Error("boom");
  error.code = "GEOTAB_ERROR";
  logger.error("action failed", error, { outcome: "failed" });

  assert.equal(lines[0].error, "boom");
  assert.equal(lines[0].errorCode, "GEOTAB_ERROR");
  assert.equal(lines[0].outcome, "failed");
  assert.equal(lines[0].stack, undefined);
});

test("the level threshold suppresses quieter lines", () => {
  const { logger, lines } = capture({ level: "warn" });
  logger.debug("no");
  logger.info("no");
  logger.warn("yes");
  logger.error("yes", new Error("x"));
  assert.deepEqual(lines.map((line) => line.level), ["warn", "error"]);
});

test("child loggers carry their context", () => {
  const { logger, lines } = capture({ context: { deployment: "advone-ca-central" } });
  logger.child({ database: "tenant_a" }).info("scoped", { outcome: "ran" });

  assert.equal(lines[0].deployment, "advone-ca-central");
  assert.equal(lines[0].database, "tenant_a");
  assert.equal(lines[0].outcome, "ran");
});

test("counts survive to the top level for the metric filters", () => {
  const { logger, lines } = capture();
  logger.info("scheduled run finished", { outcome: "ran", unassigned: 3, skipped: 1, failed: 0, stillAssigned: 2 });

  assert.equal(lines[0].outcome, "ran");
  assert.equal(lines[0].unassigned, 3);
  assert.equal(lines[0].stillAssigned, 2);
});
