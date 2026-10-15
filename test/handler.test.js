/*
 * The handler is the router between a browser request and an EventBridge
 * invocation. These tests pin the envelope, the authorization gate, the origin
 * check, and the deliberate difference in failure behaviour between the two
 * paths: an HTTP failure is an answer, a scheduler failure throws so that
 * EventBridge retries and the DLQ alarm fires.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDeps, handleEvent } = require("../src/lambda/handler");
const { readEnv } = require("../src/lambda/env");
const { createLogger } = require("../src/lambda/lib/logger");
const { createConfigStore } = require("../src/lambda/lib/config-store");
const { createSecretStore } = require("../src/lambda/lib/secrets");
const { createScheduler } = require("../src/lambda/lib/scheduler");
const { createCoreApi, createFakeConfig, createFakeSchedulerClient } = require("./support/fakes");

const ORIGIN = "https://my.geotab.com";

/** Two assets with a real driver; b1 is driving. */
const CORE = {
  devices: [
    { id: "b1", name: "Truck 1" },
    { id: "b2", name: "Truck 2" }
  ],
  statuses: [{ device: { id: "b1" }, isDriving: true }],
  changes: {
    b1: [{ device: { id: "b1" }, driver: { id: "drv1" }, dateTime: "2026-10-01T10:00:00.000Z", type: "Driver" }],
    b2: [{ device: { id: "b2" }, driver: { id: "drv2" }, dateTime: "2026-10-01T11:00:00.000Z", type: "Driver" }]
  },
  users: { drv1: { id: "drv1", firstName: "Dan", lastName: "River" }, drv2: { id: "drv2", firstName: "Ann", lastName: "Other" } }
};
const ADDIN_ID = "aTestAddInSecurityId";
const PAGE = "Scheduled Driver Unassign";
const EVERYTHING = {
  id: "GroupEverythingSecurityId",
  securityFilters: [{ isAdd: true, securityId: { id: "SecurityIdEverythingId", name: "SecurityIdEverythingId", customPageName: "undefined" } }]
};
const GRANT = {
  id: "b200",
  securityFilters: [{ isAdd: true, securityId: { id: ADDIN_ID, name: "ViewSecurityId", customPageName: PAGE, isSystemSecurityId: true } }]
};
const CATALOG = {
  id: "GroupSecurityId",
  securityFilters: [{ isAdd: true, securityId: { id: ADDIN_ID, name: "ViewSecurityId", customPageName: PAGE } }]
};

function harness(options) {
  const settings = options || {};
  const state = createCoreApi(settings.coreOptions || {});
  const schedulerClient = createFakeSchedulerClient();
  const lines = [];
  const config = settings.config || createFakeConfig({});
  const groupsById = settings.groupsById || { GroupEverythingSecurityId: EVERYTHING, b200: GRANT, GroupSecurityId: CATALOG };

  const deps = buildDeps({
    env: readEnv({
      CONFIG_BUCKET: "advone-ca-central-config",
      DEPLOYMENT_NAME: "advone-ca-central",
      AWS_REGION: "ca-central-1",
      ALLOWED_ORIGINS: ORIGIN,
      SCHEDULE_GROUP_PREFIX: "UnassignDriverSchedules",
      TARGET_FUNCTION_ARN: "arn:aws:lambda:ca-central-1:000000000000:function:advone-unassign-api",
      SCHEDULER_ROLE_ARN: "arn:aws:iam::000000000000:role/advone-unassign-scheduler",
      SCHEDULER_DLQ_ARN: "arn:aws:sqs:ca-central-1:000000000000:advone-unassign-dlq",
      SERVICE_VERSION: "test"
    }),
    overrides: {
      logger: createLogger({ level: "debug", sink: (line) => lines.push(JSON.parse(line)) }),
      configStore: createConfigStore({ load: async () => JSON.stringify(config), ttlMs: 0 }),
      secretStore: createSecretStore({
        fetchSecret:
          settings.fetchSecret ||
          (async (name) => JSON.stringify({ database: name.split("/")[1], server: "my.geotab.test", userName: "svc-unassign", password: "p" })),
        ttlMs: 0
      }),
      scheduler: createScheduler({
        client: schedulerClient,
        groupPrefix: "UnassignDriverSchedules",
        targetArn: "arn:aws:lambda:ca-central-1:000000000000:function:advone-unassign-api",
        roleArn: "arn:aws:iam::000000000000:role/advone-unassign-scheduler",
        dlqArn: ""
      }),
      geotabFor: settings.geotabFor || (() => geotabFor(state, settings)),
      configWriter: settings.configWriter || fakeConfigWriter(config),
      secretPublisher: settings.secretPublisher || fakeSecretPublisher(),
      now: () => new Date("2026-10-15T00:00:00.000Z")
    }
  });

  return {
    deps,
    state,
    lines,
    schedulerClient,
    config,
    context: { awsRequestId: "req-abc" },
    configWriter: deps.configWriter,
    secretPublisher: deps.secretPublisher
  };
}

/** In-memory stand-in for the ETag-guarded S3 writer. */
function fakeConfigWriter(config) {
  let stored = JSON.stringify(config);
  return {
    writes: [],
    async mutate(mutator) {
      const next = await mutator(JSON.parse(stored));
      if (!next) return { unchanged: true, attempts: 1 };
      stored = JSON.stringify(next);
      this.writes.push(next);
      return { config: next, attempts: 1 };
    },
    stored: () => JSON.parse(stored)
  };
}

/** In-memory stand-in for Secrets Manager. */
function fakeSecretPublisher() {
  const secrets = [];
  return {
    secrets,
    async put(name, payload) {
      const created = !secrets.some((secret) => secret.name === name);
      secrets.push({ name, payload });
      return { name, created };
    }
  };
}

/** One geotab double that answers both the clearance calls and the core's calls. */
function geotabFor(state, settings) {
  const { api } = state;
  const promiseCall = (method, params) => new Promise((ok, err) => api.call(method, params, ok, err));
  const users = settings.users || [
    { id: "u1", name: "admin@example.com", securityGroups: settings.securityGroups || [{ id: "GroupEverythingSecurityId" }] }
  ];
  const groupsById = settings.groupsById || { GroupEverythingSecurityId: EVERYTHING, b200: GRANT, GroupSecurityId: CATALOG };
  const call = async (method, params) => {
    if (method === "Get" && params.typeName === "User") return users;
    if (method === "Get" && params.typeName === "Group") return groupsById[params.search.id] ? [groupsById[params.search.id]] : [];
    if (settings.call) return settings.call(method, params);
    return promiseCall(method, params);
  };
  const multiCall = async (calls) => {
    const out = [];
    for (const entry of calls) {
      const [method, params] = Array.isArray(entry) ? entry : [entry.method, entry.params];
      out.push(await call(method, params));
    }
    return out;
  };
  return {
    server: "my.geotab.test",
    authenticate: async (account) => ({ database: account.database, userName: account.userName, sessionId: "svc-session" }),
    session: (credentials) => ({
      credentials,
      database: credentials.database,
      userName: credentials.userName,
      server: "my.geotab.test",
      call,
      multiCall,
      multiCallChunked: multiCall
    })
  };
}

function httpEvent(action, options) {
  const settings = options || {};
  const payload = { action };
  if (settings.session !== null) {
    payload.session = settings.session || { database: "tenant_a", userName: "admin@example.com", sessionId: "session-1", server: "my.geotab.test" };
  }
  if (settings.payload) payload.payload = settings.payload;
  return {
    version: "2.0",
    requestContext: { http: { method: settings.method || "POST", sourceIp: "203.0.113.1" } },
    headers: settings.origin === null ? {} : { origin: settings.origin || ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(payload),
    isBase64Encoded: false
  };
}

function scheduledEvent(overrides) {
  return Object.assign(
    {
      action: "unassign",
      source: "scheduler",
      geotab_database: "tenant_a",
      group_ids: [],
      skip_driving: true,
      schedule_name: null,
      scheduled_time: "2026-10-15T00:00:00.000Z"
    },
    overrides || {}
  );
}

function body(response) {
  return JSON.parse(response.body);
}

function outcomes(lines) {
  return lines.filter((line) => line.outcome).map((line) => line.outcome);
}

test("a preflight from the allowed origin is answered, without CORS headers", async () => {
  const { deps, context } = harness();
  const response = await handleEvent(httpEvent("listSchedules", { method: "OPTIONS" }), context, deps);
  assert.equal(response.statusCode, 204);
  // CORS headers are the function URL's job: emitting them here as well makes
  // Lambda return duplicates and the browser reject the response.
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(response.headers["content-type"], "application/json");
});

test("no response carries CORS headers", async () => {
  const { deps, context } = harness();
  for (const event of [
    httpEvent("health", { session: null }),
    httpEvent("listSchedules"),
    httpEvent("listSchedules", { origin: "https://evil.example.com" })
  ]) {
    const response = await handleEvent(event, context, deps);
    const headers = Object.keys(response.headers).join(",");
    assert.equal(/access-control/i.test(headers), false, `unexpected CORS header in: ${headers}`);
  }
});

test("a request from another origin is refused before any work", async () => {
  const { deps, context, lines } = harness();
  const response = await handleEvent(httpEvent("listSchedules", { origin: "https://evil.example.com" }), context, deps);
  assert.equal(response.statusCode, 403);
  assert.equal(body(response).error.code, "ADDIN_ACCESS_DENIED");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(outcomes(lines), ["denied"]);
});

test("only POST is accepted", async () => {
  const { deps, context } = harness();
  const response = await handleEvent(httpEvent("health", { method: "GET" }), context, deps);
  assert.equal(response.statusCode, 400);
  assert.match(body(response).error.message, /Use POST/);
});

test("health works without a session and never lists customers", async () => {
  const { deps, context } = harness();
  const response = await handleEvent(httpEvent("health", { session: null }), context, deps);
  const payload = body(response);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.status, "ok");
  assert.equal(payload.data.customers.total, 1);
  assert.equal(payload.data.addIn.securityIdConfigured, true);
  assert.equal(JSON.stringify(payload).includes("tenant_a"), false, "customer keys must not leak");
  assert.equal(payload.requestId, "req-abc");
});

test("an unknown action is rejected", async () => {
  const { deps, context } = harness();
  const response = await handleEvent(httpEvent("dropEverything"), context, deps);
  assert.equal(response.statusCode, 400);
  assert.match(body(response).error.message, /Unknown action/);
});

test("an action that needs a session refuses without one", async () => {
  const { deps, context, lines } = harness();
  const response = await handleEvent(httpEvent("listSchedules", { session: null }), context, deps);
  assert.equal(response.statusCode, 401);
  assert.equal(body(response).error.code, "SESSION_INVALID");
  assert.deepEqual(outcomes(lines), ["denied"]);
});

test("a tenant that is not onboarded is refused", async () => {
  const { deps, context } = harness();
  const response = await handleEvent(
    httpEvent("listSchedules", { session: { database: "unknown_db", userName: "admin@example.com", sessionId: "s" } }),
    context,
    deps
  );
  assert.equal(response.statusCode, 403);
  assert.equal(body(response).error.code, "DATABASE_NOT_ONBOARDED");
});

test("a caller whose clearances do not include this add-in is refused", async () => {
  const { deps, context, lines } = harness({ securityGroups: [{ id: "GroupSecurityId" }] });
  const response = await handleEvent(httpEvent("listSchedules"), context, deps);
  assert.equal(response.statusCode, 403);
  assert.equal(body(response).error.code, "ADDIN_ACCESS_DENIED");
  assert.deepEqual(outcomes(lines), ["denied"]);
});

test("an authorized caller can create, list and delete schedules", async () => {
  const { deps, context, schedulerClient } = harness();
  const created = await handleEvent(
    httpEvent("createSchedule", { payload: { mode: "daily", time: "23:00", timeZone: "America/Toronto" } }),
    context,
    deps
  );
  assert.equal(created.statusCode, 200);
  const createdBody = body(created);
  assert.equal(createdBody.ok, true);
  assert.equal(createdBody.data.created, true);
  assert.equal(schedulerClient.schedules.size, 1);

  const listed = await handleEvent(httpEvent("listSchedules"), context, deps);
  const listedBody = body(listed);
  assert.equal(listedBody.data.schedules.length, 1);
  assert.equal(listedBody.data.schedules[0].name, createdBody.data.name);

  const deleted = await handleEvent(httpEvent("deleteSchedule", { payload: { name: createdBody.data.name } }), context, deps);
  assert.equal(body(deleted).data.deleted, true);
  assert.equal(schedulerClient.schedules.size, 0);
});

test("an authorized caller can run an unassign now", async () => {
  const { deps, context, state } = harness({ coreOptions: CORE });
  const response = await handleEvent(httpEvent("unassign", { payload: { scope: { groupIds: [] }, skipDriving: false } }), context, deps);
  const payload = body(response);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.data.unassigned, 2);
  assert.equal(state.behaviour.addedChanges.length, 2);
  const log = state.state.addInData.find((record) => record.details.type === "log");
  assert.equal(log.details.entries[0].trigger, "manual");
  assert.equal(log.details.entries[0].by, "admin@example.com");
});

test("a scheduled invocation runs the same worker and logs counts", async () => {
  const { deps, context, state, lines } = harness({ coreOptions: CORE });
  const response = await handleEvent(scheduledEvent(), context, deps);

  assert.equal(response.statusCode, 200);
  const record = JSON.parse(response.body);
  assert.equal(record.unassigned, 1, "the default fixture has one driving asset, which is skipped");
  assert.equal(record.skipped, 1);
  assert.equal(state.behaviour.addedChanges.length, 1);

  const finished = lines.find((line) => line.msg === "scheduled run finished");
  assert.equal(finished.outcome, "ran");
  assert.equal(finished.database, "tenant_a");
  assert.equal(finished.unassigned, 1);
  assert.equal(finished.failed, 0);
  assert.equal(finished.stillAssigned, 0);
  assert.equal(finished.action, "scheduler");
});

test("a run with failures reports outcome failed for the alarm", async () => {
  const { deps, context, lines } = harness({
    call: (method, params) => {
      if (method === "Get" && params.typeName === "DeviceStatusInfo") throw new Error("InvalidUserException: nope");
      throw new Error(`unexpected ${method}`);
    }
  });
  await assert.rejects(() => handleEvent(scheduledEvent(), context, deps));
  assert.equal(lines[lines.length - 1].outcome, "failed");
  assert.equal(lines[lines.length - 1].level, "error");
});

test("a disabled tenant is skipped without a retry", async () => {
  const config = createFakeConfig({});
  config.customers.tenant_a.enabled = false;
  const { deps, context, lines } = harness({ config });
  const response = await handleEvent(scheduledEvent(), context, deps);

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).skipped, "DATABASE_NOT_ONBOARDED");
  assert.deepEqual(outcomes(lines), ["disabled"]);
});

test("an unknown database is skipped without making anything retry", async () => {
  const { deps, context } = harness();
  const response = await handleEvent(scheduledEvent({ geotab_database: "who_is_this" }), context, deps);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).skipped, "DATABASE_NOT_ONBOARDED");
});

test("a schedule that was deleted before it fired is skipped", async () => {
  const { deps, context, state } = harness();
  const response = await handleEvent(scheduledEvent({ schedule_name: "all-2300-deadbeef" }), context, deps);

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).skipped, "NOT_FOUND");
  assert.equal(state.behaviour.addedChanges.length, 0);
});

/* ---------------- licensing ---------------- */

const STAFF = "jordan@advtracking.net";

test("the license action needs a proven session and nothing else", async () => {
  // No clearance groups at all: the license check must still answer, because it
  // is what decides whether the add-in offers anything else.
  const { deps, context } = harness({ securityGroups: [] });
  const response = await handleEvent(httpEvent("license"), context, deps);
  const payload = body(response);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.data.staff, false);
  assert.equal(payload.data.licensed, true);
  assert.equal(payload.data.setupAllowed, false);
  assert.equal(payload.data.domain, "example.com");
});

test("license reports staff for an Advantage One domain", async () => {
  const session = { database: "tenant_a", userName: STAFF, sessionId: "session-1", server: "my.geotab.test" };
  const { deps, context } = harness({
    users: [{ id: "u1", name: STAFF, securityGroups: [{ id: "GroupEverythingSecurityId" }] }]
  });
  const payload = body(await handleEvent(httpEvent("license", { session }), context, deps));

  assert.equal(payload.data.staff, true);
  assert.equal(payload.data.setupAllowed, true);
  assert.equal(payload.data.domain, "advtracking.net");
});

test("license also answers for a database that is not onboarded", async () => {
  const session = { database: "brand_new", userName: STAFF, sessionId: "session-1", server: "my.geotab.test" };
  const { deps, context } = harness({
    users: [{ id: "u1", name: STAFF, securityGroups: [{ id: "GroupEverythingSecurityId" }] }]
  });
  const payload = body(await handleEvent(httpEvent("license", { session }), context, deps));

  assert.equal(payload.data.onboarded, false);
  assert.equal(payload.data.licensed, false);
  assert.equal(payload.data.setupAllowed, true, "staff can set it up from here");
});

test("license shows a tenant why they cannot use the service", async () => {
  const config = createFakeConfig({});
  delete config.customers.tenant_a.license;
  const { deps, context } = harness({ config });
  const payload = body(await handleEvent(httpEvent("license"), context, deps));

  assert.equal(payload.data.staff, false);
  assert.equal(payload.data.licensed, false);
  assert.match(payload.data.message, /Please contact your CSR to enabled your license/);
});

test("a tenant cannot call the staff-only setup", async () => {
  const { deps, context, configWriter, secretPublisher } = harness();
  const response = await handleEvent(
    httpEvent("saveWorkerCredentials", { payload: { workerUserName: "svc@customer.com", workerPassword: "x" } }),
    context,
    deps
  );

  assert.equal(response.statusCode, 403);
  assert.equal(body(response).error.code, "ADDIN_ACCESS_DENIED");
  assert.equal(configWriter.writes.length, 0);
  assert.equal(secretPublisher.secrets.length, 0);
});

test("staff setup stores the secret and licenses the database", async () => {
  const session = { database: "tenant_a", userName: STAFF, sessionId: "session-1", server: "my.geotab.test" };
  const { deps, context, configWriter, secretPublisher } = harness({
    users: [{ id: "u1", name: STAFF, securityGroups: [{ id: "GroupEverythingSecurityId" }] }]
  });
  const response = await handleEvent(
    httpEvent("saveWorkerCredentials", {
      session,
      payload: { workerUserName: "svc-unassign@customer.com", workerPassword: "s3cret", timeZone: "America/Toronto" }
    }),
    context,
    deps
  );
  const payload = body(response);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.data.licensed, true);
  assert.equal(payload.data.secretCreated, true, "the fake secret store starts empty");
  assert.equal(secretPublisher.secrets.length, 1);
  assert.equal(secretPublisher.secrets[0].name, "unassign/tenant_a");
  assert.equal(configWriter.writes.length, 1);
  const record = configWriter.stored().customers.tenant_a;
  assert.equal(record.license.source, "addin-panel");
  assert.equal(record.workerUserName, "svc-unassign@customer.com");
  assert.equal(JSON.stringify(configWriter.stored()).includes("s3cret"), false, "the password stays in Secrets Manager");
});

test("an unlicensed database is refused on every tenant action", async () => {
  const config = createFakeConfig({});
  delete config.customers.tenant_a.license;
  const { deps, context, lines } = harness({ config });

  for (const action of ["listSchedules", "listAssignments", "unassign"]) {
    const response = await handleEvent(httpEvent(action, { payload: {} }), context, deps);
    assert.equal(response.statusCode, 403, action);
    assert.equal(body(response).error.code, "LICENSE_REQUIRED", action);
  }
  assert.deepEqual(outcomes(lines), ["denied", "denied", "denied"]);
});

test("staff may operate an unlicensed database", async () => {
  const config = createFakeConfig({});
  delete config.customers.tenant_a.license;
  const session = { database: "tenant_a", userName: STAFF, sessionId: "session-1", server: "my.geotab.test" };
  const { deps, context } = harness({
    config,
    users: [{ id: "u1", name: STAFF, securityGroups: [{ id: "GroupEverythingSecurityId" }] }]
  });
  const response = await handleEvent(httpEvent("listSchedules", { session }), context, deps);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(body(response).data.schedules, []);
});

test("a deployment can stop enforcing licences without a code change", async () => {
  const config = createFakeConfig({});
  delete config.customers.tenant_a.license;
  config.licensing = { enforce: false };
  const { deps, context } = harness({ config });

  const response = await handleEvent(httpEvent("listSchedules"), context, deps);
  assert.equal(response.statusCode, 200);
});

test("a broken payload or a broken secret fails the invocation so EventBridge retries", async () => {
  const { deps, context } = harness();
  await assert.rejects(() => handleEvent({ action: "unassign" }, context, deps), /Unrecognized scheduler payload/);
  await assert.rejects(() => handleEvent(scheduledEvent({ geotab_database: null }), context, deps), /no geotab_database/);

  const broken = harness({
    fetchSecret: async () => {
      throw new Error("ResourceNotFoundException");
    }
  });
  await assert.rejects(() => handleEvent(scheduledEvent(), broken.context, broken.deps), /ResourceNotFoundException/);
});
