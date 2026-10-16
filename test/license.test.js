/*
 * Licensing has two sides: who a caller is (staff, by email domain) and whether
 * their database is licensed. Both are data-driven, so both are tested as plain
 * decisions over the configuration, plus the write path a staff member uses to
 * set a database up.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const licensing = require("../src/lambda/lib/licensing");
const license = require("../src/lambda/actions/license");
const apiClient = require("../src/addin/api-client");
const { createFakeConfig, createFakeGeotab, clone } = require("./support/fakes");

test("the unlicensed sentence is the same in the service, the client and the add-in", () => {
  const sentence = apiClient.ERROR_TEXT.LICENSE_REQUIRED;
  assert.equal(sentence, "Please contact your CSR to enable your license");
  assert.ok(license.MESSAGE_UNLICENSED.includes(sentence), "the service message must carry the sentence");
  const html = readFileSync(join(__dirname, "..", "unassignDrivers.html"), "utf8");
  assert.ok(html.includes(sentence), "the add-in's modal must show the same sentence");
});

const STAFF = "jordan@advtracking.net";
const STAFF2 = "ops@advantageone.tech";
const TENANT = "admin@customer.com";

function configWith(overrides) {
  const config = createFakeConfig({});
  for (const [database, value] of Object.entries(overrides || {})) {
    config.customers[database] = value;
  }
  return config;
}

function context(options) {
  const settings = options || {};
  const config = settings.config || createFakeConfig({});
  const writes = [];
  const secrets = [];
  let stored = JSON.stringify(config, null, 2);
  return {
    session: Object.assign({ database: "tenant_a", userName: STAFF, sessionId: "session-1", server: "my.geotab.test" }, settings.session || {}),
    config,
    env: { version: "test" },
    logger: null,
    now: () => new Date("2026-10-15T12:00:00.000Z"),
    geotabFor: settings.geotabFor || (() => createFakeGeotab({ authenticate: settings.authenticate })),
    configStore: { invalidate() {} },
    secretStore: { invalidate() {} },
    configWriter: {
      writes,
      async mutate(mutator) {
        const next = await mutator(JSON.parse(stored));
        if (!next) return { unchanged: true, attempts: 1 };
        stored = JSON.stringify(next, null, 2);
        writes.push(next);
        return { config: next, attempts: 1 };
      }
    },
    secretPublisher: {
      secrets,
      async put(name, payload) {
        const created = !secrets.some((secret) => secret.name === name);
        secrets.push({ name, payload });
        return { name, created };
      }
    },
    writes,
    secrets,
    stored: () => JSON.parse(stored)
  };
}

test("emailDomain reads the domain and rejects anything else", () => {
  assert.equal(licensing.emailDomain("Bob@AdvTracking.NET"), "advtracking.net");
  assert.equal(licensing.emailDomain("a@b.co.uk"), "b.co.uk");
  assert.equal(licensing.emailDomain("nobody"), "");
  assert.equal(licensing.emailDomain("trailing@"), "");
  assert.equal(licensing.emailDomain(null), "");
});

test("staff is an exact domain match on both Advantage One domains", () => {
  const settings = licensing.licensingSettings(createFakeConfig({}));
  assert.deepEqual(settings.staffDomains, ["advtracking.net", "advantageone.tech"]);
  assert.equal(settings.enforce, true);
  assert.ok(licensing.isStaff(STAFF, settings).staff);
  assert.ok(licensing.isStaff(STAFF2, settings).staff);
  assert.equal(licensing.isStaff(TENANT, settings).staff, false);
  assert.equal(licensing.isStaff("someone@not-advtracking.net", settings).staff, false);
  assert.equal(licensing.isStaff("someone@advtracking.net.evil.com", settings).staff, false);
  assert.equal(licensing.isStaff("no-at-sign", settings).staff, false);
});

test("a deployment can override the staff domains and enforcement", () => {
  const config = createFakeConfig({ licensing: { staffDomains: ["@example.org"], enforce: false } });
  const settings = licensing.licensingSettings(config);
  assert.deepEqual(settings.staffDomains, ["example.org"]);
  assert.equal(settings.enforce, false);
  assert.ok(licensing.isStaff("anyone@example.org", settings).staff);
});

test("readLicense reports an unknown database as not onboarded", () => {
  const state = licensing.readLicense(createFakeConfig({}), "nobody");
  assert.equal(state.onboarded, false);
  assert.equal(state.licensed, false);
  assert.equal(state.customer, null);
});

test("checkLicense tells the add-in who is asking and whether they may set up", async () => {
  for (const [userName, staff] of [[STAFF, true], [STAFF2, true], [TENANT, false]]) {
    const result = await license.checkLicense(context({ session: { userName } }));
    assert.equal(result.staff, staff, userName);
    assert.equal(result.setupAllowed, staff);
    assert.equal(result.licensed, true);
    assert.equal(result.database, "tenant_a");
    assert.equal(result.workerConfigured, true);
    assert.equal(result.message, null);
  }
});

test("checkLicense explains an unlicensed database to a tenant", async () => {
  const config = createFakeConfig({});
  delete config.customers.tenant_a.license;
  const result = await license.checkLicense(context({ config, session: { userName: TENANT } }));
  assert.equal(result.licensed, false);
  assert.equal(result.staff, false);
  assert.equal(result.message, license.MESSAGE_UNLICENSED);
});

test("checkLicense works for a database that is not onboarded yet", async () => {
  const result = await license.checkLicense(context({ session: { database: "brand_new", userName: STAFF } }));
  assert.equal(result.onboarded, false);
  assert.equal(result.licensed, false);
  assert.equal(result.staff, true);
  assert.equal(result.setupAllowed, true);
});

test("assertLicensed blocks a tenant, lets staff through, and honours enforce: false", () => {
  const unlicensed = createFakeConfig({});
  delete unlicensed.customers.tenant_a.license;

  assert.throws(
    () => license.assertLicensed({ session: { database: "tenant_a", userName: TENANT }, config: unlicensed }),
    (error) => error.code === "LICENSE_REQUIRED" && error.status === 403
  );
  assert.deepEqual(license.assertLicensed({ session: { database: "tenant_a", userName: STAFF }, config: unlicensed }), {
    staff: true,
    licensed: false
  });

  const relaxed = clone(unlicensed);
  relaxed.licensing = { enforce: false };
  assert.deepEqual(license.assertLicensed({ session: { database: "tenant_a", userName: TENANT }, config: relaxed }), {
    staff: false,
    licensed: false,
    enforced: false
  });
});

test("saveWorkerCredentials verifies, stores the secret and adds the config record", async () => {
  const ctx = context({
    config: (() => {
      const config = createFakeConfig({});
      delete config.customers.brand_new;
      return config;
    })(),
    session: { database: "brand_new", userName: STAFF }
  });

  const result = await license.saveWorkerCredentials(ctx, {
    workerUserName: "svc-unassign@customer.com",
    workerPassword: "correct horse battery staple",
    server: "my.geotab.com",
    timeZone: "America/Edmonton",
    notes: "onboarded from the add-in"
  });

  assert.deepEqual(result, {
    database: "brand_new",
    secretName: "unassign/brand_new/serviceaccount",
    secretCreated: true,
    configUpdated: true,
    verified: true,
    licensed: true,
    workerUserName: "svc-unassign@customer.com",
    timeZone: "America/Edmonton"
  });

  assert.equal(ctx.secrets.length, 1);
  assert.deepEqual(ctx.secrets[0].payload, {
    database: "brand_new",
    server: "my.geotab.com",
    userName: "svc-unassign@customer.com",
    password: "correct horse battery staple"
  });

  const record = ctx.stored().customers.brand_new;
  assert.equal(record.secretName, "unassign/brand_new/serviceaccount");
  assert.equal(record.enabled, true);
  assert.equal(record.workerUserName, "svc-unassign@customer.com");
  assert.equal(record.license.licensed, true);
  assert.equal(record.license.source, "addin-panel");
  assert.equal(record.license.updatedBy, STAFF);
  assert.equal(record.timeZone, "America/Edmonton");
  assert.equal(JSON.stringify(ctx.stored()).includes("correct horse"), false, "the password must never reach the config");
  assert.equal(record.key, "brand_new");
  assert.equal(record.geotab.database, "brand_new");
});

test("saveWorkerCredentials updates an existing record in place", async () => {
  const ctx = context({ session: { userName: STAFF } });
  ctx.secrets.push({ name: "unassign/tenant_a/serviceaccount", payload: { userName: "old-svc" } }); // the secret already exists
  const before = ctx.stored().customers.tenant_a;

  const result = await license.saveWorkerCredentials(ctx, {
    workerUserName: "svc-unassign@customer.com",
    workerPassword: "another-password"
  });

  assert.equal(result.secretCreated, false);
  const after = ctx.stored().customers.tenant_a;
  assert.equal(after.createdAt, before.createdAt, "the original creation stamp survives");
  assert.equal(after.key, "tenant_a");
  assert.equal(Object.keys(ctx.stored().customers).length, 1);
});

test("saveWorkerCredentials refuses anyone who is not staff, before writing", async () => {
  const ctx = context({ session: { userName: TENANT } });
  await assert.rejects(
    () => license.saveWorkerCredentials(ctx, { workerUserName: "svc@customer.com", workerPassword: "x" }),
    (error) => error.code === "ADDIN_ACCESS_DENIED"
  );
  assert.equal(ctx.secrets.length, 0);
  assert.equal(ctx.writes.length, 0);
});

test("saveWorkerCredentials validates its input", async () => {
  const ctx = context({});
  await assert.rejects(() => license.saveWorkerCredentials(ctx, {}), /service account user name is required/);
  await assert.rejects(
    () => license.saveWorkerCredentials(ctx, { workerUserName: "svc@customer.com" }),
    /service account password is required/
  );
  await assert.rejects(
    () => license.saveWorkerCredentials(ctx, { workerUserName: "svc@customer.com", workerPassword: "x", server: "not a host" }),
    (error) => error.code === "BAD_REQUEST"
  );
  await assert.rejects(
    () => license.saveWorkerCredentials(ctx, { workerUserName: "svc@customer.com", workerPassword: "x", timeZone: "Mars/Olympus" }),
    /Unknown time zone/
  );
  assert.equal(ctx.secrets.length, 0);
});

test("a rejected credential writes nothing at all", async () => {
  const ctx = context({
    authenticate: () => {
      throw new Error("InvalidUserException: wrong password");
    }
  });

  await assert.rejects(
    () => license.saveWorkerCredentials(ctx, { workerUserName: "svc@customer.com", workerPassword: "wrong" }),
    (error) =>
      error.code === "BAD_REQUEST" &&
      // The operator needs to know *which* database refused, what MyGeotab said,
      // and what to check — this message is what the add-in now shows.
      error.message.includes(`rejected those credentials for ${ctx.session.database}`) &&
      /wrong password/.test(error.message) &&
      /user name and password/.test(error.message)
  );
  assert.equal(ctx.secrets.length, 0, "no secret when the account cannot sign in");
  assert.equal(ctx.writes.length, 0, "no config record either");
});

test("licensing can be left off for a database being set up", async () => {
  const ctx = context({ session: { userName: STAFF } });
  const result = await license.saveWorkerCredentials(ctx, {
    workerUserName: "svc@customer.com",
    workerPassword: "x",
    licensed: false
  });
  assert.equal(result.licensed, false);
  assert.equal(ctx.stored().customers.tenant_a.license.licensed, false);
});
