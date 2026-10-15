/*
 * Scheduled Driver Unassign - assignment preview
 * AdvantageOne
 *
 * Read-only: which in-scope assets hold a driver right now, with the driving and
 * HOS flags the add-in already renders. Uses the caller's session, so MyGeotab's
 * own data access rules apply.
 */
"use strict";

const core = require("../../core/unassign-core");
const { slim } = require("./unassign");

const MAX_ROWS = 500;

async function listAssignments(context) {
  const scope = context.scope || { groupIds: [] };
  const rows = await core.getAssignments(context.api, { groupIds: scope.groupIds, now: context.now() });
  return { count: rows.length, rows: slim(rows).slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}

module.exports = { listAssignments, MAX_ROWS };
