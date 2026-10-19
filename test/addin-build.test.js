/*
 * The add-in ships as one file from jsDelivr, but the code that also runs in the
 * Lambda lives in src/. This test is the guard against the two copies drifting
 * apart — the exact problem the legacy repo had, where 505 lines were
 * copy-pasted between the add-in and the runner with a build script that did
 * not exist.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const HTML = join(ROOT, "unassignDrivers.html");

function region(html, label) {
  const begin = `/* BUILD:${label}:begin */`;
  const end = `/* BUILD:${label}:end */`;
  const from = html.indexOf(begin);
  const to = html.indexOf(end);
  assert.ok(from !== -1 && to !== -1, `missing ${label} markers`);
  return html.slice(from + begin.length + 1, to);
}

test("the add-in is up to date with src/", () => {
  const output = execFileSync(process.execPath, ["build/inline-core.mjs", "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.match(output, /up to date/);
});

test("the inlined regions are byte-identical to their sources", () => {
  const html = readFileSync(HTML, "utf8");
  assert.equal(region(html, "core"), readFileSync(join(ROOT, "src/core/unassign-core.js"), "utf8"));
  assert.equal(region(html, "client"), readFileSync(join(ROOT, "src/addin/api-client.js"), "utf8"));
});

test("the sources never contain build markers", () => {
  for (const file of ["src/core/unassign-core.js", "src/addin/api-client.js"]) {
    const content = readFileSync(join(ROOT, file), "utf8");
    assert.equal(/BUILD:(core|client):(begin|end)/.test(content), false, `${file} must not contain markers`);
  }
});

test("the add-in exposes both globals and still registers the MyGeotab add-in", () => {
  const html = readFileSync(HTML, "utf8");
  assert.match(html, /root\.A1UnassignCore = api;/);
  assert.match(html, /root\.A1UnassignApi = api;/);
  assert.match(html, /geotab\.addin\.unassignDrivers = function/);
});

test("the build script refuses a file that has no markers", () => {
  let failure = null;
  try {
    execFileSync(process.execPath, ["build/inline-core.mjs", "--html", "docs/aws-lambda-eventbridge-port.md"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe"
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "the build must exit non-zero");
  assert.match(String(failure.stderr), /marker not found/);
});
