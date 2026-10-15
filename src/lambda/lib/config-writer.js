/*
 * Scheduled Driver Unassign - configuration writes
 * AdvantageOne
 *
 * The tenant registry in S3 is read by every request and written rarely (a staff
 * member setting up a database). Two Lambda containers can therefore race: the
 * writer always re-reads the object, keeps its ETag, and writes with `If-Match`,
 * retrying when someone else got there first. A stale write can never drop
 * another tenant's record.
 *
 * `read`  -> { text, etag }
 * `write` -> (text, etag) => { etag }, throwing a 412-shaped error on conflict
 */
"use strict";

const { appError } = require("./errors");
const { parseConfig } = require("./config-store");

const DEFAULT_ATTEMPTS = 5;

function isPreconditionFailure(error) {
  if (!error) return false;
  const name = error.name || error.code || "";
  if (name === "PreconditionFailed" || name === "412") return true;
  return Boolean(error.$metadata && error.$metadata.httpStatusCode === 412);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createConfigWriter(options) {
  const attempts = options.attempts || DEFAULT_ATTEMPTS;

  /**
   * Applies `mutator(config) -> nextConfig | null` under an ETag guard.
   * A null result means "nothing to change" and writes nothing.
   */
  async function mutate(mutator) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const current = await options.read();
      const parsed = parseConfig(current.text); // validated, so a broken object is never rewritten
      const next = await mutator(clone(parsed));
      if (!next) return { unchanged: true, attempts: attempt };
      const text = JSON.stringify(next, null, 2) + "\n";
      try {
        const written = await options.write(text, current.etag);
        return { config: next, etag: written && written.etag, attempts: attempt };
      } catch (error) {
        if (!isPreconditionFailure(error)) throw error;
      }
    }
    throw appError(
      "INTERNAL",
      `The configuration changed ${attempts} times while this request was writing; try again.`
    );
  }

  return { mutate };
}

module.exports = { createConfigWriter, isPreconditionFailure, DEFAULT_ATTEMPTS };
