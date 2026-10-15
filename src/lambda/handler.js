/*
 * Scheduled Driver Unassign - Lambda entry point
 * AdvantageOne
 *
 * One function, two entry paths:
 *   HTTP      a request from the MyGeotab add-in, carrying the caller's session.
 *             Action names and payloads: docs/aws-port-implementation-prompt.md 5.3.
 *   Scheduler an EventBridge Scheduler invocation carrying `{action:"unassign",
 *             source:"scheduler", geotab_database, group_ids, ...}` (section 5.4).
 *             Treated as trusted because only the Scheduler execution role can
 *             invoke the function directly (see infra/modules/unassign).
 *
 * Failures on the scheduler path are thrown on purpose: that is what makes
 * EventBridge retry, land the payload in the DLQ, and trip the alarm.
 */
"use strict";

const { readEnv } = require("./env");
const { createLogger } = require("./lib/logger");
const { createConfigStore } = require("./lib/config-store");
const { createSecretStore } = require("./lib/secrets");
const { createGeotab, normaliseServer, toCoreApi } = require("./lib/geotab");
const { createScheduler } = require("./lib/scheduler");
const { asAppError, appError } = require("./lib/errors");
const naming = require("./lib/naming");
const http = require("./http");
const auth = require("./actions/auth");
const scheduleActions = require("./actions/schedules");
const unassign = require("./actions/unassign");
const assignments = require("./actions/assignments");
const { health } = require("./actions/health");

/** Shown as "By" in the add-in's Run history (decision D7: keep the label). */
const RUNNER_NAME = "Unassign Service";

const DENIED_CODES = new Set(["SESSION_INVALID", "ADDIN_ACCESS_DENIED", "CLEARANCE_REQUIRED", "DATABASE_NOT_ONBOARDED"]);

/** Actions reachable from the add-in. `write` only documents intent for logs. */
const ACTIONS = {
  health: { auth: false, run: (context) => health(context) },
  listSchedules: { run: (context) => scheduleActions.listSchedules(context) },
  createSchedule: { run: (context, payload) => scheduleActions.createSchedule(context, payload) },
  updateSchedule: { run: (context, payload) => scheduleActions.updateSchedule(context, payload) },
  addRun: { run: (context, payload) => scheduleActions.addRun(context, payload) },
  deleteSchedule: { run: (context, payload) => scheduleActions.deleteSchedule(context, payload) },
  listAssignments: { run: (context, payload) => assignments.listAssignments(Object.assign({}, context, { scope: scopeOf(payload, context) })) },
  unassign: {
    run: (context, payload) =>
      unassign.runUnassign(
        Object.assign({}, context, {
          scope: scopeOf(payload, context),
          skipDriving: scheduleActions.resolveSkipDriving(payload, context.config),
          dryRun: payload && payload.dryRun === true,
          trigger: "manual",
          by: context.session.userName,
          occurrence: context.now().toISOString(),
          secret: null
        })
      )
  }
};

function scopeOf(payload) {
  return { groupIds: naming.normaliseScope(payload && payload.scope) };
}

function buildDeps(options) {
  const env = options.env || readEnv();
  const overrides = options.overrides || {};
  const logger = overrides.logger || createLogger({ level: env.logLevel });
  const configStore =
    overrides.configStore ||
    createConfigStore({
      loader: overrides.loadConfig || require("./aws").createConfigLoader({ bucket: env.configBucket, key: env.configKey, region: env.region }),
      ttlMs: env.configCacheMs,
      logger
    });
  const secretStore =
    overrides.secretStore ||
    createSecretStore({
      fetchSecret: overrides.fetchSecret || require("./aws").createSecretFetcher(),
      ttlMs: env.secretCacheMs
    });
  const geotabCache = new Map();
  const geotabFor =
    overrides.geotabFor ||
    ((server) => {
      const host = normaliseServer(server);
      if (!geotabCache.has(host)) geotabCache.set(host, createGeotab({ server: host, logger }));
      return geotabCache.get(host);
    });
  const scheduler =
    overrides.scheduler ||
    createScheduler({
      client: overrides.schedulerClient || require("./aws").createSchedulerAdapter({ region: env.region }),
      groupPrefix: env.scheduleGroupPrefix,
      targetArn: env.targetFunctionArn,
      roleArn: env.schedulerRoleArn,
      dlqArn: env.schedulerDlqArn,
      retry: { maxAttempts: env.schedulerRetryMaxAttempts, maxAgeSeconds: env.schedulerRetryMaxAgeSeconds }
    });
  return {
    env,
    logger,
    configStore,
    secretStore,
    geotabFor,
    scheduler,
    now: overrides.now || (() => new Date())
  };
}

function resolveServer(session, customer) {
  return (session && session.server) || (customer && customer.geotab && customer.geotab.server) || "my.geotab.com";
}

async function handleHttp(request, deps, requestId) {
  const origin = request.origin;
  const allowedOrigins = deps.env.allowedOrigins;

  if (!http.isOriginAllowed(origin, allowedOrigins)) {
    deps.logger.warn("rejected request from a disallowed origin", { outcome: "denied", action: "unknown", origin });
    return http.failure(appError("ADDIN_ACCESS_DENIED", "This add-in deployment does not accept requests from that origin."), {
      requestId,
      origin,
      allowedOrigins
    });
  }

  const body = request.body || {};
  const action = body.action;
  const definition = ACTIONS[action];
  const logger = deps.logger.child({ action: action || "unknown", requestId });

  if (!definition) {
    return http.failure(appError("BAD_REQUEST", `Unknown action "${action}".`), { requestId, origin, allowedOrigins });
  }

  try {
    if (definition.auth === false) {
      const data = await definition.run({ env: deps.env, configStore: deps.configStore, now: deps.now, logger, requestId });
      return http.ok(data, { requestId, action, origin, allowedOrigins });
    }

    const session = auth.requireSession(body.session);
    const { config, customer } = await deps.configStore.getCustomer(session.database);
    const server = resolveServer(session, customer);
    const geotab = deps.geotabFor(server);
    const caller = await auth.authorize({ session, config, geotab, logger });
    const sessionClient = geotab.session({
      database: session.database,
      userName: session.userName,
      sessionId: session.sessionId
    });

    const context = {
      env: deps.env,
      logger: logger.child({ database: session.database, userName: caller.userName }),
      now: deps.now,
      requestId,
      session,
      customer,
      config,
      server,
      caller,
      api: toCoreApi(sessionClient),
      geotabFor: deps.geotabFor,
      scheduler: deps.scheduler
    };
    const data = await definition.run(context, body.payload || {});
    logger.info("action completed", { outcome: "ok", database: session.database, code: "OK" });
    return http.ok(data, { requestId, action, origin, allowedOrigins });
  } catch (error) {
    const app = asAppError(error);
    const outcome = DENIED_CODES.has(app.code) ? "denied" : "failed";
    logger.warn("action failed", { outcome, database: (body.session && body.session.database) || null, code: app.code, reason: app.message });
    return http.failure(app, { requestId, origin, allowedOrigins });
  }
}

async function handleScheduled(payload, deps, requestId) {
  if (!payload || payload.action !== "unassign" || payload.source !== "scheduler") {
    throw appError("BAD_REQUEST", "Unrecognized scheduler payload.");
  }
  const database = payload.geotab_database;
  const logger = deps.logger.child({ action: "scheduler", database: database || "unknown", requestId });
  if (!database) throw appError("BAD_REQUEST", "The schedule payload has no geotab_database.");

  let customer;
  try {
    const found = await deps.configStore.getCustomer(database);
    customer = found.customer;
  } catch (error) {
    // A disabled or unknown tenant is not a transient failure: log it, tell the
    // Scheduler it succeeded, and let the "denied" metric carry the signal.
    const app = asAppError(error);
    logger.warn("scheduler invocation skipped", { outcome: "disabled", code: app.code, reason: app.message });
    return { statusCode: 200, body: JSON.stringify({ skipped: app.code, message: app.message }) };
  }

  const secret = await deps.secretStore.get(customer.secretName, database);
  if (payload.schedule_name) {
    const described = await deps.scheduler.describe(database, payload.schedule_name);
    if (!described) {
      logger.warn("scheduled run for a schedule that no longer exists", { outcome: "idle", schedule: payload.schedule_name });
      return { statusCode: 200, body: JSON.stringify({ skipped: "NOT_FOUND", message: "Schedule no longer exists." }) };
    }
  }

  try {
    const result = await unassign.runUnassign({
      env: deps.env,
      logger,
      now: deps.now,
      geotabFor: deps.geotabFor,
      secret,
      server: secret.server,
      scope: { groupIds: naming.normaliseScope(payload.group_ids) },
      skipDriving: payload.skip_driving !== false,
      trigger: "scheduled",
      by: RUNNER_NAME,
      occurrence: payload.scheduled_time || deps.now().toISOString(),
      invocationId: requestId
    });
    const outcome = result.skippedReason ? "idle" : result.dryRun ? "checked" : result.failed ? "failed" : "ran";
    logger.info("scheduled run finished", {
      outcome,
      reason: result.skippedReason,
      unassigned: result.unassigned,
      skipped: result.skipped,
      failed: result.failed,
      stillAssigned: result.stillAssigned,
      schedule: payload.schedule_name || null
    });
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (error) {
    logger.error("scheduled run failed", error, { outcome: "failed" });
    throw error;
  }
}

/** Testable entry point: same behaviour as the exported handler, with deps injected. */
async function handleEvent(event, context, deps) {
  const requestId = (context && (context.awsRequestId || context.requestId)) || "local";
  const parsed = http.parseEvent(event);
  if (parsed.kind === "http") {
    if (parsed.method === "OPTIONS") return http.preflight(parsed.origin, deps.env.allowedOrigins);
    if (parsed.method !== "POST") {
      return http.failure(appError("BAD_REQUEST", `Use POST (got ${parsed.method}).`), {
        requestId,
        origin: parsed.origin,
        allowedOrigins: deps.env.allowedOrigins
      });
    }
    return handleHttp(parsed, deps, requestId);
  }
  return handleScheduled(parsed.payload, deps, requestId);
}

async function handler(event, context) {
  return handleEvent(event, context, buildDeps({}));
}

module.exports = { handler, handleEvent, buildDeps, ACTIONS, RUNNER_NAME, resolveServer, scopeOf };
