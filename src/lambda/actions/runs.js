/*
 * Scheduled Driver Unassign - the run history action
 * AdvantageOne
 *
 * Lists what this service has run for the caller's database: every attempt the
 * Lambda made, scheduled or triggered from the add-in, with how it ended. The
 * add-in merges these with the detail it reads from the tenant's own database,
 * so a scheduled run can be confirmed from AWS even when it never reached
 * Geotab — and a browser that was closed when the slot fired still shows it.
 *
 * Access is the default (session + clearance + licence), the same gate the rest
 * of the scheduler surface uses.
 */
"use strict";

const { MAX_RUNS } = require("../lib/run-log");

const MAX_RETURNED = MAX_RUNS;

async function listRuns(context, payload) {
  const asked = payload && Number(payload.limit);
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_RETURNED) : MAX_RETURNED;
  const runs = await context.runLog.list(context.session.database, limit);
  return { database: context.session.database, source: "aws", runs };
}

module.exports = { listRuns, MAX_RETURNED };
