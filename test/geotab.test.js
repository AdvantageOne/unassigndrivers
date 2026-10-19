/*
 * The service's MyGeotab client (src/lambda/lib/geotab.js) is the only code the
 * Lambda uses to speak to Geotab, and its envelope handling decides whether a
 * scheduled run happens at all. It pinned "result present" as the definition of
 * success, which is wrong for the void methods: MyGeotab answers `Set` and
 * `Remove` with a bare `{"jsonrpc":"2.0"}`, so every AddInData write threw
 * "MyGeotab returned HTTP 200." *after* the write had been applied — which is
 * what failed jorn's scheduled runs (the legacy-claim `Set`).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGeotab } = require("../src/lambda/lib/geotab");

/** A one-shot fetch stub; `notJson` makes the body unreadable, as a proxy page would be. */
function stubFetch(status, body, notJson) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return {
      status,
      json: async () => {
        if (notJson) throw new SyntaxError("Unexpected token < in JSON at position 0");
        return body;
      }
    };
  };
  impl.calls = calls;
  return impl;
}

function client(fetchImpl) {
  const geotab = createGeotab({ server: "my.geotab.com", fetchImpl });
  return geotab.session({ database: "tenant_a", userName: "svc-unassign", sessionId: "session-1" });
}

test("the call goes to the server's apiv1 endpoint as JSON-RPC with the session merged in", async () => {
  const fetchImpl = stubFetch(200, { jsonrpc: "2.0", result: [{ id: "b1" }] });
  const result = await client(fetchImpl).call("Get", { typeName: "Device" });

  assert.deepEqual(result, [{ id: "b1" }]);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, "https://my.geotab.com/apiv1");
  assert.equal(fetchImpl.calls[0].headers["content-type"], "application/json");
  assert.deepEqual(fetchImpl.calls[0].body, {
    method: "Get",
    params: {
      typeName: "Device",
      credentials: { database: "tenant_a", userName: "svc-unassign", sessionId: "session-1" }
    }
  });
});

test("a void method's bare success envelope resolves instead of failing", async () => {
  const fetchImpl = stubFetch(200, { jsonrpc: "2.0" });
  const result = await client(fetchImpl).call("Set", { typeName: "AddInData", entity: { id: "avJ8" } });

  assert.equal(result, undefined, "a write with nothing to return is a success");
  assert.equal(fetchImpl.calls[0].body.method, "Set");
});

test("an error envelope becomes an AppError with the Geotab message", async () => {
  const fetchImpl = stubFetch(200, {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Incorrect password", data: { type: "InvalidUserException" } }
  });

  await assert.rejects(
    () => client(fetchImpl).call("Get", { typeName: "Device" }),
    (error) => {
      assert.equal(error.code, "SESSION_INVALID", "the caller's auth code is the one used");
      assert.equal(error.message, "InvalidUserException: Incorrect password");
      return true;
    }
  );
});

test("a body that is not a JSON-RPC envelope still fails loudly", async () => {
  for (const body of [{}, { message: "Forbidden" }, [{ result: 1 }]]) {
    const fetchImpl = stubFetch(200, body);
    await assert.rejects(
      () => client(fetchImpl).call("Get", { typeName: "Device" }),
      (error) => error.code === "GEOTAB_ERROR" && /MyGeotab returned HTTP 200/.test(error.message),
      `body ${JSON.stringify(body)} must not read as success`
    );
  }
});

test("an unreadable body reports the status", async () => {
  const fetchImpl = stubFetch(502, null, true);
  await assert.rejects(
    () => client(fetchImpl).call("Get", { typeName: "Device" }),
    (error) => error.code === "GEOTAB_ERROR" && /MyGeotab returned HTTP 502/.test(error.message)
  );
});

test("authenticate returns the service account's credentials and follows a server redirect", async () => {
  const fetchImpl = stubFetch(200, {
    jsonrpc: "2.0",
    result: { credentials: { database: "tenant_a", userName: "svc-unassign", sessionId: "s2" }, path: "my123.geotab.com" }
  });
  const geotab = createGeotab({ server: "my.geotab.com", fetchImpl });

  const credentials = await geotab.authenticate({ database: "tenant_a", userName: "svc-unassign", password: "p" });
  assert.deepEqual(credentials, { database: "tenant_a", userName: "svc-unassign", sessionId: "s2" });
  assert.equal(geotab.server, "my123.geotab.com", "later calls must use the server Geotab named");
  assert.deepEqual(fetchImpl.calls[0].body.params, { database: "tenant_a", userName: "svc-unassign", password: "p" });
});

test("a response with no credentials is an internal error, not a session", async () => {
  const fetchImpl = stubFetch(200, { jsonrpc: "2.0", result: { path: "ThisServer" } });
  const geotab = createGeotab({ server: "my.geotab.com", fetchImpl });

  await assert.rejects(
    () => geotab.authenticate({ database: "tenant_a", userName: "svc-unassign", password: "p" }),
    (error) => error.code === "INTERNAL" && /did not return credentials/.test(error.message)
  );
});
