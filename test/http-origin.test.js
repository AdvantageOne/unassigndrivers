/*
 * Origin policy. The add-in runs in a frame served from a MyGeotab host, and
 * those hosts are geotab.com subdomains, so the allow-list needs patterns — and
 * the Function URL API cannot express them, which is why this matcher is the
 * authority. The suffix cases below are the ones a naive `endsWith` gets wrong.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isOriginAllowed, originMatches, probeOrigin } = require("../src/lambda/http");

const GEOTAB = ["https://*.geotab.com"];

test("an exact origin matches", () => {
  assert.ok(originMatches("https://my.geotab.com", "https://my.geotab.com"));
  assert.ok(isOriginAllowed("https://my.geotab.com", ["https://my.geotab.com"]));
});

test("a wildcard covers subdomains of the domain", () => {
  for (const origin of [
    "https://my.geotab.com",
    "https://myg-static.geotab.com",
    "https://eu.geotab.com",
    "https://a.b.geotab.com",
    "https://MY.GEOTAB.COM"
  ]) {
    assert.ok(isOriginAllowed(origin, GEOTAB), `${origin} must be allowed`);
  }
});

test("a wildcard does not leak to look-alike hosts or other schemes", () => {
  for (const origin of [
    "https://evil-geotab.com",
    "https://notgeotab.com",
    "https://geotab.com.evil.com",
    "https://geotab.com",
    "http://my.geotab.com",
    "https://my.geotab.com.evil.com",
    "https://evil.com/https://my.geotab.com"
  ]) {
    assert.equal(isOriginAllowed(origin, GEOTAB), false, `${origin} must be refused`);
  }
  assert.equal(originMatches("https://*.geotab.com", "https://my.geotab.com/x"), false, "a path must not match");
});

test("several entries and the bare wildcard both work", () => {
  const list = ["https://my.geotab.com", "https://*.advone.example"];
  assert.ok(isOriginAllowed("https://my.geotab.com", list));
  assert.ok(isOriginAllowed("https://x.advone.example", list));
  assert.equal(isOriginAllowed("https://y.geotab.com", list), false, "not in this list");
  assert.ok(isOriginAllowed("https://anything.example", ["*"]));
});

test("a request without an Origin is allowed (server to server)", () => {
  assert.ok(isOriginAllowed(null, GEOTAB));
  assert.ok(isOriginAllowed(undefined, []));
});

test("an empty allow-list refuses every browser origin", () => {
  assert.equal(isOriginAllowed("https://my.geotab.com", []), false);
  assert.equal(isOriginAllowed("https://my.geotab.com", null), false);
});

test("trailing slashes in a pattern or an origin do not matter", () => {
  assert.ok(isOriginAllowed("https://my.geotab.com/", ["https://*.geotab.com"]));
  assert.ok(isOriginAllowed("https://my.geotab.com", ["https://*.geotab.com/"]));
});

test("a pattern becomes a concrete origin for the CORS probe", () => {
  assert.equal(probeOrigin("https://*.geotab.com"), "https://my.geotab.com");
  assert.equal(probeOrigin("https://my.geotab.com"), "https://my.geotab.com");
  assert.equal(probeOrigin("*"), "https://my.geotab.com");
  assert.equal(probeOrigin(""), "https://my.geotab.com");
  assert.ok(isOriginAllowed(probeOrigin("https://*.geotab.com"), GEOTAB), "the probe origin must satisfy the policy");
});
