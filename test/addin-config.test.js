/*
 * The MyGeotab add-in configurations shipped in the repo root.
 *
 * `config.ca.json` and `config.us.json` are what an operator pastes into each
 * region, so their URLs have to match the bucket the deploy publishes to
 * (scripts/lib/common.sh knows the same names) and the three files must agree
 * on everything MyGeotab sees except that URL — a customer must not be able to
 * tell which region they came from by the menu, the name or the support address.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const REGIONS = [
  { code: "ca", bucket: "advone-addin-hosting-ca-central-1", region: "ca-central-1" },
  { code: "us", bucket: "advone-addinhosting-us-east-2", region: "us-east-2" }
];

const read = (name) => JSON.parse(readFileSync(join(ROOT, name), "utf8"));

test("each region's add-in config points at that region's published page", () => {
  for (const { code, bucket, region } of REGIONS) {
    const config = read(`config.${code}.json`);
    const url = config.items[0].url;
    assert.equal(
      url,
      `https://${bucket}.s3.${region}.amazonaws.com/unassign/unassignDrivers.html`,
      `config.${code}.json must point at the bucket the deploy publishes to`
    );
    assert.match(url, /^https:\/\//, "MyGeotab serves add-ins over HTTPS; the page must be HTTPS");
    assert.equal(config.items[0].path, "AdministrationLink/");
    assert.equal(config.items.length, 1);
  }
});

test("the repo's config files differ only in where the page is served from", () => {
  const configs = [read("config.json"), read("config.ca.json"), read("config.us.json")];
  for (const config of configs) {
    assert.equal(config.name, "Scheduled Driver Unassign by Advantage One");
    assert.equal(config.supportEmail, "jordan@advtracking.net");
    assert.equal(config.isSigned, false);
    assert.equal(config.items[0].path, "AdministrationLink/");
    assert.deepEqual(config.items[0].menuName, {
      en: "Scheduled Driver Unassign",
      fr: "Désaffectation planifiée des conducteurs"
    });
  }
  // The two hosted copies are the same build of the page.
  assert.equal(read("config.ca.json").version, read("config.us.json").version);
});

/** Runs the deploy's own pure helpers, so the test checks behaviour, not source text. */
function shell(expressions) {
  return execFileSync("bash", ["-c", `. scripts/lib/common.sh\n${expressions}`], {
    cwd: ROOT,
    encoding: "utf8"
  }).trim();
}

test("each config names exactly the page the deploy publishes for its region", () => {
  for (const { code } of REGIONS) {
    const url = shell(
      `addin_object_url "$(region_field ${code} addin)" "$(region_field ${code} region)" "$(addin_object_key)"`
    );
    assert.equal(read(`config.${code}.json`).items[0].url, url, `config.${code}.json must match the deploy`);
  }
  assert.equal(shell('addin_object_key'), "unassign/unassignDrivers.html");
});

test("every language the config declares has a translations file beside the page", () => {
  const langs = shell("addin_translation_langs").split(/\s+/).filter(Boolean);
  assert.deepEqual(langs, Object.keys(read("config.ca.json").items[0].menuName).sort(), "same languages");
  for (const lang of langs) {
    const file = join(ROOT, "translations", `${lang}.json`);
    assert.ok(existsSync(file), `translations/${lang}.json must exist`);
    const map = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(typeof map, "object");
    // MyGeotab fetches these from beside the page: <page dir>/translations/<lang>.json
    assert.equal(shell(`addin_translation_key ${lang}`), `unassign/translations/${lang}.json`);
  }
});
