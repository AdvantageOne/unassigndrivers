/*
 * Scheduled Driver Unassign - the run log
 * AdvantageOne
 *
 * One small object per database in the deployment's config bucket, recording
 * every run *attempt* this service made — scheduled by EventBridge or triggered
 * by the add-in:
 *
 *   runs/<database>.json
 *   { schemaVersion, database, runs: [
 *       { at, occurrence, trigger, by, outcome, unassigned, skipped, failed,
 *         stillAssigned, code, reason, requestId } ] }
 *
 * The tenant's own MyGeotab database holds a run's *detail* — the add-in's Run
 * history reads that from AddInData. This is the other half of the answer: was
 * the scheduled task run at all, and how did it end. That matters most for the
 * attempts that never reached Geotab (a licence refusal, a database this
 * deployment does not know, a MyGeotab outage), which leave no trace there, and
 * for confirming from AWS that a slot fired.
 *
 * Only counts, never rows: the detail belongs in the tenant's log, and this
 * object is read on every history request.
 *
 * Recording is best effort by design — a run is not failed because its record
 * could not be written; CloudWatch still has it.
 */
"use strict";

const { createConfigWriter } = require("./config-writer");

/** Kept in step with the add-in's own cap on its Run history. */
const MAX_RUNS = 40;

/** The vocabulary the handler already logs with, so both agree. */
const RUN_OUTCOMES = ["ran", "idle", "checked", "failed", "denied", "disabled"];

function keyFor(prefix, database) {
  return `${prefix || "runs/"}${database}.json`;
}

function emptyLog(database) {
  return { schemaVersion: 1, database: database || null, runs: [] };
}

/**
 * Tolerant on read: a damaged object must not break the history endpoint, and a
 * database with no runs yet is the normal first state.
 */
function parseLog(text, database) {
  if (!text) return emptyLog(database);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return emptyLog(database);
  }
  if (!parsed || !Array.isArray(parsed.runs)) return emptyLog(database);
  return {
    schemaVersion: parsed.schemaVersion || 1,
    database: parsed.database || database || null,
    runs: parsed.runs
  };
}

/** Newest first, capped — the tenant's log keeps the detail, this the answer. */
function addRun(log, run) {
  const runs = [run].concat((log && log.runs) || []).slice(0, MAX_RUNS);
  return { schemaVersion: 1, database: (log && log.database) || run.database || null, runs };
}

/** One attempt, from a run summary or from a failure. Every field present. */
function recordFor(input) {
  const source = input || {};
  const outcome = RUN_OUTCOMES.indexOf(source.outcome) !== -1 ? source.outcome : "ran";
  const count = (value) => (typeof value === "number" && value > 0 ? value : 0);
  return {
    at: source.at || new Date().toISOString(),
    database: source.database || null,
    occurrence: source.occurrence || null,
    trigger: source.trigger || "scheduled",
    by: source.by || null,
    outcome,
    unassigned: count(source.unassigned),
    skipped: count(source.skipped),
    failed: count(source.failed),
    stillAssigned: count(source.stillAssigned),
    code: source.code || null,
    reason: source.reason || null,
    requestId: source.requestId || null
  };
}

/**
 * The outcome word for a run summary, in one place so the record, the log line
 * and the tenant's entry cannot drift apart.
 */
function outcomeOf(summary) {
  if (!summary) return "ran";
  if (summary.skippedReason) return "idle";
  if (summary.dryRun) return "checked";
  // Counted, not tested for truthiness: the raw run result carries arrays, and
  // an empty one is truthy — which would report every clean run as failed.
  return countOf(summary, "failed") > 0 ? "failed" : "ran";
}

function normaliseInput(summary) {
  if (!summary) return {};
  if (Array.isArray(summary)) return { rows: summary };
  return summary;
}

function countOf(summary, key) {
  const value = normaliseInput(summary)[key];
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.length;
  if (value && Array.isArray(value.rows)) return value.rows.length;
  return 0;
}

/** What a finished run looks like as a record. */
function recordFromSummary(fields, summary) {
  return recordFor(
    Object.assign({}, fields, {
      outcome: outcomeOf(summary),
      unassigned: countOf(summary, "unassigned"),
      skipped: countOf(summary, "skipped"),
      failed: countOf(summary, "failed"),
      stillAssigned: countOf(summary, "stillAssigned")
    })
  );
}

function createRunLog(options) {
  const store = options.store;
  const prefix = options.prefix || "runs/";
  const logger = options.logger;
  const attempts = options.attempts;

  async function list(database, limit) {
    const current = await store.read(keyFor(prefix, database));
    const log = parseLog(current && current.text, database);
    return log.runs.slice(0, limit || MAX_RUNS);
  }

  async function record(run) {
    const entry = recordFor(run);
    if (!entry.database) return { recorded: false, reason: "no database" };
    const key = keyFor(prefix, entry.database);
    // One writer per call, keyed on this database: the shared writer only knows
    // how to read and write, so it is given those two bound to this object. The
    // ETag guard is what stops two concurrent runs dropping one another.
    const writer = createConfigWriter({
      read: () => store.read(key),
      write: (text, etag) => store.write(key, text, etag),
      parse: (text) => parseLog(text, entry.database),
      attempts
    });
    try {
      const result = await writer.mutate((log) => addRun(log, entry));
      return { recorded: true, attempts: result.attempts };
    } catch (error) {
      if (logger) {
        logger.warn("could not record the run in the run log", {
          outcome: "failed",
          code: (error && error.code) || "INTERNAL",
          reason: error && error.message,
          database: entry.database
        });
      }
      return { recorded: false, reason: error && error.message };
    }
  }

  return { list, record, keyFor: (database) => keyFor(prefix, database) };
}

module.exports = {
  MAX_RUNS,
  RUN_OUTCOMES,
  keyFor,
  emptyLog,
  parseLog,
  addRun,
  recordFor,
  recordFromSummary,
  outcomeOf,
  createRunLog
};
