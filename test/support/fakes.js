/*
 * Test doubles for the MyGeotab API, the AWS SDK adapters, and the add-in's
 * fetch. No network, no AWS, no Geotab tenant.
 */
"use strict";

const ADDIN_ID = "arpL4jyXrThGH7UuWmWZXDA";

/** A fetch that answers from a handler and records every call. */
function createFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const request = {
      url,
      method: (init && init.method) || "GET",
      body: init && init.body ? JSON.parse(init.body) : null,
      headers: (init && init.headers) || {}
    };
    calls.push(request);
    const reply = await handler(request);
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error(`unexpected fetch: ${request.method} ${url}`);
    const status = reply.status || 200;
    const body = reply.body === undefined ? reply : reply.body;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body))
    };
  };
  impl.calls = calls;
  return impl;
}

/** A fetch that speaks MyGeotab JSON-RPC: routes method -> result or {__error}. */
function createGeotabFetch(rpc) {
  return createFetch((request) => {
    if (!/\/apiv1$/.test(request.url)) throw new Error(`unexpected url ${request.url}`);
    const result = rpc(request.body.method, request.body.params);
    if (result && result.__error) return { body: { jsonrpc: "2.0", id: null, error: result.__error } };
    return { body: { jsonrpc: "2.0", id: null, result } };
  });
}

/** Minimal in-memory MyGeotab that the shared core can drive through call/multiCall. */
function createCoreApi(options) {
  const settings = options || {};
  // Fixtures are shared between tests, so each fake gets its own copy: a write
  // performed by one test must never change what the next test sees.
  const state = {
    devices: clone(settings.devices) || [
      { id: "b1", name: "Truck 1" },
      { id: "b2", name: "Truck 2" }
    ],
    statuses: clone(settings.statuses) || [{ device: { id: "b1" }, isDriving: true }],
    changes: clone(settings.changes) || {
      b1: [{ device: { id: "b1" }, driver: { id: "drv1" }, dateTime: "2026-10-01T10:00:00.000Z", type: "Driver" }],
      b2: [{ device: { id: "b2" }, driver: { id: "UnknownDriverId" }, dateTime: "2026-10-01T11:00:00.000Z", type: "Driver" }]
    },
    users: clone(settings.users) || { drv1: { id: "drv1", firstName: "Dan", lastName: "River" } },
    hosLogs: clone(settings.hosLogs) || [],
    addInData: clone(settings.addInData) || [],
    nextId: 1
  };
  const behaviour = {
    failBatchCount: settings.failBatchCount || 0,
    addedChanges: [],
    calls: [],
    addBlocks: settings.addBlocks || 0
  };

  /**
   * `includeOverlappedChanges` returns the change in effect on that device, and
   * may include future-dated ones. The core picks the latest change that is not
   * in the future, so the fake returns every change it knows about and lets the
   * core's own selection logic run.
   */
  function deviceChange(deviceId) {
    return (state.changes[deviceId] || []).map((change) => Object.assign({}, change));
  }

  function dispatch(method, params) {
    behaviour.calls.push([method, params]);
    if (method === "Get") {
      switch (params.typeName) {
        case "AddInData":
          return state.addInData.map((record) => Object.assign({}, record));
        case "Device":
          return state.devices.map((device) => Object.assign({}, device));
        case "DeviceStatusInfo":
          return state.statuses.map((status) => Object.assign({}, status));
        case "DriverChange":
          return deviceChange(params.search.deviceSearch.id, params);
        case "User": {
          if (params.search && params.search.id) {
            const user = state.users[params.search.id];
            return user ? [Object.assign({}, user)] : [];
          }
          return [];
        }
        case "DutyStatusLog":
          return state.hosLogs.slice();
        default:
          return [];
      }
    }
    if (method === "Add") {
      if (params.typeName === "DriverChange") {
        if (behaviour.addBlocks > 0) {
          behaviour.addBlocks -= 1;
          throw { message: "InvalidDeviceException: blocked" };
        }
        behaviour.addedChanges.push(params.entity);
        // A written change becomes the change in effect, so the core's verify
        // pass (which re-reads each device) sees what the write did.
        const deviceId = params.entity.device && params.entity.device.id;
        if (deviceId) state.changes[deviceId] = (state.changes[deviceId] || []).concat([params.entity]);
        const id = `chg-${state.nextId++}`;
        return id;
      }
      if (params.typeName === "AddInData") {
        const entity = Object.assign({ id: `addin-${state.nextId++}`, version: "1" }, params.entity);
        state.addInData.push(entity);
        return entity.id;
      }
    }
    if (method === "Set") {
      if (params.typeName === "AddInData") {
        const index = state.addInData.findIndex((record) => record.id === params.entity.id);
        const next = Object.assign({}, params.entity, { version: String(state.nextId++) });
        if (index === -1) state.addInData.push(next);
        else state.addInData[index] = next;
        return true;
      }
    }
    throw new Error(`unsupported call: ${method} ${params.typeName || ""}`);
  }

  function call(method, params, ok, err) {
    try {
      ok(dispatch(method, params));
    } catch (error) {
      err(error);
    }
  }

  function multiCall(calls, ok, err) {
    try {
      ok(calls.map((entry) => dispatch(entry[0], entry[1])));
    } catch (error) {
      err(error);
    }
  }

  return {
    api: { call, multiCall, getSession: (callback) => callback({ userName: "svc", database: "db" }) },
    state,
    behaviour
  };
}

/** A `createGeotab`-shaped object without any network. */
function createFakeGeotab(options) {
  const settings = options || {};
  const users = settings.users || [
    { id: "b87", name: settings.userName || "admin@example.com", securityGroups: settings.securityGroups || [{ id: "GroupEverythingSecurityId" }] }
  ];
  const groupsById = settings.groupsById || {};
  const record = settings.record || [];

  function session(credentials) {
    return {
      credentials,
      database: credentials.database,
      userName: credentials.userName,
      server: settings.server || "my.geotab.test",
      call: async (method, params) => {
        record.push({ credentials, method, params });
        if (settings.call) return settings.call(method, params, credentials);
        if (method === "Get" && params.typeName === "User") return users.slice();
        if (method === "Get" && params.typeName === "Group") {
          const id = params.search && params.search.id;
          return groupsById[id] ? [groupsById[id]] : [];
        }
        return [];
      },
      multiCall: async (calls) => {
        const out = [];
        for (const entry of calls) {
          const params = Array.isArray(entry) ? entry[1] : entry.params;
          const id = params && params.search && params.search.id;
          if (settings.multiCall) out.push(await settings.multiCall(entry));
          else out.push(groupsById[id] ? [groupsById[id]] : []);
        }
        return out;
      },
      multiCallChunked: async (calls) => {
        const out = [];
        for (const entry of calls) {
          const params = Array.isArray(entry) ? entry[1] : entry.params;
          const id = params && params.search && params.search.id;
          if (settings.multiCall) out.push(await settings.multiCall(entry));
          else out.push(groupsById[id] ? [groupsById[id]] : []);
        }
        return out;
      }
    };
  }

  return {
    server: settings.server || "my.geotab.test",
    authenticate: async (account) => {
      if (settings.authenticate) return settings.authenticate(account);
      return { database: account.database, userName: account.userName, sessionId: "svc-session" };
    },
    session
  };
}

function conflict(name) {
  const error = new Error(`${name || "ConflictException"}`);
  error.name = name || "ConflictException";
  return error;
}

function notFound(name) {
  const error = new Error(`${name || "ResourceNotFoundException"}`);
  error.name = name || "ResourceNotFoundException";
  return error;
}

/** In-memory EventBridge Scheduler client (the semantic surface lib/scheduler expects). */
function createFakeSchedulerClient() {
  const groups = new Set();
  const schedules = new Map();
  const key = (group, name) => `${group}/${name}`;
  const arn = (group, name) => `arn:aws:scheduler:test:000000000000:schedule/${group}/${name}`;

  return {
    groups,
    schedules,
    failCreateOnce: false,
    async createScheduleGroup({ Name }) {
      if (groups.has(Name)) throw conflict();
      groups.add(Name);
      return { ScheduleGroupArn: `arn:aws:scheduler:test:000000000000:schedule-group/${Name}` };
    },
    async createSchedule(input) {
      if (this.failCreateOnce) {
        this.failCreateOnce = false;
        throw conflict();
      }
      if (schedules.has(key(input.GroupName, input.Name))) throw conflict();
      schedules.set(key(input.GroupName, input.Name), Object.assign({}, input));
      return { ScheduleArn: arn(input.GroupName, input.Name) };
    },
    async updateSchedule(input) {
      if (!schedules.has(key(input.GroupName, input.Name))) throw notFound();
      schedules.set(key(input.GroupName, input.Name), Object.assign({}, input));
      return { ScheduleArn: arn(input.GroupName, input.Name) };
    },
    async getSchedule({ Name, GroupName }) {
      const found = schedules.get(key(GroupName, Name));
      if (!found) throw notFound();
      return Object.assign({ Name, GroupName, Arn: arn(GroupName, Name) }, found);
    },
    async deleteSchedule({ Name, GroupName }) {
      if (!schedules.delete(key(GroupName, Name))) throw notFound();
      return {};
    },
    async listSchedules({ GroupName }) {
      const entries = Array.from(schedules.entries())
        .filter(([scheduleKey]) => scheduleKey.startsWith(`${GroupName}/`))
        .map(([, schedule]) => ({ Name: schedule.Name, GroupName, Arn: arn(GroupName, schedule.Name) }));
      return { Schedules: entries };
    }
  };
}

const DEFAULT_CONFIG = {
  schemaVersion: 1,
  deployment: { name: "advone-ca-central", region: "ca-central-1", deploymentId: "test" },
  addIn: {
    name: "Scheduled Driver Unassign by Advantage One",
    pageName: "Scheduled Driver Unassign",
    securityId: { id: "aTestAddInSecurityId", name: "ViewSecurityId" },
    clearance: { requireIsAdd: true, allowEverythingGroup: true, ignoreCatalogGroup: true }
  },
  defaults: { skipDriving: true, graceMinutes: 60 },
  customers: {
    tenant_a: {
      key: "tenant_a",
      geotab: { database: "tenant_a", server: "my.geotab.com" },
      secretName: "unassign/tenant_a",
      enabled: true,
      timeZone: "America/Toronto",
      createdAt: "2026-10-01T00:00:00.000Z",
      createdBy: "arn:aws:iam::000000000000:user/test",
      notes: ""
    }
  }
};

function clone(value) {
  return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
}

function createFakeConfig(overrides) {
  const config = clone(DEFAULT_CONFIG);
  return Object.assign(config, overrides || {});
}

module.exports = {
  ADDIN_ID,
  createFetch,
  createGeotabFetch,
  createCoreApi,
  createFakeGeotab,
  createFakeSchedulerClient,
  createFakeConfig,
  DEFAULT_CONFIG,
  conflict,
  notFound,
  clone
};
