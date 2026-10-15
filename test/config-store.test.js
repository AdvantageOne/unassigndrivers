/*
 * The configuration object is the tenant registry: a malformed one must fail
 * loudly, and an unknown or disabled tenant must never fall through to anyone
 * else's database.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createConfigStore, parseConfig, validateConfig } = require("../src/lambda/lib/config-store");
const { createSecretStore, parseSecret } = require("../src/lambda/lib/secrets");
const { createFakeConfig } = require("./support/fakes");

test("parseConfig accepts the documented shape", () => {
  const config = createFakeConfig({});
  assert.equal(parseConfig(JSON.stringify(config)).customers.tenant_a.secretName, "unassign/tenant_a");
});

test("parseConfig rejects invalid JSON and structural breakage", () => {
  assert.throws(() => parseConfig("{"), /not valid JSON/);
  assert.throws(() => validateConfig(null), /empty/);
  assert.throws(() => validateConfig({ customers: {} }), /schemaVersion/);
  assert.throws(() => validateConfig({ schemaVersion: 2, customers: {}, addIn: {} }), /schemaVersion/);
  assert.throws(() => validateConfig({ schemaVersion: 1, customers: {} }), /addIn/);
  assert.throws(() => validateConfig({ schemaVersion: 1, addIn: {}, customers: null }), /addIn/);
  assert.throws(
    () => validateConfig({ schemaVersion: 1, addIn: { securityId: {} }, customers: { a: { key: "a", geotab: { database: "a" }, enabled: true } } }),
    /missing "secretName"/
  );
  assert.throws(
    () => validateConfig({ schemaVersion: 1, addIn: { securityId: {} }, customers: { a: { key: "a", secretName: "s", geotab: {} , enabled: true} } }),
    /missing geotab.database/
  );
  assert.throws(
    () => validateConfig({ schemaVersion: 1, addIn: { securityId: {} }, customers: { a: { key: "a", secretName: "s", geotab: { database: "a" } } } }),
    /enabled/
  );
});

test("getCustomer reports unknown and disabled tenants distinctly", async () => {
  const store = createConfigStore({ load: async () => JSON.stringify(createFakeConfig({})), ttlMs: 0 });
  const found = await store.getCustomer("tenant_a");
  assert.equal(found.customer.secretName, "unassign/tenant_a");

  await assert.rejects(() => store.getCustomer("nope"), (error) => error.code === "DATABASE_NOT_ONBOARDED");
  await assert.rejects(() => store.getCustomer(), (error) => error.code === "BAD_REQUEST");

  const disabled = createFakeConfig({});
  disabled.customers.tenant_a.enabled = false;
  const disabledStore = createConfigStore({ load: async () => JSON.stringify(disabled), ttlMs: 0 });
  await assert.rejects(() => disabledStore.getCustomer("tenant_a"), /disabled/);
});

test("the configuration is cached until it expires or is invalidated", async () => {
  let loads = 0;
  let clock = 1000;
  const store = createConfigStore({
    load: async () => {
      loads += 1;
      return JSON.stringify(createFakeConfig({}));
    },
    ttlMs: 60000,
    now: () => clock
  });

  await store.get();
  await store.get();
  assert.equal(loads, 1, "a warm container must not re-read S3 on every call");

  clock += 60001;
  await store.get();
  assert.equal(loads, 2, "the cache must expire");

  store.invalidate();
  await store.get();
  assert.equal(loads, 3);
});

test("a loader failure surfaces as an internal error, not a crash", async () => {
  const store = createConfigStore({ load: async () => { throw new Error("AccessDenied"); }, ttlMs: 0 });
  await assert.rejects(() => store.get(), /AccessDenied/);
});

test("parseSecret validates the service account shape", () => {
  const good = parseSecret(JSON.stringify({ database: "tenant_a", server: "my.geotab.com", userName: "svc", password: "p" }), "tenant_a");
  assert.equal(good.userName, "svc");
  assert.throws(() => parseSecret("{}"), /missing "database"/);
  assert.throws(() => parseSecret(JSON.stringify({ database: "tenant_a", server: "s", userName: "u", password: "" })), /missing "password"/);
  assert.throws(
    () => parseSecret(JSON.stringify({ database: "other", server: "s", userName: "u", password: "p" }), "tenant_a"),
    /names database/
  );
});

test("secrets are cached per name and can be invalidated", async () => {
  let fetches = 0;
  let clock = 0;
  const store = createSecretStore({
    fetchSecret: async (name) => {
      fetches += 1;
      return JSON.stringify({ database: "tenant_a", server: "my.geotab.com", userName: `svc-${name}`, password: "p" });
    },
    ttlMs: 300000,
    now: () => clock
  });

  await store.get("unassign/tenant_a", "tenant_a");
  await store.get("unassign/tenant_a", "tenant_a");
  assert.equal(fetches, 1);

  clock += 300001;
  await store.get("unassign/tenant_a", "tenant_a");
  assert.equal(fetches, 2);

  store.invalidate("unassign/tenant_a");
  await store.get("unassign/tenant_a", "tenant_a");
  assert.equal(fetches, 3);
});

test("a missing secret is reported with the secret name", async () => {
  const store = createSecretStore({
    fetchSecret: async () => { throw new Error("ResourceNotFoundException"); },
    ttlMs: 0
  });
  await assert.rejects(() => store.get("unassign/missing"), /unassign\/missing/);
});
