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

/**
 * Classifies the invocation. Three shapes arrive here:
 *
 *   http       a request through the Function URL (has requestContext.http)
 *   scheduler  an EventBridge Scheduler invocation — the schedule's Input payload,
 *              which always carries `source: "scheduler"`
 *   direct     `aws lambda invoke` (the deploy script's health smoke test, a
 *              manual check). It has no requestContext and is not a schedule, so
 *              it is handled like a request without an Origin header rather than
 *              being mistaken for a schedule payload.
 */
function parseEvent(event) {
  const request = event && event.requestContext && event.requestContext.http;
  if (request) {
    return {
      kind: "http",
      method: (request.method || "POST").toUpperCase(),
      origin: header(event, "origin"),
      body: decodeJsonBody(event)
    };
  }
  const payload = event || {};
  if (payload.source === "scheduler") {
    return { kind: "scheduler", payload, body: payload, method: "POST", origin: null };
  }
  return { kind: "direct", payload, body: payload, method: "POST", origin: null };
}

/**
 * Origin matching, with wildcards.
 *
 * The Lambda Function URL's own CORS list accepts only exact origins or a bare
 * `*`, so a pattern like `https://*.geotab.com` cannot live there. Terraform
 * therefore widens the URL's list to `*` when a pattern is configured, and this
 * function is where the real policy is enforced: an origin must match one of the
 * configured entries exactly, or match a pattern whose `*` stands for any run of
 * characters that does not cross a `/`.
 */
function originMatches(pattern, origin) {
  if (!pattern) return false;
  if (pattern === origin) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  return new RegExp("^" + escaped + "$", "i").test(origin);
}

function isOriginAllowed(origin, allowedOrigins) {
  const allowed = allowedOrigins || [];
  if (!origin) return true; // server-to-server (the deploy script's smoke test)
  if (allowed.includes("*")) return true;
  const candidate = String(origin).replace(/\/+$/, "");
  return allowed.some((pattern) => originMatches(String(pattern).replace(/\/+$/, ""), candidate));
}

/** A concrete origin for probing CORS from a pattern (the deploy script's smoke test). */
function probeOrigin(pattern) {
  if (!pattern || pattern === "*") return "https://my.geotab.com";
  return String(pattern).replace("*", "my");
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

module.exports = {
  parseEvent,
  decodeJsonBody,
  header,
  isOriginAllowed,
  originMatches,
  probeOrigin,
  responseHeaders,
  respond,
  ok,
  failure,
  preflight
};
