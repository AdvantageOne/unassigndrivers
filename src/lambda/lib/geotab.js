/*
 * Scheduled Driver Unassign - MyGeotab JSON-RPC client
 * AdvantageOne
 *
 * Two ways to speak to MyGeotab, both over `POST https://<server>/apiv1`:
 *   authenticate({database, userName, password})  the tenant service account (scheduled runs)
 *   session(credentials)                          a forwarded add-in session (browser requests)
 *
 * The response envelope is JSON-RPC 2.0 (`{jsonrpc, id, result}` or
 * `{jsonrpc, id, error}`) — verified against a live capture. Errors become
 * AppError with a stable code so the add-in can show a useful message.
 *
 * The shared core expects the callback-style `api` object the add-in has; use
 * toCoreApi() to adapt a session client for it.
 */
"use strict";

const { appError } = require("./errors");

const DEFAULT_TIMEOUT_MS = 20000;
const AUTH_ERROR_TYPES = new Set([
  "InvalidUserException",
  "AuthenticationException",
  "UnauthorizedException",
  "SessionExpiredException",
  "ExpiredSessionException"
]);

function normaliseServer(input) {
  let value = String(input || "").trim().toLowerCase();
  if (!value) throw appError("BAD_REQUEST", "No Geotab server was supplied for this database.");
  value = value.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) || value.includes("..")) {
    throw appError("BAD_REQUEST", `Invalid Geotab server "${input}".`);
  }
  return value;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function rpcError(body, status, authCode) {
  const error = body && body.error;
  if (error) {
    const inner = error.data && error.data.type;
    const message = (inner ? inner + ": " : "") + (error.message || "MyGeotab error");
    if (inner && AUTH_ERROR_TYPES.has(inner)) return appError(authCode || "GEOTAB_ERROR", message);
    return appError("GEOTAB_ERROR", message);
  }
  return appError("GEOTAB_ERROR", `MyGeotab returned HTTP ${status}.`);
}

function normaliseCalls(calls) {
  return (calls || []).map((entry) => {
    if (Array.isArray(entry)) return { method: entry[0], params: entry[1] || {} };
    if (entry && entry.method) return { method: entry.method, params: entry.params || {} };
    throw appError("INTERNAL", "Malformed multiCall entry.");
  });
}

function createGeotab(options) {
  const options_ = options || {};
  const doFetch = options_.fetchImpl || fetch;
  const timeoutMs = options_.timeoutMs || DEFAULT_TIMEOUT_MS;
  const logger = options_.logger;
  let currentServer = normaliseServer(options_.server || "my.geotab.com");

  async function rpc(method, params, authCode) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    let response;
    try {
      response = await doFetch(`https://${currentServer}/apiv1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, params }),
        signal: timeout.signal
      });
    } catch (error) {
      clearTimeout(timer);
      const hint = error && error.name === "AbortError" ? `timed out after ${timeoutMs} ms` : error && error.message;
      throw appError("GEOTAB_ERROR", `Could not reach ${currentServer}: ${hint}`);
    }
    clearTimeout(timer);
    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      throw rpcError(null, response.status, authCode);
    }
    if (body && body.result !== undefined) return body.result;
    throw rpcError(body, response.status, authCode);
  }

  function session(credentials) {
    if (!credentials || !credentials.database || !credentials.userName) {
      throw appError("BAD_REQUEST", "Incomplete Geotab credentials.");
    }
    const withCredentials = (params) => Object.assign({}, params, { credentials });
    return {
      credentials,
      database: credentials.database,
      userName: credentials.userName,
      get server() {
        return currentServer;
      },
      call: (method, params) => rpc(method, withCredentials(params || {}), "SESSION_INVALID"),
      multiCall: (calls) =>
        rpc("ExecuteMultiCall", { calls: normaliseCalls(calls), credentials }, "SESSION_INVALID"),
      /** Runs `calls` in multiCall batches, flattening one result array per call. */
      multiCallChunked: async (calls, batchSize) => {
        const batches = chunk(normaliseCalls(calls), batchSize || 100);
        const out = [];
        for (const batch of batches) {
          const part = await rpc("ExecuteMultiCall", { calls: batch, credentials }, "SESSION_INVALID");
          out.push(...(Array.isArray(part) ? part : [part]));
        }
        return out;
      }
    };
  }

  return {
    get server() {
      return currentServer;
    },
    session,
    /** @throws AppError INTERNAL when the stored service account is wrong. */
    async authenticate(account) {
      const result = await rpc(
        "Authenticate",
        { database: account.database, userName: account.userName, password: account.password },
        "INTERNAL"
      );
      if (!result || !result.credentials) {
        throw appError("INTERNAL", "MyGeotab did not return credentials for the service account.");
      }
      if (result.path && result.path !== "ThisServer") {
        currentServer = normaliseServer(result.path);
        if (logger) logger.debug("Geotab redirected to a different server", { server: currentServer });
      }
      return result.credentials;
    }
  };
}

/** Adapts a session client to the callback-style api object the shared core expects. */
function toCoreApi(client) {
  return {
    call: (method, params, ok, err) => client.call(method, params).then(ok, err),
    multiCall: (calls, ok, err) => client.multiCall(calls).then(ok, err),
    getSession: (callback) =>
      callback({ userName: client.userName, database: client.database, server: client.server })
  };
}

module.exports = { createGeotab, normaliseServer, toCoreApi, chunk, AUTH_ERROR_TYPES };
