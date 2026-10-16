/*
 * Scheduled Driver Unassign - licensing actions
 * AdvantageOne
 *
 *   checkLicense          what the add-in asks on load: am I staff, and is this
 *                         database licensed?
 *   saveWorkerCredentials  staff-only: take the MyGeotab user the scheduled runs
 *                         sign in as, prove it works, store it in Secrets
 *                         Manager and add or update the database's record in the
 *                         deployment configuration (which is also what licenses
 *                         the database).
 *   assertLicensed         the gate the handler applies to every tenant action.
 *
 * Two rules worth stating plainly:
 *  - the session is always proven first (`Get User` through the caller's own
 *    session). The license endpoint "only cares about the domain", but the
 *    domain is only trustworthy once the session behind it is real; otherwise
 *    anyone could claim to be staff;
 *  - credentials are verified against MyGeotab before anything is written, so a
 *    typo cannot leave a database with a service account that cannot sign in.
 */
"use strict";

const { appError } = require("../lib/errors");
const licensing = require("../lib/licensing");
const naming = require("../lib/naming");
const { normaliseServer } = require("../lib/geotab");

const SECRET_PREFIX = "unassign/";
const MESSAGE_UNLICENSED = "This database is not licensed. Please contact your CSR to enabled your license.";
const MAX_NOTES = 500;

function requireString(payload, field, label) {
  const value = payload && payload[field];
  if (typeof value !== "string" || !value.trim()) {
    throw appError("BAD_REQUEST", `${label || field} is required.`);
  }
  return value.trim();
}

/** What the add-in shows on load. Never throws for an unknown database. */
async function checkLicense(context) {
  const session = context.session;
  const settings = licensing.licensingSettings(context.config);
  const caller = licensing.isStaff(session.userName, settings);
  const state = licensing.readLicense(context.config, session.database);

  if (context.logger) {
    context.logger.info("license checked", {
      database: session.database,
      userName: session.userName,
      domain: caller.domain || null,
      staff: caller.staff,
      licensed: state.licensed,
      onboarded: state.onboarded,
      workerConfigured: state.workerConfigured,
      setupAllowed: caller.staff
    });
  }

  return {
    database: session.database,
    userName: session.userName,
    domain: caller.domain,
    staff: caller.staff,
    licensed: state.licensed,
    licenseId: state.licenseId,
    onboarded: state.onboarded,
    enabled: state.enabled,
    workerConfigured: state.workerConfigured,
    workerUserName: state.workerUserName,
    enforce: settings.enforce,
    setupAllowed: caller.staff,
    timeZone: state.timeZone,
    message: state.licensed || caller.staff ? null : MESSAGE_UNLICENSED
  };
}

/**
 * Staff-only setup. Order matters: prove the credentials, write the secret, and
 * only then record the database — a record pointing at a secret that does not
 * exist would break every scheduled run.
 */
async function saveWorkerCredentials(context, payload) {
  const session = context.session;
  const settings = licensing.licensingSettings(context.config);
  const caller = licensing.isStaff(session.userName, settings);
  if (!caller.staff) {
    throw appError(
      "ADDIN_ACCESS_DENIED",
      `Setting up a database needs an Advantage One account; "${caller.domain || session.userName}" is not one.`
    );
  }

  const workerUserName = requireString(payload, "workerUserName", "The service account user name");
  const workerPassword = requireString(payload, "workerPassword", "The service account password");
  const server = normaliseServer((payload && payload.server) || "my.geotab.com");
  const timeZone = payload && payload.timeZone ? naming.assertTimeZone(payload.timeZone) : null;
  const licensed = !payload || payload.licensed !== false;
  const notes = payload && typeof payload.notes === "string" ? payload.notes.trim().slice(0, MAX_NOTES) : "";
  const database = session.database;

  const geotab = context.geotabFor(server);
  try {
    await geotab.authenticate({ database, userName: workerUserName, password: workerPassword });
  } catch (error) {
    throw appError("BAD_REQUEST", `MyGeotab rejected those credentials: ${error.message}`);
  }

  const secretName = `${SECRET_PREFIX}${database}`;
  const secret = await context.secretPublisher.put(secretName, {
    database,
    server,
    userName: workerUserName,
    password: workerPassword
  });
  context.secretStore.invalidate(secretName);

  const now = context.now().toISOString();
  const written = await context.configWriter.mutate((config) => {
    config.customers = config.customers || {};
    const existing = config.customers[database] || null;
    const record = Object.assign({}, existing || {}, {
      key: database,
      geotab: { database, server },
      secretName,
      enabled: true,
      workerUserName,
      license: licensing.licenseRecord({
        licensed,
        source: "addin-panel",
        updatedAt: now,
        updatedBy: session.userName,
        notes
      }),
      createdAt: (existing && existing.createdAt) || now,
      createdBy: (existing && existing.createdBy) || session.userName,
      notes: (existing && existing.notes) || notes
    });
    if (timeZone) record.timeZone = timeZone;
    config.customers[database] = record;
    return config;
  });
  context.configStore.invalidate();

  if (context.logger) {
    context.logger.info("service account saved from the add-in", {
      outcome: "setup",
      database,
      secretCreated: secret.created,
      licensed,
      configUpdated: !written.unchanged,
      attempts: written.attempts
    });
  }

  return {
    database,
    secretName,
    secretCreated: secret.created,
    configUpdated: !written.unchanged,
    verified: true,
    licensed,
    workerUserName,
    timeZone
  };
}

/**
 * The licence gate for tenant actions. Staff are never blocked (they operate the
 * service); everyone else needs a licence record unless the deployment turned
 * enforcement off.
 */
function assertLicensed(context) {
  const settings = licensing.licensingSettings(context.config);
  const caller = licensing.isStaff(context.session.userName, settings);
  const state = licensing.readLicense(context.config, context.session.database);

  if (caller.staff) return { staff: true, licensed: state.licensed };
  if (state.licensed) return { staff: false, licensed: true };
  if (!settings.enforce) return { staff: false, licensed: false, enforced: false };
  throw appError("LICENSE_REQUIRED", MESSAGE_UNLICENSED);
}

module.exports = {
  checkLicense,
  saveWorkerCredentials,
  assertLicensed,
  MESSAGE_UNLICENSED,
  SECRET_PREFIX
};
