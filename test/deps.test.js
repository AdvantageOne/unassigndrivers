/*
 * The wiring in buildDeps is where an option name can silently disagree with the
 * module it configures. That happened once — the config store was handed
 * `loader` while it reads `options.load` — and every add-in request failed with
 * "options.load is not a function" despite a green test suite, because the tests
 * injected the store itself. These tests build the real deps with fakes for each
 * AWS adapter and then *use* every one of them.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDeps } = require("../src/lambda/handler");
const { readEnv } = require("../src/lambda/env");
const { createLogger } = require("../src/lambda/lib/logger");
const { createFakeConfig, createFakeSchedulerClient } = require("./support/fakes");

function env(overrides) {
  return readEnv(
    Object.assign(
      {
        CONFIG_BUCKET: "advone-ca-central-config",
        CONFIG_KEY: "config/customers.json",
        AWS_REGION: "ca-central-1",
        DEPLOYMENT_NAME: "advone-ca-central",
        ALLOWED_ORIGINS: "https://*.geotab.com",
        TARGET_FUNCTION_ARN: "arn:aws:lambda:ca-central-1:000000000000:function:advone-unassign-api",
        SCHEDULER_ROLE_ARN: "arn:aws:iam::000000000000:role/advone-unassign-advone-ca-central-scheduler",
        SCHEDULER_DLQ_ARN: "arn:aws:sqs:ca-central-1:000000000000:advone-unassign-advone-ca-central-dlq",
        SERVICE_VERSION: "test"
      },
      overrides || {}
    )
  );
}

function fakeReadWrite(config) {
  let text = JSON.stringify(config);
  return {
    async read() {
      return { text, etag: "etag-1" };
    },
    async write(next) {
      text = next;
      return { etag: "etag-2" };
    }
  };
}

function fakeSecretWriteClient() {
  const calls = [];
  return {
    calls,
    async createSecret(input) {
      calls.push(input);
      if (calls.length === 1) return { ARN: "arn:secret" };
      const error = new Error("exists");
      error.name = "ResourceExistsException";
      throw error;
    },
    async putSecretValue(input) {
      calls.push(input);
      return { VersionId: "v2" };
    }
  };
}

test("buildDeps wires every adapter to the option name its module reads", async () => {
  const config = createFakeConfig({});
  const schedulerClient = createFakeSchedulerClient();
  const deps = buildDeps({
    env: env(),
    overrides: {
      logger: createLogger({ level: "error", sink: () => {} }),
      loadConfig: async () => JSON.stringify(config),
      fetchSecret: async () =>
        JSON.stringify({ database: "tenant_a", server: "my.geotab.test", userName: "svc-unassign", password: "p" }),
      configReadWrite: fakeReadWrite(config),
      secretWriteClient: fakeSecretWriteClient(),
      schedulerClient
    }
  });

  // 1. the config store reads through the loader it was given
  const loaded = await deps.configStore.get();
  assert.equal(loaded.customers.tenant_a.key, "tenant_a");
  assert.equal((await deps.configStore.getCustomer("tenant_a")).customer.secretName, "unassign/tenant_a");

  // 2. the secret store reads through its fetcher
  assert.equal((await deps.secretStore.get("unassign/tenant_a", "tenant_a")).userName, "svc-unassign");

  // 3. the config writer reads and writes through its adapter
  const written = await deps.configWriter.mutate((current) => {
    current.customers.tenant_a.notes = "touched";
    return current;
  });
  assert.equal(written.config.customers.tenant_a.notes, "touched");

  // 4. the secret publisher creates, then updates on ResourceExistsException
  assert.equal((await deps.secretPublisher.put("unassign/new", { database: "new" })).created, true);
  assert.equal((await deps.secretPublisher.put("unassign/new", { database: "new" })).created, false);

  // 5. the scheduler talks to EventBridge through the client it was handed
  const created = await deps.scheduler.upsert({
    database: "tenant_a",
    scope: { groupIds: [] },
    skipDriving: true,
    spec: { mode: "daily", time: "23:00", timeZone: "UTC", days: [] }
  });
  assert.match(created.name, /^all-2300-[0-9a-f]{8}$/);
  assert.equal(schedulerClient.schedules.size, 1);

  // 6. geotab clients are created per server and cached
  const a = deps.geotabFor("my.geotab.test");
  assert.equal(a, deps.geotabFor("my.geotab.test"));
  assert.equal(typeof a.authenticate, "function");
  assert.equal(typeof a.session, "function");
  assert.notEqual(a, deps.geotabFor("my.ca.geotab.test"), "a different server is a different client");
});

test("the default dependencies are constructible without touching AWS", () => {
  const deps = buildDeps({ env: env() });
  for (const name of ["configStore", "secretStore", "configWriter", "secretPublisher", "scheduler", "geotabFor", "logger"]) {
    assert.ok(deps[name], `${name} must exist`);
  }
  assert.equal(typeof deps.configStore.get, "function");
  assert.equal(typeof deps.configWriter.mutate, "function");
  assert.equal(typeof deps.secretPublisher.put, "function");
  assert.equal(typeof deps.scheduler.upsert, "function");
  assert.equal(typeof deps.now().toISOString(), "string");
});

test("a partial environment still produces usable dependencies", () => {
  const deps = buildDeps({ env: readEnv({}) });
  assert.equal(deps.env.scheduleGroupPrefix, "UnassignDriverSchedules");
  assert.equal(deps.env.configKey, "config/customers.json");
  assert.equal(typeof deps.geotabFor("my.geotab.com").session, "function");
});
