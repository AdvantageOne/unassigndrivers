/*
 * Scheduled Driver Unassign - add-in API client
 * AdvantageOne
 *
 * Talks to the AWS deployment (Lambda Function URL) described in
 * docs/aws-port-implementation-prompt.md sections 5.1 - 5.3.
 *
 * Inlined into unassignDrivers.html between the BUILD:client markers by
 * build/inline-core.mjs, so edit this file and rebuild rather than editing the
 * add-in. The same object is require()-able in Node for tests.
 *
 * The session is a bearer-equivalent credential: it is sent on every request
 * and never stored, logged, or cached.
 */
(function (root) {
  "use strict";

  var DEFAULT_TIMEOUT_MS = 20000;

  var ERROR_TEXT = {
    BAD_REQUEST: "The request was rejected. Check the form and try again.",
    SESSION_INVALID: "Your MyGeotab session is no longer valid. Refresh the page and sign in again.",
    DATABASE_NOT_ONBOARDED: "This database is not set up for automatic runs yet. Contact Advantage One.",
    ADDIN_ACCESS_DENIED: "Your MyGeotab role does not grant access to this add-in.",
    CLEARANCE_REQUIRED: "Your MyGeotab role is missing a clearance this action needs.",
    LICENSE_REQUIRED: "Please contact your CSR to enable your license",
    NOT_FOUND: "That schedule no longer exists. Refresh the list.",
    DUPLICATE: "A schedule already exists for that group at that time.",
    GEOTAB_ERROR: "MyGeotab rejected the request.",
    INTERNAL: "The scheduling service hit an error. Try again in a moment."
  };

  function ApiError(code, message, status, requestId) {
    var error = new Error(message || ERROR_TEXT[code] || "The request failed.");
    error.name = "ApiError";
    error.code = code || "INTERNAL";
    error.status = status || 0;
    error.requestId = requestId || null;
    return error;
  }

  // Codes whose message is written for whoever is filling the form: the service
  // names the reason ("MyGeotab rejected those credentials for advone_matt_dev1:
  // InvalidUserException: Incorrect login credentials"), and that beats generic
  // copy. Everything else keeps the canned sentence — an INTERNAL detail is not
  // something to put in front of an operator.
  var PREFER_SERVER_MESSAGE = { BAD_REQUEST: true };

  /** Message to show a person for a thrown error. */
  function textFor(error) {
    if (!error) return ERROR_TEXT.INTERNAL;
    if (error.code && PREFER_SERVER_MESSAGE[error.code] && error.message) return error.message;
    if (error.code && ERROR_TEXT[error.code]) return ERROR_TEXT[error.code];
    return error.message || ERROR_TEXT.INTERNAL;
  }

  function normaliseBaseUrl(baseUrl) {
    var value = String(baseUrl || "").trim();
    if (!value) return "";
    return value.replace(/\/+$/, "");
  }

  function createClient(options) {
    options = options || {};
    var baseUrl = normaliseBaseUrl(options.baseUrl);
    var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    var fetchImpl = options.fetchImpl || (root && root.fetch ? root.fetch.bind(root) : null);
    var sessionProvider = options.session || options.getSession || null;

    if (!baseUrl) throw new Error("A1UnassignApi: baseUrl is required");
    if (!fetchImpl) throw new Error("A1UnassignApi: fetch is not available");

    /** Accepts an object, a promise, or the MyGeotab callback style getSession(cb). */
    function session() {
      return new Promise(function (resolve, reject) {
        var provided;
        try {
          provided = typeof sessionProvider === "function" ? sessionProvider() : sessionProvider;
        } catch (e) {
          reject(e);
          return;
        }
        if (provided && typeof provided.then === "function") {
          provided.then(resolve, reject);
          return;
        }
        if (provided) {
          resolve(provided);
          return;
        }
        reject(ApiError("SESSION_INVALID", "No MyGeotab session is available."));
      });
    }

    function withTimeout() {
      if (typeof AbortController === "undefined") return { signal: undefined, cancel: function () {} };
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
      return { signal: controller.signal, cancel: function () { clearTimeout(timer); } };
    }

    function parseBody(response) {
      return response.text().then(function (text) {
        if (!text) return {};
        try {
          return JSON.parse(text);
        } catch (e) {
          throw ApiError("INTERNAL", "The scheduling service returned an unreadable response.", response.status);
        }
      });
    }

    function request(action, payload) {
      return session().then(function (current) {
        var timeout = withTimeout();
        return fetchImpl(baseUrl + "/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: action, session: current, payload: payload || {} }),
          signal: timeout.signal
        }).then(function (response) {
          timeout.cancel();
          return parseBody(response).then(function (body) {
            if (body && body.ok === false && body.error) {
              throw ApiError(body.error.code, body.error.message, response.status, body.requestId);
            }
            if (!response.ok) {
              throw ApiError("INTERNAL", "The scheduling service returned HTTP " + response.status + ".", response.status);
            }
            return (body && body.data) || {};
          });
        }, function (error) {
          timeout.cancel();
          if (error && error.name === "AbortError") {
            throw ApiError("INTERNAL", "The scheduling service did not respond in time.");
          }
          throw ApiError("INTERNAL", "Could not reach the scheduling service: " + (error && error.message ? error.message : error));
        });
      });
    }

    return {
      baseUrl: baseUrl,
      request: request,
      listSchedules: function () { return request("listSchedules", {}); },
      createSchedule: function (payload) { return request("createSchedule", payload); },
      updateSchedule: function (payload) { return request("updateSchedule", payload); },
      addRun: function (payload) { return request("addRun", payload); },
      deleteSchedule: function (payload) { return request("deleteSchedule", payload); },
      unassign: function (payload) { return request("unassign", payload || {}); },
      listAssignments: function (payload) { return request("listAssignments", payload || {}); },
      license: function () { return request("license", {}); },
      saveWorkerCredentials: function (payload) { return request("saveWorkerCredentials", payload); },
      health: function () { return request("health", {}); }
    };
  }

  var api = { create: createClient, ApiError: ApiError, textFor: textFor, ERROR_TEXT: ERROR_TEXT };
  root.A1UnassignApi = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
