/*
 * Scheduled Driver Unassign - HTTP plumbing
 * AdvantageOne
 *
 * A Lambda Function URL with `authorization_type = NONE` is the transport: the
 * caller's MyGeotab session is the only credential, validated in the handler.
 *
 * CORS headers belong to the function URL (`cors { }` in infra/modules/unassign),
 * which adds them to every response and answers the preflight itself. This module
 * therefore adds none of its own: Lambda would return both sets and the browser
 * would reject the response with "'Access-Control-Allow-Origin' header contains
 * multiple values". The origin allow-list check stays here as a second gate.
 */
"use strict";

const { appError, asAppError, errorBody } = require("./lib/errors");

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

/** Response headers this function owns. CORS headers come from the function URL. */
function responseHeaders() {
  return { "content-type": "application/json", vary: "origin" };
}

function respond(statusCode, body, origin, allowedOrigins, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(responseHeaders(), extraHeaders || {}),
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

/**
 * Answers an OPTIONS request. Normally unreachable through the function URL,
 * which handles preflight itself; it exists so a direct invoke (local runs, the
 * deploy smoke test) and a deployment without URL CORS still behave.
 */
function preflight(origin, allowedOrigins) {
  if (!isOriginAllowed(origin, allowedOrigins)) {
    return respond(403, { ok: false, error: errorBody(appError("ADDIN_ACCESS_DENIED", "Origin not allowed.")) }, origin, allowedOrigins);
  }
  return respond(204, {}, origin, allowedOrigins);
}

module.exports = { parseEvent, decodeJsonBody, header, isOriginAllowed, responseHeaders, respond, ok, failure, preflight };
