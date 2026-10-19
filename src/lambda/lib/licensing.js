/*
 * Scheduled Driver Unassign - licensing and staff detection
 * AdvantageOne
 *
 * Two separate questions, both answered from data rather than from code:
 *
 *   staff   is the caller's email domain one of Advantage One's own? Staff may
 *           set up a database (seed the worker credentials) and are never
 *           blocked by licensing.
 *   licensed  does this Geotab database have a license record in the deployment
 *           configuration? Everything else the tenant can do depends on it.
 *
 * The domains default to Advantage One's, and a deployment can override them
 * with a `licensing` block in config/customers.json:
 *   "licensing": { "staffDomains": ["advtracking.net", "advantageone.tech"], "enforce": true }
 * `enforce: false` keeps the license visible to the add-in but stops the service
 * from rejecting unlicensed callers.
 */
"use strict";

const DEFAULT_STAFF_DOMAINS = ["advtracking.net", "advantageone.tech"];

/** The domain part of a MyGeotab user name, lowercased; "" when there is none. */
function emailDomain(userName) {
  const value = String(userName || "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at === -1 || at === value.length - 1) return "";
  return value.slice(at + 1);
}

function licensingSettings(config) {
  const block = (config && config.licensing) || {};
  const configured = Array.isArray(block.staffDomains)
    ? block.staffDomains.map((domain) => String(domain || "").trim().toLowerCase().replace(/^@/, "")).filter(Boolean)
    : [];
  return {
    staffDomains: configured.length ? configured : DEFAULT_STAFF_DOMAINS.slice(),
    enforce: block.enforce !== false
  };
}

/** Exact domain match — a suffix rule would let "not-advtracking.net" through. */
function isStaff(userName, settings) {
  const domain = emailDomain(userName);
  return { domain, staff: domain !== "" && (settings ? settings.staffDomains : DEFAULT_STAFF_DOMAINS).includes(domain) };
}

/**
 * What the configuration says about one database. Never throws: an unknown
 * database is simply not onboarded, which is exactly what a staff member
 * setting one up needs to see.
 */
function readLicense(config, database) {
  const customer = (config && config.customers && config.customers[database]) || null;
  const license = (customer && customer.license) || null;
  return {
    onboarded: Boolean(customer),
    licensed: Boolean(license && license.licensed === true),
    licenseId: (license && license.licenseId) || null,
    enabled: Boolean(customer && customer.enabled === true),
    workerConfigured: Boolean(customer && customer.secretName),
    workerUserName: (customer && customer.workerUserName) || null,
    timeZone: (customer && customer.timeZone) || null,
    server: (customer && customer.geotab && customer.geotab.server) || null,
    customer: customer || null
  };
}

/** The license block written when a database is licensed. */
function licenseRecord(options) {
  const settings = options || {};
  return {
    licensed: settings.licensed !== false,
    source: settings.source || "unknown",
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
    notes: settings.notes || ""
  };
}

module.exports = { DEFAULT_STAFF_DOMAINS, emailDomain, licensingSettings, isStaff, readLicense, licenseRecord };
