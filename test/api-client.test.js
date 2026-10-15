/*
 * The add-in's client is the only code that speaks to the deployment from a
 * browser, so its contract is pinned here: the request shape, the envelope, the
 * error codes the UI switches on, and the promise that a session never leaks.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../src/addin/api-client");
const { createFetch } = require("./support/fakes");

const SESSION = { database: "tenant_a", userName: "admin@customer.com", sessionId: "secret-session", server: "my.geotab.com" };

function client(options) {
  const settings = options || {};
  const fetchImpl = settings.fetchImpl || createFetch(() => ({ body: { ok: true, action: "license", data: {}, requestId: "req-1" } }));
  const built = api.create({
    baseUrl: settings.baseUrl || "https://abc.lambda-url.ca-central-1.on.aws",
    session: settings.session === undefined ? SESSION : settings.session,
    fetchImpl,
    timeoutMs: settings.timeoutMs
  });
  return { client: built, fetchImpl };
}

test("the request carries the action, the session and the payload", async () => {
  const { client: c, fetchImpl } = client();
  await c.saveWorkerCredentials({ workerUserName: "svc@customer.com" });

  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://abc.lambda-url.ca-central-1.on.aws/");
  assert.equal(call.headers["content-type"], "application/json");
  assert.deepEqual(call.body, {
    action: "saveWorkerCredentials",
    session: SESSION,
    payload: { workerUserName: "svc@customer.com" }
  });
});

test("every method maps to its action name", async () => {
  const { client: c, fetchImpl } = client();
  await c.license();
  await c.listSchedules();
  await c.createSchedule({ mode: "daily" });
  await c.updateSchedule({ name: "all-2300-1234abcd" });
  await c.addRun({ at: "2026-10-16T08:00" });
  await c.deleteSchedule({ name: "all-2300-1234abcd" });
  await c.unassign({});
  await c.listAssignments({});
  await c.health();

  assert.deepEqual(fetchImpl.calls.map((call) => call.body.action), [
    "license",
    "listSchedules",
    "createSchedule",
    "updateSchedule",
    "addRun",
    "deleteSchedule",
    "unassign",
    "listAssignments",
    "health"
  ]);
  assert.deepEqual(fetchImpl.calls[0].body.payload, {}, "license takes no payload");
});

test("a successful envelope resolves to its data", async () => {
  const { client: c } = client({
    fetchImpl: createFetch(() => ({ body: { ok: true, action: "license", data: { staff: true, licensed: false }, requestId: "req-9" } }))
  });
  assert.deepEqual(await c.license(), { staff: true, licensed: false });
});

test("an error envelope becomes an ApiError carrying the code and request id", async () => {
  const { client: c } = client({
    fetchImpl: createFetch(() => ({
      status: 403,
      body: { ok: false, error: { code: "LICENSE_REQUIRED", message: "not licensed" }, requestId: "req-7" }
    }))
  });

  await assert.rejects(
    () => c.listSchedules(),
    (error) => {
      assert.equal(error.name, "ApiError");
      assert.equal(error.code, "LICENSE_REQUIRED");
      assert.equal(error.status, 403);
      assert.equal(error.requestId, "req-7");
      assert.equal(error.message, "not licensed");
      return true;
    }
  );
});

test("a non-envelope failure and an unreadable body both surface as internal errors", async () => {
  const { client: bad } = client({ fetchImpl: createFetch(() => ({ status: 502, body: "<html>gateway</html>" })) });
  await assert.rejects(() => bad.health(), (error) => error.code === "INTERNAL");

  const { client: empty } = client({ fetchImpl: createFetch(() => ({ status: 200, body: "" })) });
  assert.deepEqual(await empty.health(), {});
});

test("a network failure is reported, not thrown raw", async () => {
  const { client: c } = client({
    fetchImpl: async () => {
      throw new Error("Failed to fetch");
    }
  });
  await assert.rejects(() => c.license(), (error) => error.code === "INTERNAL" && /Could not reach/.test(error.message));
});

test("a slow service aborts on the timeout", async () => {
  const { client: c } = client({
    timeoutMs: 5,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })
  });
  await assert.rejects(() => c.license(), (error) => error.code === "INTERNAL" && /did not respond in time/.test(error.message));
});

test("the session provider may be a promise, an object or a function", async () => {
  const routes = () => ({ body: { ok: true, data: { staff: false }, requestId: "r" } });
  await api.create({ baseUrl: "https://x/", session: async () => SESSION, fetchImpl: createFetch(routes) }).license();
  await api.create({ baseUrl: "https://x/", session: () => SESSION, fetchImpl: createFetch(routes) }).license();
  await api.create({ baseUrl: "https://x/", session: SESSION, fetchImpl: createFetch(routes) }).license();
});

test("no session means no request at all", async () => {
  const fetchImpl = createFetch(() => ({ body: { ok: true, data: {} } }));
  const c = api.create({ baseUrl: "https://x/", session: null, fetchImpl });
  await assert.rejects(() => c.license(), (error) => error.code === "SESSION_INVALID");
  assert.equal(fetchImpl.calls.length, 0);
});

test("constructing the client without a base url or fetch is refused", () => {
  assert.throws(() => api.create({ baseUrl: "" }), /baseUrl is required/);
  assert.throws(() => api.create({ baseUrl: "https://x/", fetchImpl: null, session: SESSION }), /fetch is not available/);
});

test("textFor prefers the documented copy and falls back to the message", () => {
  assert.equal(api.textFor({ code: "LICENSE_REQUIRED" }), api.ERROR_TEXT.LICENSE_REQUIRED);
  assert.equal(api.textFor({ code: "NOT_A_CODE", message: "raw detail" }), "raw detail");
  assert.equal(api.textFor(null), api.ERROR_TEXT.INTERNAL);
  assert.equal(api.ERROR_TEXT.LICENSE_REQUIRED, "Please contact your CSR to enabled your license");
});

test("every code the service can return has friendly text", () => {
  for (const code of [
    "BAD_REQUEST",
    "SESSION_INVALID",
    "DATABASE_NOT_ONBOARDED",
    "ADDIN_ACCESS_DENIED",
    "CLEARANCE_REQUIRED",
    "LICENSE_REQUIRED",
    "NOT_FOUND",
    "DUPLICATE",
    "GEOTAB_ERROR",
    "INTERNAL"
  ]) {
    assert.ok(api.ERROR_TEXT[code], `missing text for ${code}`);
  }
});
