/*
 * Scheduled Driver Unassign - service-account secrets
 * AdvantageOne
 *
 * One Secrets Manager secret per tenant, named `unassign/<database>`, holding
 * the service account used for scheduled runs:
 *   { "database": "…", "server": "my.geotab.com", "userName": "svc-unassign", "password": "…" }
 * See docs/aws-port-implementation-prompt.md section 5.7. Values are cached for
 * the life of the warm container and never logged.
 */
"use strict";

const { appError } = require("./errors");

const REQUIRED_FIELDS = ["database", "server", "userName", "password"];

function parseSecret(text, expectedDatabase) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw appError("INTERNAL", `The secret is not valid JSON: ${error.message}`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!parsed || typeof parsed[field] !== "string" || !parsed[field].trim()) {
      throw appError("INTERNAL", `The secret is missing "${field}".`);
    }
  }
  if (expectedDatabase && parsed.database !== expectedDatabase) {
    throw appError("INTERNAL", `The secret names database "${parsed.database}" but "${expectedDatabase}" was requested.`);
  }
  return { database: parsed.database, server: parsed.server, userName: parsed.userName, password: parsed.password };
}

/**
 * @param {object} options
 * @param {(name: string) => Promise<string>} options.fetchSecret  returns the secret string
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.now]
 */
function createSecretStore(options) {
  const ttlMs = options.ttlMs == null ? 300000 : options.ttlMs;
  const now = options.now || (() => Date.now());
  const cache = new Map();

  async function get(secretName, expectedDatabase) {
    const cached = cache.get(secretName);
    if (cached && ttlMs > 0 && now() - cached.at < ttlMs) return cached.value;
    let text;
    try {
      text = await options.fetchSecret(secretName);
    } catch (error) {
      if (error && error.code === "INTERNAL") throw error;
      throw appError("INTERNAL", `Could not read secret "${secretName}": ${error && error.message ? error.message : error}`);
    }
    const value = parseSecret(text, expectedDatabase);
    cache.set(secretName, { value, at: now() });
    return value;
  }

  function invalidate(secretName) {
    if (secretName) cache.delete(secretName);
    else cache.clear();
  }

  return { get, invalidate };
}

module.exports = { createSecretStore, parseSecret };
