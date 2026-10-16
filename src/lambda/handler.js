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
const { createConfigWriter } = require("./lib/config-writer");
const { createSecretPublisher } = require("./lib/secrets");
const { asAppError, appError } = require("./lib/errors");
const naming = require("./lib/naming");
const http = require("./http");
const auth = require("./actions/auth");
const licenseActions = require("./actions/license");
const scheduleActions = require("./actions/schedules");
const unassign = require("./actions/unassign");
const assignments = require("./actions/assignments");
const { health } = require("./actions/health");

/** Shown as "By" in the add-in's Run history (decision D7: keep the label). */
const RUNNER_NAME = "Unassign Service";

const DENIED_CODES = new Set([
  "SESSION_INVALID",
  "ADDIN_ACCESS_DENIED",
  "CLEARANCE_REQUIRED",
  "DATABASE_NOT_ONBOARDED",
  "LICENSE_REQUIRED"
]);

/**
 * Actions reachable from the add-in. `access` is the gate, strongest last:
 *   public   no session at all (health)
 *   session  a proven session, nothing else — the license check, which is what
 *            decides whether anything else is offered
 *   staff    a proven session whose email domain is an Advantage One one
 *   addin    (default) proven session + the add-in's Geotab clearance + a
 *            license for the database
 */
const ACTIONS = {
  health: { access: "public", run: (context) => health(context) },
  license: { access: "session", run: (context) => licenseActions.checkLicense(context) },
  saveWorkerCredentials: {
    access: "staff",
    run: (context, payload) => licenseActions.saveWorkerCredentials(context, payload)
  },
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
      // The option is `load` (see lib/config-store.js); naming it anything else
      // makes every config read fail with "options.load is not a function",
      // which is a 500 for the whole add-in.
      load: overrides.loadConfig || require("./aws").createConfigLoader({ bucket: env.configBucket, key: env.configKey, region: env.region }),
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
  const configReadWrite =
    overrides.configReadWrite ||
    require("./aws").createConfigReadWrite({ bucket: env.configBucket, key: env.configKey, region: env.region });
  const configWriter =
    overrides.configWriter ||
    createConfigWriter({ read: () => configReadWrite.read(), write: (text, etag) => configReadWrite.write(text, etag) });
  const secretPublisher =
    overrides.secretPublisher ||
    createSecretPublisher({ client: overrides.secretWriteClient || require("./aws").createSecretPublisherAdapter() });

  return {
    env,
    logger,
    configStore,
    secretStore,
    configWriter,
    secretPublisher,
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
    if (definition.access === "public") {
      const data = await definition.run({ env: deps.env, configStore: deps.configStore, now: deps.now, logger, requestId });
      return http.ok(data, { requestId, action, origin, allowedOrigins });
    }

    // "session" (the license check) and "staff" (setup) trust nothing about the
    // caller beyond a proven session and its email domain, so they work for
    // databases that are not onboarded yet.
    if (definition.access === "session" || definition.access === "staff") {
      const session = auth.requireSession(body.session);
      const config = await deps.configStore.get();
      const customer = (config.customers && config.customers[session.database]) || null;
      const server = resolveServer(session, customer);
      const geotab = deps.geotabFor(server);
      await auth.proveSession({ session, geotab, logger });

      const context = {
        env: deps.env,
        logger: logger.child({ database: session.database, userName: session.userName }),
        now: deps.now,
        requestId,
        session,
        config,
        customer,
        server,
        geotabFor: deps.geotabFor,
        configStore: deps.configStore,
        secretStore: deps.secretStore,
        configWriter: deps.configWriter,
        secretPublisher: deps.secretPublisher
      };
      const data = await definition.run(context, body.payload || {});
      logger.info("action completed", {
        outcome: "ok",
        database: session.database,
        code: "OK",
        staff: Boolean(data && data.staff)
      });
      return http.ok(data, { requestId, action, origin, allowedOrigins });
    }

    const session = auth.requireSession(body.session);
    const { config, customer } = await deps.configStore.getCustomer(session.database);
    const server = resolveServer(session, customer);
    const geotab = deps.geotabFor(server);
    const caller = await auth.authorize({ session, config, geotab, logger });
    const license = licenseActions.assertLicensed({ session, config, logger });
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
      scheduler: deps.scheduler,
      secretStore: deps.secretStore,
      configWriter: deps.configWriter,
      secretPublisher: deps.secretPublisher
    };
    const data = await definition.run(context, body.payload || {});
    logger.info("action completed", { outcome: "ok", database: session.database, code: "OK", licensed: license.licensed });
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

  // The configuration is the gate: a schedule that fires for a database this
  // deployment knows nothing about is a misconfiguration (a leftover schedule
  // after an offboarding, say), so it fails loudly — the invocation is retried,
  // then parked in the DLQ, and the alarm fires. Silently succeeding would hide
  // it for as long as the schedule exists.
  const config = await deps.configStore.get();
  const customer = (config.customers && config.customers[database]) || null;
  if (!customer) {
    logger.error("scheduled run for an unconfigured database", null, { outcome: "failed", code: "DATABASE_NOT_ONBOARDED" });
    throw appError(
      "DATABASE_NOT_ONBOARDED",
      `A schedule fired for "${database}", which has no configuration in this deployment.`
    );
  }
  if (customer.enabled !== true) {
    // Disabling a tenant is a deliberate operator action, so it stays quiet: no
    // retry, no DLQ entry, no alarm for a decision someone made on purpose.
    logger.warn("scheduler invocation skipped", { outcome: "disabled", code: "DATABASE_NOT_ONBOARDED", reason: "the customer is disabled" });
    return { statusCode: 200, body: JSON.stringify({ skipped: "DATABASE_NOT_ONBOARDED", message: "Customer is disabled." }) };
  }

  // A secret that cannot be read, or whose credentials MyGeotab rejects, fails
  // the invocation the same way: the run does not happen and someone is told.
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
    const app = asAppError(error);
    logger.error("scheduled run failed", error, {
      outcome: "failed",
      code: app.code,
      reason: app.message,
      database
    });
    throw error;
  }
}

/** Testable entry point: same behaviour as the exported handler, with deps injected. */
async function handleEvent(event, context, deps) {
  const requestId = (context && (context.awsRequestId || context.requestId)) || "local";
  const parsed = http.parseEvent(event);
  const body = parsed.body || {};
  const session = body.session || null;

  // One line per invocation, before anything else happens, so the log always
  // shows what arrived even when the request never gets further. Payload
  // contents are never logged: `saveWorkerCredentials` carries a password.
  deps.logger.info("event received", {
    eventType: parsed.kind,
    action: body.action || (parsed.kind === "scheduler" ? "unassign" : null),
    method: parsed.method,
    origin: parsed.origin || null,
    hasSession: Boolean(session),
    userName: session ? session.userName : null,
    database: session ? session.database : body.geotab_database || null,
    requestId
  });

  if (parsed.kind === "scheduler") {
    return handleScheduled(parsed.payload, deps, requestId);
  }

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

  // A direct invoke (the deploy script's health smoke test, a manual check) is
  // handled like a request without an Origin header. It still needs a session
  // for anything that is not public, and only IAM principals can invoke it.
  return handleHttp(parsed, deps, requestId);
}

async function handler(event, context) {
  return handleEvent(event, context, buildDeps({}));
}

module.exports = { handler, handleEvent, buildDeps, ACTIONS, RUNNER_NAME, resolveServer, scopeOf };
