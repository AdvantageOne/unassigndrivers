/*
 * Scheduled Driver Unassign - the worker
 * AdvantageOne
 *
 * One implementation of "reset every in-scope asset to Unknown Driver", used by
 * all three entry points:
 *   - the EventBridge schedule (service account from Secrets Manager)
 *   - the add-in's "Unassign All Now" button (the caller's own session)
 *   - a dry run (read only, for verification)
 *
 * Credentials differ; the work does not. All reads, writes, retries,
 * verification and the tenant's run log come from the shared core
 * (src/core/unassign-core.js) — the same code the add-in runs in the browser.
 */
"use strict";

const core = require("../../core/unassign-core");
const { appError } = require("../lib/errors");
const { toCoreApi } = require("../lib/geotab");

const MAX_ROWS = 200;
const DEFAULT_LOCK_WAIT_MS = 5000;
const PERMISSION_HINT = /permission|not authorized|unauthoriz|security|clearance/i;

function slim(rows) {
  return (rows || []).slice(0, MAX_ROWS).map((row) => ({
    device: row.deviceName,
    driver: row.driverName,
    type: row.changeType,
    hos: row.hosLoggedIn || undefined,
    error: row.error
  }));
}

/** A core-compatible api: the caller's session, or the tenant's service account. */
async function buildApi(context) {
  const geotab = context.geotabFor(context.server);
  let credentials;
  if (context.secret) {
    credentials = await geotab.authenticate(context.secret);
  } else {
    if (!context.session) throw appError("INTERNAL", "runUnassign needs either a session or a service account.");
    credentials = {
      database: context.session.database,
      userName: context.session.userName,
      sessionId: context.session.sessionId
    };
  }
  return { api: toCoreApi(geotab.session(credentials)), server: geotab.server };
}

/**
 * Migration guard. While the add-in's own in-browser scheduler is still in use,
 * both it and this service coordinate through the schedule record the add-in
 * keeps in Geotab AddInData: whoever writes `lastOccurrence` first wins. Once
 * the client-side scheduler is retired the record disappears and this becomes a
 * no-op. The claim id must be unique per invocation, or two concurrent runs
 * would each see their own write and both proceed.
 */
async function claimOccurrence(context) {
  const records = await core.loadRecords(context.api);
  if (!records.schedule) return { claimed: true, legacy: false };
  const claimed = await core.claimOccurrence(
    context.api,
    context.occurrence,
    "lambda-" + context.invocationId,
    context.by,
    context.lockWaitMs == null ? DEFAULT_LOCK_WAIT_MS : context.lockWaitMs
  );
  if (context.logger) {
    context.logger.debug("legacy AddInData schedule present", { claimed, occurrence: context.occurrence });
  }
  return { claimed, legacy: true };
}

function summarise(entry) {
  return {
    at: entry.at,
    unassigned: entry.unassigned.length,
    skipped: entry.skipped.length,
    failed: entry.failed.length,
    stillAssigned: (entry.stillAssigned || []).length,
    rows: {
      unassigned: slim(entry.unassigned),
      skipped: slim(entry.skipped),
      failed: slim(entry.failed),
      stillAssigned: slim(entry.stillAssigned)
    },
    note: entry.note
  };
}

async function runUnassign(context) {
  const scope = context.scope || { groupIds: [] };
  const built = await buildApi(context);

  if (context.dryRun) {
    const rows = await core.getAssignments(built.api, { groupIds: scope.groupIds, now: context.now() });
    return { dryRun: true, count: rows.length, rows: slim(rows) };
  }

  const worker = {
    api: built.api,
    occurrence: context.occurrence || context.now().toISOString(),
    by: context.by || "Unassign Service",
    invocationId: context.invocationId,
    lockWaitMs: context.lockWaitMs,
    logger: context.logger
  };
  let entry;
  let lock;
  try {
    lock = context.skipLock ? { claimed: true, legacy: false } : await claimOccurrence(worker);
    if (!lock.claimed) {
      // `skippedReason` (not `skipped`, which is a count of driving assets that
      // were left alone) is the signal that this run deliberately did nothing.
      return { skippedReason: "another runner already handled this occurrence", occurrence: worker.occurrence };
    }
    entry = await core.run(built.api, {
      trigger: context.trigger || "scheduled",
      occurrence: worker.occurrence,
      userName: worker.by,
      groupIds: scope.groupIds,
      skipDriving: context.skipDriving !== false
    });
  } catch (error) {
    // A manual run uses the caller's own clearance, so a permission failure is
    // about them; a scheduled run uses the service account, so it is a
    // provisioning problem and must not be blamed on a user.
    if (!context.secret && error && error.code === "GEOTAB_ERROR" && PERMISSION_HINT.test(error.message || "")) {
      throw appError("CLEARANCE_REQUIRED", "Your MyGeotab role cannot change driver assignments.");
    }
    throw error;
  }

  return Object.assign(summarise(entry), { legacyLock: lock.legacy, server: built.server });
}

module.exports = { runUnassign, buildApi, claimOccurrence, slim, MAX_ROWS };
