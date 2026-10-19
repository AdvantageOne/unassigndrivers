#!/usr/bin/env node
/*
 * Scheduled Driver Unassign - add-in build
 * AdvantageOne
 *
 * The MyGeotab add-in ships as one self-contained HTML file (it is loaded from
 * jsDelivr pinned to a release tag), but the code that also runs inside the
 * Lambda must exist exactly once. This script is that bridge: it copies the
 * sources at src/core/unassign-core.js and src/addin/api-client.js into the
 * marked regions of unassignDrivers.html.
 *
 *   node build/inline-core.mjs            # regenerate the add-in
 *   node build/inline-core.mjs --check    # exit 1 if the add-in is stale (used by tests)
 *
 * The regions are delimited by their own lines:
 *   / * BUILD:core:begin * /  ... / * BUILD:core:end * /
 *   / * BUILD:client:begin * / ... / * BUILD:client:end * /
 * Everything between the markers is replaced, byte for byte, by the source file.
 * Each source file must end with a newline; the region is rendered as
 * "<begin>\n<source><end>". Run with --check in CI and after any edit to a
 * source file, and never hand-edit a generated region.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REGIONS = [
  { label: "core", begin: "/* BUILD:core:begin */", end: "/* BUILD:core:end */", source: "src/core/unassign-core.js" },
  { label: "client", begin: "/* BUILD:client:begin */", end: "/* BUILD:client:end */", source: "src/addin/api-client.js" }
];

function parseArgs(argv) {
  const opts = { html: "unassignDrivers.html", check: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") opts.check = true;
    else if (arg === "--quiet") opts.quiet = true;
    else if (arg === "--html") opts.html = argv[++i];
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/** Replaces everything between the two marker strings, exclusive of both. */
function replaceRegion(html, region, content, sources) {
  const beginAt = html.indexOf(region.begin);
  const endAt = html.indexOf(region.end);
  if (beginAt === -1) throw new Error(`marker not found in add-in: ${region.begin}`);
  if (endAt === -1) throw new Error(`marker not found in add-in: ${region.end}`);
  if (endAt < beginAt) throw new Error(`end marker precedes begin marker for region "${region.label}"`);
  const head = html.slice(0, beginAt + region.begin.length);
  const tail = html.slice(endAt);
  const next = head + "\n" + content + tail;
  return { html: next, changed: next !== html, previous: html.slice(beginAt + region.begin.length, endAt) };
}

function readSource(relativePath) {
  const absolute = resolve(ROOT, relativePath);
  const content = readFileSync(absolute, "utf8");
  if (!content) throw new Error(`source is empty: ${relativePath}`);
  if (!content.endsWith("\n")) throw new Error(`source must end with a newline: ${relativePath}`);
  if (content.includes("BUILD:core:begin") || content.includes("BUILD:client:end")) {
    throw new Error(`source must not contain build markers: ${relativePath}`);
  }
  return { absolute, content };
}

function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log("usage: node build/inline-core.mjs [--check] [--quiet] [--html <path>]");
    return 0;
  }
  const htmlPath = resolve(ROOT, opts.html);
  const original = readFileSync(htmlPath, "utf8");
  let html = original;
  const changed = [];

  for (const region of REGIONS) {
    const source = readSource(region.source);
    const result = replaceRegion(html, region, source.content);
    html = result.html;
    if (result.changed) changed.push(region.label);
  }

  if (opts.check) {
    if (changed.length) {
      console.error(`add-in is stale: ${changed.join(", ")} region(s) differ from src/. Run: node build/inline-core.mjs`);
      return 1;
    }
    if (!opts.quiet) console.log(`add-in up to date (${original.length} bytes)`);
    return 0;
  }

  if (!changed.length) {
    if (!opts.quiet) console.log(`add-in already up to date (${original.length} bytes)`);
    return 0;
  }
  writeFileSync(htmlPath, html);
  if (!opts.quiet) {
    console.log(`updated ${opts.html}: ${changed.join(", ")} (${original.length} -> ${html.length} bytes)`);
  }
  return 0;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  console.error(`build failed: ${error.message}`);
  process.exitCode = 2;
}
