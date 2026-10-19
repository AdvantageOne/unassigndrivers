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

function addinHtml() {
  return readFileSync(HTML, "utf8");
}

/** The ids the markup ships hidden, so the harness starts where a browser does. */
function hiddenInMarkup(html) {
  const hidden = new Set();
  for (const match of html.matchAll(/<[a-z]+[^>]*>/g)) {
    const tag = match[0];
    const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
    if (!id) continue;
    // The class may sit on either side of the id.
    const classes = (tag.match(/class="([^"]*)"/) || [])[1] || "";
    if (/a1ud-hidden/.test(classes)) hidden.add(id);
  }
  return hidden;
}

function uiSource(html, baseUrl) {
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
function fakeElement(id, registry, hidden) {
  const classes = new Set(hidden ? ["a1ud-hidden"] : []);
  const counters = { listeners: 0 };
  const handlers = {};
  const element = {
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
    // `#id` lookups are page-wide (that is how the add-in resolves its own
    // elements from the root); a tag lookup belongs to the element it is made on,
    // so the history table's tbody is not the preview table's.
    querySelector: (selector) => {
      const value = String(selector);
      return value.startsWith("#") ? registry(value.slice(1)) : registry(`${id} ${value}`);
    },
    querySelectorAll: () => [],
    addEventListener: (type, handler) => {
      counters.listeners += 1;
      (handlers[type] || (handlers[type] = [])).push(handler);
    },
    /** Drives the bound handlers, the way a click on the real button would. */
    fire: (type) => {
      const event = { target: element, preventDefault: () => {}, stopPropagation: () => {} };
      (handlers[type] || []).forEach((handler) => handler(event));
    },
    insertAdjacentHTML: () => {},
    getAttribute: () => null,
    setAttribute: () => {}
  };
  return element;
}

function load(options) {
  const settings = options || {};
  const elements = new Map();
  const calls = { license: 0, listSchedules: 0, listRuns: 0, saveWorkerCredentials: 0 };
  const started = [];

  const html = addinHtml();
  const hiddenAtStart = hiddenInMarkup(html);
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id, element, hiddenAtStart.has(id)));
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
      return settings.saved || { name: "unassign/advone_matt_dev1/serviceaccount" };
    },
    addRun: async () => ({}),
    deleteSchedule: async () => ({}),
    createSchedule: async () => ({}),
    updateSchedule: async () => ({}),
    unassign: async () => ({ unassigned: 0, skipped: 0, failed: 0, stillAssigned: 0 }),
    listAssignments: async () => ({ rows: [] }),
    // The deployment's own record of what it ran, merged into the history.
    listRuns: async () => {
      calls.listRuns += 1;
      if (errors.listRuns) throw errors.listRuns;
      return settings.runs || { runs: [] };
    },
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
    createElement: () => fakeElement("created", element),
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
    `${uiSource(html, settings.baseUrl === undefined ? "https://example.lambda-url.ca-central-1.on.aws" : settings.baseUrl)}
     return geotab.addin.unassignDrivers ? geotab.addin.unassignDrivers() : null;`
  );
  const addin = factory(
    sandbox.geotab, sandbox.A1UnassignCore, sandbox.A1UnassignApi, sandbox.document, sandbox.window, sandbox.navigator,
    sandbox.setInterval, sandbox.clearInterval, sandbox.setTimeout, sandbox.console
  );

  /** MyGeotab hands the add-in a brand-new page element when the user returns. */
  const rebuild = () => { elements.set("unassignDrivers", fakeElement("unassignDrivers", element)); };
  const click = (id) => element(id).fire("click");

  return { addin, api, calls, click, element, visible, rebuild, settings };
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
  assert.equal(h.visible("a1ud-tab-service"), true, "staff must land on the tab that holds the form");
  assert.equal(h.visible("a1ud-tab-scheduler"), false);
  assert.equal(h.visible("a1ud-license-modal"), false, "a missing registration is not a licence problem");
  assert.match(h.element("a1ud-worker-state").textContent, /No service account is configured yet/);
  assert.match(h.element("a1ud-schedules-msg").textContent, /save a service account above/);
});

test("staff on a registered database keep the setup panel and see their schedules", async () => {
  const h = await start({ license: STAFF_REGISTERED });

  assert.equal(h.calls.listSchedules, 1);
  assert.equal(h.visible("a1ud-setup-card"), true);
  assert.equal(h.visible("a1ud-license-modal"), false);
  assert.equal(h.visible("a1ud-tab-scheduler"), true, "a registered database opens on the scheduler");
  assert.equal(h.visible("a1ud-tab-service"), false);
  assert.match(h.element("a1ud-worker-state").textContent, /already configured/);
});

test("a licensed tenant gets the app, no setup panel and no overlay", async () => {
  const h = await start({ license: TENANT_LICENSED, userName: TENANT });

  assert.equal(h.calls.listSchedules, 1);
  assert.equal(h.visible("a1ud-app"), true);
  assert.equal(h.visible("a1ud-setup-card"), false);
  assert.equal(h.visible("a1ud-license-modal"), false);
  assert.equal(h.visible("a1ud-tab-scheduler"), true);
  assert.equal(h.visible("a1ud-tab-service"), false, "a customer has no credentials form to fill in");
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

test("saving the service account registers the database and hands back the schedules", async () => {
  const h = await start({ license: LICENSED_NOT_REGISTERED });
  assert.equal(h.visible("a1ud-tab-service"), true);

  h.element("a1ud-worker-user").value = "svc-unassign@example.com";
  h.element("a1ud-worker-pass").value = "correct horse battery";
  h.element("a1ud-worker-server").value = "my.geotab.com";
  h.element("a1ud-worker-license").checked = true;
  // The service now reports the database as registered and licensed.
  h.settings.license = STAFF_REGISTERED;

  h.click("a1ud-worker-save");
  await settle();

  assert.equal(h.calls.saveWorkerCredentials, 1);
  assert.equal(h.element("a1ud-worker-pass").value, "", "the password must not linger in the field");
  assert.equal(h.visible("a1ud-tab-scheduler"), true, "the user is handed their schedules");
  assert.equal(h.visible("a1ud-tab-service"), false);
  assert.equal(h.calls.listSchedules, 1);
});

test("the credentials form lives on the service tab, not mid-page on the scheduler", () => {
  const html = addinHtml();

  const block = (id) => {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > -1, `${id} is missing from the add-in`);
    const open = html.indexOf(">", at) + 1;
    let depth = 1;
    const tags = /<(\/?)div\b[^>]*>/g;
    tags.lastIndex = open;
    let match;
    while ((match = tags.exec(html))) {
      depth += match[1] ? -1 : 1;
      if (depth === 0) return html.slice(open, match.index);
    }
    return assert.fail(`unbalanced markup around ${id}`);
  };

  const service = block("a1ud-tab-service");
  assert.match(service, /id="a1ud-setup-card"/, "the setup panel must be on the tab named after it");
  assert.match(service, /id="a1ud-worker-user"/);
  assert.match(service, /id="a1ud-worker-pass"/);
  assert.match(service, /id="a1ud-worker-save"/);
  assert.doesNotMatch(block("a1ud-tab-scheduler"), /id="a1ud-setup-card"/, "not buried under the scheduler");
  assert.match(html, /Please contact your CSR to enable your license/);
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

test("the run history shows what the deployment ran, with its counts", async () => {
  const h = await start({
    license: STAFF_REGISTERED,
    runs: {
      runs: [
        { at: "2026-10-16T22:00:03.000Z", occurrence: "2026-10-16T22:00:00.000Z", trigger: "scheduled", by: "Unassign Service", outcome: "ran", unassigned: 10 },
        { at: "2026-10-16T23:00:03.000Z", occurrence: "2026-10-16T23:00:00.000Z", trigger: "scheduled", by: "Unassign Service", outcome: "failed", code: "GEOTAB_ERROR", reason: "MyGeotab said no" }
      ]
    }
  });

  assert.equal(h.calls.listRuns, 1, "the add-in asks the deployment in server mode");
  const html = h.element("a1ud-history tbody").innerHTML;
  assert.match(html, /MyGeotab said no/, "an attempt that never reached Geotab is visible");
  assert.match(html, /<td>10<\/td>/, "and a scheduled run reports its counts");
  assert.equal((html.match(/Unassign Service/g) || []).length, 2, "one row per run, newest first");
});

test("a deployment without the run history still renders the tenant's own", async () => {
  const h = await start({ license: STAFF_REGISTERED, errors: { listRuns: { code: "BAD_REQUEST", message: "Unknown action" } } });
  assert.equal(h.calls.listRuns, 1);
  assert.match(h.element("a1ud-history tbody").innerHTML, /No runs yet/, "no rows, no crash");
});

/* ---------------- the header: when this database's schedule runs ---------------- */

const DAILY_2300 = {
  name: "all-2300-abcd1234",
  kind: "recurring", mode: "daily", time: "23:00", days: [],
  timeZone: "America/Edmonton", state: "ENABLED", nextRun: "2026-10-20T05:00:00.000Z"
};

test("the header names the time the deployment's schedule runs", async () => {
  const h = await start({ license: TENANT_LICENSED, userName: TENANT, schedules: { database: "advone_matt_dev1", schedules: [DAILY_2300] } });

  assert.equal(h.calls.listSchedules, 1);
  const next = h.element("a1ud-next").textContent;
  assert.doesNotMatch(next, /Managed on AWS|Not scheduled/, "the schedule that fires is the one to show");
  assert.match(h.element("a1ud-countdown").textContent, /^in \d/, "and how long until it does");
  assert.match(h.element("a1ud-countdown").textContent, /every day at 23:00/);
  assert.equal(h.element("a1ud-state").textContent, "Armed");
});

test("the soonest of this database's schedules is the one shown", async () => {
  const h = await start({
    license: TENANT_LICENSED,
    userName: TENANT,
    schedules: {
      schedules: [
        { name: "later", kind: "one-time", state: "ENABLED", nextRun: "2026-12-24T08:00:00.000Z" },
        { name: "soon", kind: "recurring", mode: "daily", time: "21:15", days: [], timeZone: "UTC", state: "ENABLED" }
      ]
    }
  });

  const countdown = h.element("a1ud-countdown").textContent;
  assert.match(countdown, /every day at 21:15/, "a daily schedule is sooner than a one-off next month");
  assert.doesNotMatch(countdown, /one-time/);
});

test("a one-time run is shown, and one already in the past is not", async () => {
  const ahead = await start({
    license: TENANT_LICENSED,
    userName: TENANT,
    schedules: { schedules: [{ name: "run-20261120T080000Z-ab12cd34", kind: "one-time", state: "ENABLED", nextRun: "2026-11-20T08:00:00.000Z" }] }
  });
  assert.match(ahead.element("a1ud-countdown").textContent, /a one-time run/);

  const past = await start({
    license: TENANT_LICENSED,
    userName: TENANT,
    schedules: { schedules: [{ name: "run-old", kind: "one-time", state: "ENABLED", nextRun: "2020-01-01T00:00:00.000Z" }] }
  });
  assert.equal(past.element("a1ud-next").textContent, "No upcoming run");
  assert.match(past.element("a1ud-countdown").textContent, /Nothing is due/);
});

test("a disabled schedule is reported as turned off, never as a time to come", async () => {
  const h = await start({
    license: TENANT_LICENSED,
    userName: TENANT,
    schedules: { schedules: [Object.assign({}, DAILY_2300, { state: "DISABLED" })] }
  });

  assert.equal(h.element("a1ud-next").textContent, "No upcoming run");
  assert.match(h.element("a1ud-countdown").textContent, /turned off/);
  assert.equal(h.element("a1ud-state").textContent, "Idle");
});

test("with nothing scheduled, the header says so", async () => {
  const h = await start({ license: TENANT_LICENSED, userName: TENANT });

  assert.equal(h.element("a1ud-next").textContent, "Not scheduled");
  assert.match(h.element("a1ud-countdown").textContent, /Nothing is scheduled for this database yet/);
});

test("an unregistered database is told what the state is, not given a time", async () => {
  const h = await start({ license: LICENSED_NOT_REGISTERED });

  assert.equal(h.element("a1ud-next").textContent, "Not scheduled");
  assert.match(h.element("a1ud-countdown").textContent, /not registered yet/);
});

test("a refused schedule list leaves the header claiming nothing", async () => {
  const h = await start({
    license: STAFF_REGISTERED,
    errors: { listSchedules: { code: "LICENSE_REQUIRED", message: "not licensed" } }
  });

  assert.equal(h.element("a1ud-next").textContent, "Managed on AWS", "no time when the answer never came");
});

test("saving a schedule puts its time in the header without a reload", async () => {
  const h = await start({ license: TENANT_LICENSED, userName: TENANT });
  assert.equal(h.element("a1ud-next").textContent, "Not scheduled");

  h.element("a1ud-enabled").checked = true;
  h.element("a1ud-mode").value = "daily";
  h.element("a1ud-time").value = "22:45";
  h.element("a1ud-tz").value = "UTC";
  h.settings.schedules = { schedules: [{ name: "all-2245-abcd1234", kind: "recurring", mode: "daily", time: "22:45", days: [], timeZone: "UTC", state: "ENABLED" }] };

  h.click("a1ud-save");
  await settle();

  assert.equal(h.calls.listSchedules, 2, "the save re-reads what the deployment now holds");
  assert.match(h.element("a1ud-countdown").textContent, /every day at 22:45/);
});

/* ---------------- the schedule table's columns ---------------- */

test("the table says whether driving assets are skipped, per schedule", async () => {
  const h = await start({
    license: TENANT_LICENSED,
    userName: TENANT,
    schedules: {
      schedules: [
        Object.assign({}, DAILY_2300, { skipDriving: true }),
        { name: "all-0600-ffff0000", kind: "recurring", mode: "daily", time: "06:00", days: [], timeZone: "UTC", skipDriving: false },
        { name: "run-20261120T080000Z-ab12cd34", kind: "one-time", nextRun: "2026-11-20T08:00:00.000Z" }
      ]
    }
  });

  const rows = h.element("a1ud-schedules tbody").innerHTML;
  assert.equal((rows.match(/class="a1ud-tag is-yes">Yes</g) || []).length, 2, "two schedules skip driving assets");
  assert.match(rows, /class="a1ud-tag">No</, "and one does not");
  // The flag is a plan property, so it shows for a one-time run too: absent in
  // the payload means the default, which is to skip.
  assert.equal((rows.match(/<td>/g) || []).length, 3 * 6, "six cells per row, no more");
});

test("the schedules table has no enabled column, and keeps its shape", () => {
  const html = addinHtml();
  const start_ = html.indexOf('id="a1ud-schedules"');
  const head = html.slice(start_, html.indexOf("</thead>", start_));

  assert.match(head, /<th title="Skip assets that are driving at run time">Skip driving<\/th>/);
  assert.doesNotMatch(head, /<th>State<\/th>/, "creating a schedule is what enables it");
  // The empty state and the row renderer both write six cells, so the header
  // must keep six columns.
  assert.equal((head.match(/<th[ >]/g) || []).length, 6, "one header cell per column");
  assert.match(html.slice(start_, html.indexOf("</table>", start_)), /<th>When<\/th>/);
});
