/*
 * The clearance decision is what stands between a browser request and a fleet
 * mutation. The cases below mirror the live capture in
 * docs/exampleSecurityFilterCheck.txt, including the trap that the catalog group
 * lists every filter as isAdd: true.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const auth = require("../src/lambda/actions/auth");
const { createFakeGeotab, createFakeConfig } = require("./support/fakes");

const ADDIN_ID = "aTestAddInSecurityId";
const PAGE = "Scheduled Driver Unassign";

const filter = (overrides) =>
  Object.assign({ isAdd: true, securityId: { id: ADDIN_ID, name: "ViewSecurityId", customPageName: PAGE, isSystemSecurityId: true } }, overrides);

const EVERYTHING = {
  id: "GroupEverythingSecurityId",
  securityFilters: [{ isAdd: true, securityId: { id: "SecurityIdEverythingId", name: "SecurityIdEverythingId", customPageName: "undefined" } }]
};
const CATALOG = { id: "GroupSecurityId", securityFilters: [filter({})] };
const GRANT = { id: "b200", securityFilters: [filter({})] };
const REVOKED = { id: "b201", securityFilters: [filter({ isAdd: false })] };
const UNRELATED = { id: "b202", securityFilters: [{ isAdd: true, securityId: { id: "aOtherAddInSecurityId", customPageName: "Other Addin" } }] };

function context(options) {
  const settings = options || {};
  return {
    session: Object.assign(
      { database: "tenant_a", userName: "admin@example.com", sessionId: "session-1", server: "my.geotab.test" },
      settings.session || {}
    ),
    config: settings.config || createFakeConfig({}),
    geotab: createFakeGeotab({
      securityGroups: settings.securityGroups || [{ id: "b200" }],
      groupsById: settings.groupsById || { b200: GRANT },
      users: settings.users,
      call: settings.call,
      multiCall: settings.multiCall
    })
  };
}

test("an Administrator passes through the Everything marker", async () => {
  const result = await auth.authorize(
    context({ securityGroups: [{ id: "GroupEverythingSecurityId" }], groupsById: { GroupEverythingSecurityId: EVERYTHING } })
  );
  assert.equal(result.matchedSecurityId, "SecurityIdEverythingId");
  assert.equal(result.reason, "everything-group");
  assert.equal(result.userName, "admin@example.com");
});

test("a clearance group carrying this add-in's filter passes", async () => {
  const result = await auth.authorize(context({}));
  assert.equal(result.matchedSecurityId, ADDIN_ID);
  assert.equal(result.reason, "addin-filter");
});

test("a group whose filter is revoked does not pass", async () => {
  await assert.rejects(
    () => auth.authorize(context({ securityGroups: [{ id: "b201" }], groupsById: { b201: REVOKED } })),
    (error) => error.code === "ADDIN_ACCESS_DENIED"
  );
});

test("the database-wide catalog group never authorizes anyone", async () => {
  await assert.rejects(
    () => auth.authorize(context({ securityGroups: [{ id: "GroupSecurityId" }], groupsById: { GroupSecurityId: CATALOG } })),
    (error) => error.code === "ADDIN_ACCESS_DENIED",
    "the catalog lists every filter as isAdd: true — trusting it would authorize every user"
  );
});

test("another add-in's filter does not authorize this one", async () => {
  await assert.rejects(
    () => auth.authorize(context({ securityGroups: [{ id: "b202" }], groupsById: { b202: UNRELATED } })),
    (error) => error.code === "ADDIN_ACCESS_DENIED"
  );
});

test("access can be granted by page name when no security id is configured yet", async () => {
  const config = createFakeConfig({});
  config.addIn.securityId = { id: "", name: "ViewSecurityId" };
  const result = await auth.authorize(context({ config }));
  assert.equal(result.reason, "addin-filter");
});

test("an unconfigured deployment denies everyone (fail closed)", async () => {
  const config = createFakeConfig({});
  config.addIn.securityId = { id: "", name: "ViewSecurityId" };
  config.addIn.pageName = "";
  await assert.rejects(() => auth.authorize(context({ config })), /no addIn.securityId.id configured yet/);
});

test("the group is selected by id, not by position in the result", async () => {
  const result = await auth.authorize(
    context({
      multiCall: async () => [UNRELATED, GRANT]
    })
  );
  assert.equal(result.reason, "addin-filter");
});

test("a user with no clearance groups is denied", async () => {
  await assert.rejects(
    () => auth.authorize(context({ securityGroups: [] })),
    (error) => error.code === "ADDIN_ACCESS_DENIED"
  );
});

test("an invalid session is reported as such, not as a clearance problem", async () => {
  await assert.rejects(
    () =>
      auth.authorize(
        context({
          call: () => {
            throw new Error("InvalidUserException: no such user");
          }
        })
      ),
    (error) => error.code === "SESSION_INVALID"
  );
});

test("a failure reading clearances denies rather than crashing", async () => {
  await assert.rejects(
    () =>
      auth.authorize(
        context({
          multiCall: () => {
            throw new Error("timeout");
          }
        })
      ),
    (error) => error.code === "ADDIN_ACCESS_DENIED"
  );
});

test("an incomplete session is rejected before any Geotab call", () => {
  assert.throws(() => auth.requireSession({ database: "tenant_a" }), (error) => error.code === "SESSION_INVALID");
  assert.throws(() => auth.requireSession(null), /missing database/);
  assert.equal(auth.requireSession({ database: "d", userName: "u", sessionId: "s" }).database, "d");
});

test("requireIsAdd can be relaxed for read-only clearances", () => {
  const addIn = { securityId: { id: ADDIN_ID }, pageName: PAGE };
  assert.equal(auth.decideClearance([REVOKED], addIn, { requireIsAdd: true }), null);
  assert.ok(auth.decideClearance([REVOKED], addIn, { requireIsAdd: false }));
  assert.equal(auth.decideClearance([CATALOG], addIn, { ignoreCatalogGroup: true }), null);
  assert.ok(auth.decideClearance([CATALOG], addIn, { ignoreCatalogGroup: false }));
  assert.equal(auth.decideClearance([UNRELATED], addIn, {}), null);
});
