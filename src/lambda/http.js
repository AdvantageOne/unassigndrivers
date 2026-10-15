/*
 * Scheduled Driver Unassign - HTTP plumbing
 * AdvantageOne
 *
 * A Lambda Function URL with `authorization_type = NONE` is the transport: the
 * caller's MyGeotab session is the only credential, validated in the handler.
 * That makes the browser origin check meaningful, so it is enforced here rather
 * than left to the platform.
 */
"use strict";

const { appError, asAppError, errorBody } = require("./lib/errors");

const CORS_METHODS = "POST, OPTIONS";
const CORS_HEADERS = "content-type";
const CORS_MAX_AGE = "600";

function header(event, name) {
  const headers = (event && event.headers) || {};
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

function decodeJsonBody(event) {
  const raw = event && event.body;
  if (raw == null || raw === "") return {};
  let text = raw;
  if (event.isBase64Encoded) text = Buffer.from(raw, "base64").toString("utf8");
  if (Buffer.byteLength(text, "utf8") > 128 * 1024) {
    throw appError("BAD_REQUEST", "The request body is too large.");
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw appError("BAD_REQUEST", `The request body is not a JSON object: ${error.message}`);
  }
}

/** Distinguishes a browser request from an EventBridge Scheduler invocation. */
function parseEvent(event) {
  const request = event && event.requestContext && event.requestContext.http;
  if (!request) return { kind: "scheduler", payload: event || {} };
  return {
    kind: "http",
    method: (request.method || "POST").toUpperCase(),
    origin: header(event, "origin"),
    body: decodeJsonBody(event)
  };
}

function isOriginAllowed(origin, allowedOrigins) {
  const allowed = allowedOrigins || [];
  if (!origin) return true; // server-to-server (the deploy script's smoke test)
  if (allowed.includes("*")) return true;
  return allowed.includes(origin);
}

function corsHeaders(origin, allowedOrigins) {
  const headers = {
    "access-control-allow-methods": CORS_METHODS,
    "access-control-allow-headers": CORS_HEADERS,
    "access-control-max-age": CORS_MAX_AGE,
    "content-type": "application/json",
    vary: "origin"
  };
  if (origin && isOriginAllowed(origin, allowedOrigins)) {
    headers["access-control-allow-origin"] = allowedOrigins.includes("*") ? "*" : origin;
  }
  return headers;
}

function respond(statusCode, body, origin, allowedOrigins, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(corsHeaders(origin, allowedOrigins), extraHeaders || {}),
    body: JSON.stringify(body)
  };
}

function ok(data, options) {
  const requestId = options.requestId;
  return respond(200, { ok: true, action: options.action, data, warnings: options.warnings || [], requestId },
    options.origin, options.allowedOrigins);
}

function failure(error, options) {
  const app = asAppError(error);
  return respond(app.status, { ok: false, error: errorBody(app), requestId: options.requestId },
    options.origin, options.allowedOrigins);
}

function preflight(origin, allowedOrigins) {
  if (!isOriginAllowed(origin, allowedOrigins)) {
    return respond(403, { ok: false, error: errorBody(appError("ADDIN_ACCESS_DENIED", "Origin not allowed.")) }, origin, allowedOrigins);
  }
  return respond(204, {}, origin, allowedOrigins);
}

module.exports = { parseEvent, decodeJsonBody, header, isOriginAllowed, corsHeaders, respond, ok, failure, preflight };
