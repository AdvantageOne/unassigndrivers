/*
 * Scheduled Driver Unassign - authorization
 * AdvantageOne
 *
 * Implements docs/aws-port-implementation-prompt.md section 6. Two independent
 * gates, both evaluated against the caller's own MyGeotab session:
 *
 *   1. the session is live   — `Get User` for the signed-in user succeeds
 *   2. the add-in is cleared — one of the user's clearance groups carries this
 *                              add-in's security filter with isAdd: true, or the
 *                              group is the Everything (Administrator) marker
 *
 * Everything about that model was verified against a live capture
 * (docs/exampleSecurityFilterCheck.txt): a group's `securityFilters` entries are
 * `{isAdd, securityId:{id, name, customPageName, isSystemSecurityId, …}}`, and
 * `isAdd` is the only flag. Two traps are handled explicitly:
 *   - `Get Group` returns many groups even for an id search (23 in the capture),
 *     so results are always matched by id, never by position;
 *   - `GroupSecurityId` lists every filter in the database with isAdd: true, so
 *     treating it as a grant would authorize everyone (ignoreCatalogGroup).
 */
"use strict";

const { appError } = require("../lib/errors");

const CATALOG_GROUP_ID = "GroupSecurityId";
const EVERYTHING_SECURITY_ID = "SecurityIdEverythingId";
const USER_FIELDS = ["id", "name", "securityGroups"];
const GROUP_CALL_BATCH = 100;

function requireSession(session) {
  const value = session || {};
  const missing = ["database", "userName", "sessionId"].filter((field) => !value[field] || typeof value[field] !== "string");
  if (missing.length) {
    throw appError("SESSION_INVALID", `The MyGeotab session is incomplete (missing ${missing.join(", ")}).`);
  }
  return { database: value.database, userName: value.userName, sessionId: value.sessionId, server: value.server };
}

function filterMatches(filter, addIn) {
  const securityId = (filter && filter.securityId) || {};
  if (addIn.securityId && addIn.securityId.id && securityId.id === addIn.securityId.id) return true;
  if (addIn.pageName && securityId.customPageName === addIn.pageName) return true;
  return false;
}

/**
 * Pure decision over one group's filters. Exported so the allow/deny table can
 * be unit tested without a Geotab round trip.
 */
function decideForGroup(group, addIn, clearance) {
  const settings = clearance || {};
  if (settings.ignoreCatalogGroup !== false && group.id === CATALOG_GROUP_ID) return null;
  for (const filter of group.securityFilters || []) {
    if (settings.allowEverythingGroup !== false && filter.isAdd === true && filter.securityId && filter.securityId.id === EVERYTHING_SECURITY_ID) {
      return { matchedSecurityId: EVERYTHING_SECURITY_ID, reason: "everything-group", groupId: group.id };
    }
    if (settings.requireIsAdd !== false && filter.isAdd !== true) continue;
    if (filterMatches(filter, addIn)) {
      return { matchedSecurityId: (filter.securityId && filter.securityId.id) || addIn.pageName, reason: "addin-filter", groupId: group.id };
    }
  }
  return null;
}

/** Pure decision across all of a user's groups. */
function decideClearance(groups, addIn, clearance) {
  for (const group of groups || []) {
    if (!group) continue;
    const decision = decideForGroup(group, addIn, clearance);
    if (decision) return decision;
  }
  return null;
}

function pickGroup(result, groupId) {
  const list = Array.isArray(result) ? result : [];
  return list.find((group) => group && group.id === groupId) || null;
}

/**
 * Proves the forwarded session is real by reading the signed-in user through it.
 * Every action that trusts anything about the caller goes through here, including
 * the license check: without it, a caller could simply claim to be staff.
 *
 * @param {object} context
 * @param {object} context.session  what the add-in forwarded
 * @param {object} context.geotab   a client from lib/geotab for the caller's server
 * @returns {Promise<{session, client, user}>}
 */
async function proveSession(context) {
  const session = requireSession(context.session);
  const client = context.geotab.session({
    database: session.database,
    userName: session.userName,
    sessionId: session.sessionId
  });

  let user;
  try {
    const users = await client.call("Get", {
      typeName: "User",
      search: { name: session.userName },
      propertySelector: { fields: USER_FIELDS }
    });
    user = Array.isArray(users) ? users[0] : users;
  } catch (error) {
    throw appError("SESSION_INVALID", `MyGeotab rejected the session: ${error.message}`);
  }
  if (!user) throw appError("SESSION_INVALID", `MyGeotab has no user named "${session.userName}".`);
  return { session, client, user };
}

/**
 * Session proof plus the add-in clearance check.
 *
 * @param {object} context
 * @param {object} context.session  what the add-in forwarded
 * @param {object} context.config   the deployment configuration
 * @param {object} context.geotab   a client from lib/geotab for the caller's server
 * @returns {Promise<{database, userName, matchedSecurityId, reason, groups}>}
 */
async function authorize(context) {
  const addIn = (context.config && context.config.addIn) || {};
  const clearance = addIn.clearance || {};
  const logger = context.logger;

  const { session, client, user } = await proveSession(context);

  const groupIds = Array.from(
    new Set(((user.securityGroups || []).map((group) => group && group.id).filter(Boolean)))
  );
  if (!groupIds.length) {
    throw appError("ADDIN_ACCESS_DENIED", "The signed-in user has no security clearance groups.");
  }

  const calls = groupIds.map((id) => ["Get", { typeName: "Group", search: { id } }]);
  let results;
  try {
    results = await client.multiCallChunked(calls, GROUP_CALL_BATCH);
  } catch (error) {
    throw appError("ADDIN_ACCESS_DENIED", `Could not read security clearances: ${error.message}`);
  }

  const groups = groupIds.map((id, index) => pickGroup(results[index], id));
  const decision = decideClearance(groups, addIn, clearance);
  if (!decision) {
    const configured = Boolean(addIn.securityId && addIn.securityId.id) || Boolean(addIn.pageName);
    const detail = configured
      ? "none of the user's clearance groups grants this add-in"
      : "this deployment has no addIn.securityId.id configured yet, so no caller can be authorized";
    throw appError("ADDIN_ACCESS_DENIED", `Your MyGeotab role does not grant access to this add-in (${detail}).`);
  }

  if (logger) {
    logger.debug("authorized", {
      userName: session.userName,
      database: session.database,
      groups: groupIds.length,
      matched: decision.matchedSecurityId,
      reason: decision.reason
    });
  }
  return {
    database: session.database,
    userName: session.userName,
    matchedSecurityId: decision.matchedSecurityId,
    reason: decision.reason,
    groups: groupIds
  };
}

module.exports = {
  authorize,
  proveSession,
  decideClearance,
  decideForGroup,
  requireSession,
  CATALOG_GROUP_ID,
  EVERYTHING_SECURITY_ID
};
