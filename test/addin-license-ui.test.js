/*
 * The add-in's licence flow, driven through the real UI script with a stub DOM
 * and a stub client.
 *
 * This exists because two bugs in this flow were only visible in a browser: the
 * licence answer arrived (staff: true, setupAllowed: true) and the page then hid
 * the setup panel behind the "contact your CSR" overlay, because the schedules
 * call that followed failed with DATABASE_NOT_ONBOARDED — the very state the
 * panel fixes. Node-only tests could not see it; this harness can.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const core = require("../src/core/unassign-core");

const HTML = join(__dirname, "..", "unassignDrivers.html");
const realSetTimeout = setTimeout;

const STAFF = "matt@advtracking.net";
const TENANT = "admin@customer.com";
const EVERYTHING = { id: "u1", securityGroups: [{ id: "GroupEverythingSecurityId" }] };

const LICENSED_NOT_REGISTERED = { staff: true, setupAllowed: true, licensed: false, onboarded: false, workerConfigured: false };
const STAFF_REGISTERED = { staff: true, setupAllowed: true, licensed: true, onboarded: true, workerConfigured: true };
const TENANT_LICENSED = { staff: false, setupAllowed: false, licensed: true, onboarded: true, workerConfigured: true };
const TENANT_UNLICENSED = { staff: false, setupAllowed: false, licensed: false, onboarded: true, workerConfigured: true };

function uiSource(baseUrl) {
  const html = readFileSync(HTML, "utf8");
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(blocks.length, 3, "the add-in has three script blocks");
  let source = blocks[2];
  if (baseUrl === "") source = source.replace(/var SERVER_API_BASE = "[^"]*";/, 'var SERVER_API_BASE = "";');
  return source;
}

/**
 * A permissive element: any id resolves, so the harness cannot fail on markup.
 * The add-in looks its elements up inside its own root (`root.querySelector`),
 * so every lookup must land on the same object the assertions read.
 */
function fakeElement(id, registry) {
  const classes = new Set(["a1ud-hidden"]);
  const counters = { listeners: 0 };
  return {
    id,
    get listeners() { return counters.listeners; },
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    disabled: false,
    options: [],
    title: "",
    parentNode: { classList: { add: () => {}, remove: () => {} }, title: "" },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, on) => {
        if (on === undefined) return classes.has(name) ? classes.delete(name) : classes.add(name);
        return on ? classes.add(name) : classes.delete(name);
      }
    },
    querySelector: (selector) => registry(String(selector).replace(/^#/, "")),
    querySelectorAll: () => [],
    addEventListener: () => { counters.listeners += 1; },
    insertAdjacentHTML: () => {},
    getAttribute: () => null,
    setAttribute: () => {}
  };
}

function load(options) {
  const settings = options || {};
  const elements = new Map();
  const calls = { license: 0, listSchedules: 0, saveWorkerCredentials: 0 };
  const started = [];

  const element = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id, element));
    return elements.get(id);
  };
  const visible = (id) => !element(id).classList.contains("a1ud-hidden");

  const errors = settings.errors || {};
  const client = {
    license: async () => {
      calls.license += 1;
      if (errors.license) throw errors.license;
      return settings.license || TENANT_LICENSED;
    },
    listSchedules: async () => {
      calls.listSchedules += 1;
      if (errors.listSchedules) throw errors.listSchedules;
      return settings.schedules || { schedules: [] };
    },
    saveWorkerCredentials: async () => {
      calls.saveWorkerCredentials += 1;
      return settings.saved || { name: "unassign/db" };
    },
    addRun: async () => ({}),
    deleteSchedule: async () => ({}),
    createSchedule: async () => ({}),
    updateSchedule: async () => ({}),
    unassign: async () => ({ unassigned: 0, skipped: 0, failed: 0, stillAssigned: 0 }),
    listAssignments: async () => ({ rows: [] }),
    health: async () => ({})
  };

  const api = {
    call: (method, params, ok) => ok(params && params.typeName === "User" ? [EVERYTHING] : []),
    multiCall: (calls_, ok) => ok(calls_.map(() => [])),
    getSession: (callback) => callback({ userName: settings.userName || STAFF, database: "advone_matt_dev1", server: "my.geotab.com" })
  };

  const geotab = { addin: {} };
  const document = {
    hidden: false,
    getElementById: (id) => element(id),
    querySelector: (selector) => element(String(selector).replace(/^#/, "")),
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => fakeElement("created"),
    head: { appendChild: () => {} }
  };

  const sandbox = {
    geotab,
    A1UnassignCore: core,
    A1UnassignApi: { create: () => client, textFor: (error) => (error && error.message) || "failed", ERROR_TEXT: {} },
    document,
    window: {},
    navigator: {},
    console: { warn: () => {}, log: () => {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0
  };

  const factory = new Function(
    "geotab", "A1UnassignCore", "A1UnassignApi", "document", "window", "navigator", "setInterval", "clearInterval", "setTimeout", "console",
    `${uiSource(settings.baseUrl === undefined ? "https://example.lambda-url.ca-central-1.on.aws" : settings.baseUrl)}
     return geotab.addin.unassignDrivers ? geotab.addin.unassignDrivers() : null;`
  );
  const addin = factory(
    sandbox.geotab, sandbox.A1UnassignCore, sandbox.A1UnassignApi, sandbox.document, sandbox.window, sandbox.navigator,
    sandbox.setInterval, sandbox.clearInterval, sandbox.setTimeout, sandbox.console
  );

  /** MyGeotab hands the add-in a brand-new page element when the user returns. */
  const rebuild = () => { elements.set("unassignDrivers", fakeElement("unassignDrivers", element)); };

  return { addin, api, calls, element, visible, rebuild, settings };
}

/** initialize() resolves its callback before startServerMode() finishes. */
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => realSetTimeout(resolve, 0));
}

async function start(options) {
  const harness = load(options);
  await new Promise((resolve) => harness.addin.initialize(harness.api, {}, resolve));
  await settle();
  return harness;
}

test("staff on a database with no service account get the setup panel, not the overlay", async () => {
  const h = await start({ license: LICENSED_NOT_REGISTERED, errors: { listSchedules: { code: "DATABASE_NOT_ONBOARDED", message: "not onboarded" } } });
  assert.equal(h.calls.license, 1);
  assert.equal(h.calls.listSchedules, 0, "nothing to list yet: asking only earns a refusal");
  assert.equal(h.visible("a1ud-app"), true);
  assert.equal(h.visible("a1ud-setup-card"), true, "the panel that fixes this must be on screen");
  assert.equal(h.visible("a1ud-license-modal"), false, "a missing registration is not a licence problem");
  assert.match(h.element("a1ud-worker-state").textContent, /No service account is configured yet/);
  assert.match(h.element("a1ud-schedules-msg").textContent, /save a service account above/);
});

test("staff on a registered database keep the setup panel and see their schedules", async () => {
  const h = await start({ license: STAFF_REGISTERED });

  assert.equal(h.calls.listSchedules, 1);
  assert.equal(h.visible("a1ud-setup-card"), true);
  assert.equal(h.visible("a1ud-license-modal"), false);
  assert.match(h.element("a1ud-worker-state").textContent, /already configured/);
});

test("a licensed tenant gets the app, no setup panel and no overlay", async () => {
  const h = await start({ license: TENANT_LICENSED, userName: TENANT });

  assert.equal(h.calls.listSchedules, 1);
  assert.equal(h.visible("a1ud-app"), true);
  assert.equal(h.visible("a1ud-setup-card"), false);
  assert.equal(h.visible("a1ud-license-modal"), false);
});

test("an unlicensed tenant gets the overlay and no schedule request", async () => {
  const h = await start({ license: TENANT_UNLICENSED, userName: TENANT });

  assert.equal(h.visible("a1ud-license-modal"), true);
  assert.equal(h.visible("a1ud-app"), false);
  assert.equal(h.calls.listSchedules, 0);
});

test("a licence refusal from any action raises the overlay", async () => {
  const h = await start({
    license: STAFF_REGISTERED,
    errors: { listSchedules: { code: "LICENSE_REQUIRED", message: "not licensed" } }
  });

  assert.equal(h.calls.listSchedules, 1);
  assert.equal(h.visible("a1ud-license-modal"), true);
  assert.equal(h.visible("a1ud-app"), false);
});

test("a missing registration from an action leaves the page and the panel alone", async () => {
  const h = await start({
    license: STAFF_REGISTERED,
    errors: { listSchedules: { code: "DATABASE_NOT_ONBOARDED", message: "not onboarded" } }
  });

  assert.equal(h.visible("a1ud-license-modal"), false, "the overlay must not cover the setup panel");
  assert.equal(h.visible("a1ud-setup-card"), true);
  assert.equal(h.visible("a1ud-app"), true);
});

test("a failed licence check leaves the page usable and shows no overlay", async () => {
  const h = await start({ errors: { license: new Error("Failed to fetch") } });

  assert.equal(h.calls.license, 1);
  assert.equal(h.visible("a1ud-license-modal"), false);
  assert.equal(h.visible("a1ud-app"), true);
  assert.equal(h.calls.listSchedules, 1, "with no answer, the app still tries to list schedules");
});

test("legacy mode never calls the service and reveals nothing new", async () => {
  const h = await start({ baseUrl: "", license: STAFF_REGISTERED });

  assert.equal(h.calls.license, 0);
  assert.equal(h.calls.listSchedules, 0);
  assert.equal(h.visible("a1ud-license-modal"), false);
  assert.equal(h.visible("a1ud-setup-card"), false);
});

test("the licence decision is re-applied when MyGeotab rebuilds the page", async () => {
  const h = await start({ license: LICENSED_NOT_REGISTERED });
  assert.equal(h.visible("a1ud-setup-card"), true);
  const boundBefore = h.element("a1ud-worker-save").listeners;

  // A rebuild hands back a new page element with everything inside it hidden
  // again, so the decisions and the listeners both have to be made again.
  h.rebuild();
  h.element("a1ud-setup-card").classList.add("a1ud-hidden");
  h.element("a1ud-license-modal").classList.add("a1ud-hidden");
  await h.addin.focus(h.api);
  await settle();

  assert.equal(h.visible("a1ud-setup-card"), true, "focus must restore the staff view");
  assert.ok(h.element("a1ud-worker-save").listeners > boundBefore, "the rebuilt controls must be rebound");
  assert.equal(h.calls.license, 2);
});
