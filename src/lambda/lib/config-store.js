/*
 * Scheduled Driver Unassign - runtime configuration (S3)
 * AdvantageOne
 *
 * `s3://<config-bucket>/config/customers.json` is the tenant registry: it maps
 * a Geotab database name to the Secrets Manager secret that holds its service
 * account, and records this add-in's Geotab security id (the clearance used to
 * authorize callers). See docs/aws-port-implementation-prompt.md section 5.6.
 *
 * The object is read once per warm container and cached briefly, so onboarding
 * a customer takes effect without a deploy.
 */
"use strict";

const { appError } = require("./errors");

const REQUIRED_CUSTOMER_FIELDS = ["key", "secretName", "geotab"];

/** Structural validation. A broken config must never half-work. */
function validateConfig(config) {
  if (!config || typeof config !== "object") throw appError("INTERNAL", "The configuration object is empty.");
  if (config.schemaVersion !== 1) {
    throw appError("INTERNAL", `Unsupported configuration schemaVersion: ${config.schemaVersion}`);
  }
  if (!config.addIn || typeof config.addIn !== "object") throw appError("INTERNAL", "The configuration has no addIn block.");
  if (!config.addIn.securityId || typeof config.addIn.securityId !== "object") {
    throw appError("INTERNAL", "The configuration has no addIn.securityId block.");
  }
  if (!config.customers || typeof config.customers !== "object") {
    throw appError("INTERNAL", "The configuration has no customers map.");
  }
  for (const [key, customer] of Object.entries(config.customers)) {
    for (const field of REQUIRED_CUSTOMER_FIELDS) {
      if (customer == null || customer[field] == null || customer[field] === "") {
        throw appError("INTERNAL", `Customer "${key}" is missing "${field}".`);
      }
    }
    if (!customer.geotab.database) throw appError("INTERNAL", `Customer "${key}" is missing geotab.database.`);
    if (typeof customer.enabled !== "boolean") {
      throw appError("INTERNAL", `Customer "${key}" must set enabled to true or false.`);
    }
    if (customer.license != null && typeof customer.license.licensed !== "boolean") {
      throw appError("INTERNAL", `Customer "${key}" has a license block without a boolean "licensed".`);
    }
  }
  return config;
}

function parseConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw appError("INTERNAL", `The configuration is not valid JSON: ${error.message}`);
  }
  return validateConfig(parsed);
}

/**
 * @param {object} options
 * @param {() => Promise<string>} options.load   reads the raw object
 * @param {number} [options.ttlMs]               cache lifetime (0 disables caching)
 * @param {() => number} [options.now]
 */
function createConfigStore(options) {
  const ttlMs = options.ttlMs == null ? 60000 : options.ttlMs;
  const now = options.now || (() => Date.now());
  const logger = options.logger;
  let cached = null;
  let cachedAt = 0;

  async function get() {
    if (cached && ttlMs > 0 && now() - cachedAt < ttlMs) return cached;
    const text = await options.load();
    cached = parseConfig(text);
    cachedAt = now();
    if (logger) logger.debug("configuration loaded", { customers: Object.keys(cached.customers).length });
    return cached;
  }

  /** @throws AppError DATABASE_NOT_ONBOARDED when the tenant is unknown or disabled. */
  async function getCustomer(database) {
    if (!database) throw appError("BAD_REQUEST", "No Geotab database was supplied.");
    const config = await get();
    const customer = config.customers[database];
    if (!customer) {
      throw appError("DATABASE_NOT_ONBOARDED", `Geotab database "${database}" is not onboarded for scheduled unassign.`);
    }
    if (customer.enabled !== true) {
      throw appError("DATABASE_NOT_ONBOARDED", `Geotab database "${database}" is disabled for scheduled unassign.`);
    }
    return { config, customer };
  }

  function invalidate() {
    cached = null;
    cachedAt = 0;
  }

  return { get, getCustomer, invalidate };
}

module.exports = { createConfigStore, parseConfig, validateConfig };
