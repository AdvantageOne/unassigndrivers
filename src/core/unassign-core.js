/*
 * Scheduled Driver Unassign - core logic
 * AdvantageOne | MyGeotab Add-In
 *
 * Pure logic (schedule math, Geotab reads/writes, run lock) with no DOM access,
 * so it can be unit-tested in Node with a mock API.
 */
(function (root) {
  "use strict";

  var ADDIN_ID = "arpL4jyXrThGH7UuWmWZXDA"; // keep stable: AddInData is keyed on this
  var UNKNOWN_DRIVER_ID = "UnknownDriverId";
  var ADMIN_GROUP_ID = "GroupEverythingSecurityId"; // built-in "Administrator" clearance
  var COMPANY_GROUP_ID = "GroupCompanyId";
  var MAX_LOG_ENTRIES = 40;
  var BATCH_SIZE = 100;

  /* ------------------------------------------------------------------ */
  /* Promise wrappers around the MyGeotab api object                    */
  /* ------------------------------------------------------------------ */
  function call(api, method, params) {
    return new Promise(function (resolve, reject) {
      api.call(method, params, resolve, reject);
    });
  }
  function multiCall(api, calls) {
    return new Promise(function (resolve, reject) {
      api.multiCall(calls, resolve, reject);
    });
  }
  function getSession(api) {
    return new Promise(function (resolve) {
      api.getSession(function (s) { resolve(s); });
    });
  }
  function errText(e) {
    if (!e) return "Unknown error";
    if (typeof e === "string") return e;
    return e.message || e.name || JSON.stringify(e);
  }

  /* ------------------------------------------------------------------ */
  /* Time-zone math (no libraries; uses Intl)                           */
  /* ------------------------------------------------------------------ */
  var dtfCache = {};
  function dtf(tz) {
    if (!dtfCache[tz]) {
      dtfCache[tz] = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short"
      });
    }
    return dtfCache[tz];
  }
  var WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  /** Wall-clock parts of an instant in a zone. */
  function localParts(date, tz) {
    var p = {};
    dtf(tz).formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
    return {
      y: +p.year, m: +p.month, d: +p.day,
      hh: +p.hour, mm: +p.minute, ss: +p.second,
      weekday: WD[p.weekday]
    };
  }

  /** Offset (ms) of zone vs UTC at an instant. */
  function tzOffsetMs(date, tz) {
    var p = localParts(date, tz);
    var asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
    return asUtc - Math.floor(date.getTime() / 1000) * 1000;
  }

  /**
   * Instant at which the wall clock in tz reads y-m-d hh:mm.
   * Non-existent times (spring-forward gap) resolve to the first valid
   * instant after the gap; repeated times (fall-back) resolve to the first.
   */
  function zonedToUtc(y, m, d, hh, mm, tz) {
    var guess = Date.UTC(y, m - 1, d, hh, mm);
    var t = guess - tzOffsetMs(new Date(guess), tz);
    var t2 = guess - tzOffsetMs(new Date(t), tz);
    if (t2 !== t) {
      // DST edge: pick the earlier candidate that still reads at/after the target
      var cand = [Math.min(t, t2), Math.max(t, t2)];
      for (var i = 0; i < cand.length; i++) {
        var lp = localParts(new Date(cand[i]), tz);
        if (lp.hh === hh && lp.mm === mm) return new Date(cand[i]);
      }
      return new Date(Math.max(t, t2));
    }
    return new Date(t);
  }

  function addDays(y, m, d, n) {
    var x = new Date(Date.UTC(y, m - 1, d + n));
    return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(), weekday: x.getUTCDay() };
  }

  function parseHHMM(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(s || "");
    if (!m) throw new Error("Time must be HH:MM");
    var hh = +m[1], mm = +m[2];
    if (hh > 23 || mm > 59) throw new Error("Time must be HH:MM");
    return { hh: hh, mm: mm };
  }

  /** All occurrence instants of the schedule within [from, to]. */
  function occurrencesBetween(s, from, to) {
    var out = [];
    if (!s || !s.time || !s.timeZone) return out;
    var t = parseHHMM(s.time);
    if (s.mode === "once") {
      if (!s.onceDate) return out;
      var dp = s.onceDate.split("-").map(Number);
      var o = zonedToUtc(dp[0], dp[1], dp[2], t.hh, t.mm, s.timeZone);
      if (o >= from && o <= to) out.push(o);
      return out;
    }
    var start = localParts(new Date(from.getTime() - 86400000), s.timeZone);
    var spanDays = Math.ceil((to - from) / 86400000) + 2;
    for (var i = 0; i <= spanDays; i++) {
      var day = addDays(start.y, start.m, start.d, i);
      if (s.mode === "weekly" && (s.days || []).indexOf(day.weekday) === -1) continue;
      var occ = zonedToUtc(day.y, day.m, day.d, t.hh, t.mm, s.timeZone);
      if (occ >= from && occ <= to) out.push(occ);
    }
    return out;
  }

  /** Next occurrence strictly after `after` (looks up to 400 days ahead). */
  function nextOccurrence(s, after) {
    var from = new Date(after.getTime() + 1000);
    var list = occurrencesBetween(s, from, new Date(from.getTime() + 400 * 86400000));
    return list.length ? list[0] : null;
  }

  /**
   * Decide whether a run should happen now.
   * Returns { action: "run" | "missed" | "none", occurrence: Date|null }.
   * Only occurrences after the schedule was activated and after the last
   * handled occurrence count. Occurrences older than graceMinutes are "missed".
   */
  function evaluateDue(s, now) {
    if (!s || !s.enabled) return { action: "none", occurrence: null };
    var floor = Math.max(
      s.activatedAt ? Date.parse(s.activatedAt) : 0,
      s.lastOccurrence ? Date.parse(s.lastOccurrence) : 0,
      now.getTime() - 8 * 86400000
    );
    var list = occurrencesBetween(s, new Date(floor + 1000), now);
    if (!list.length) return { action: "none", occurrence: null };
    var occ = list[list.length - 1];
    var graceMs = (s.graceMinutes == null ? 15 : +s.graceMinutes) * 60000;
    return { action: now - occ <= graceMs ? "run" : "missed", occurrence: occ };
  }

  /* ------------------------------------------------------------------ */
  /* AddInData storage (schedule + run log)                             */
  /* ------------------------------------------------------------------ */
  function loadRecords(api) {
    return call(api, "Get", { typeName: "AddInData", search: { addInId: ADDIN_ID } })
      .then(function (rows) {
        var out = { schedule: null, log: null };
        (rows || []).forEach(function (r) {
          var d = r.details || (r.data ? JSON.parse(r.data) : {});
          if (d.type === "schedule" && !out.schedule) out.schedule = { id: r.id, version: r.version, details: d };
          if (d.type === "log" && !out.log) out.log = { id: r.id, version: r.version, details: d };
        });
        return out;
      });
  }

  function saveRecord(api, rec, details) {
    if (rec && rec.id) {
      return call(api, "Set", {
        typeName: "AddInData",
        entity: { id: rec.id, addInId: ADDIN_ID, groups: [{ id: COMPANY_GROUP_ID }], details: details }
      }).then(function () { return { id: rec.id, details: details }; });
    }
    return call(api, "Add", {
      typeName: "AddInData",
      entity: { addInId: ADDIN_ID, groups: [{ id: COMPANY_GROUP_ID }], details: details }
    }).then(function (id) { return { id: id, details: details }; });
  }

  function saveSchedule(api, existing, schedule, userName) {
    var d = Object.assign({}, schedule, {
      type: "schedule",
      updatedBy: userName,
      updatedAt: new Date().toISOString(),
      // re-activating resets the "missed" window so past slots don't fire
      activatedAt: new Date().toISOString(),
      lastOccurrence: existing && existing.details ? existing.details.lastOccurrence || null : null
    });
    return saveRecord(api, existing, d);
  }

  function appendLog(api, entry) {
    return loadRecords(api).then(function (r) {
      var entries = (r.log && r.log.details.entries) || [];
      // a scheduled or missed slot is logged once, even if two browsers race
      if (entry.occurrence && entries.some(function (e) { return e.occurrence === entry.occurrence && e.trigger === entry.trigger; })) {
        return { id: r.log.id, details: r.log.details, duplicate: true };
      }
      entries.unshift(entry);
      if (entries.length > MAX_LOG_ENTRIES) entries = entries.slice(0, MAX_LOG_ENTRIES);
      return saveRecord(api, r.log, { type: "log", entries: entries });
    });
  }

  /**
   * Optimistic cross-browser lock so two open add-in tabs don't both run.
   * Writes our tabId against the occurrence, waits, re-reads, and only
   * proceeds if our write survived.
   */
  function claimOccurrence(api, occIso, tabId, userName, waitMs) {
    return loadRecords(api).then(function (r) {
      if (!r.schedule) return false;
      var d = r.schedule.details;
      if (d.lastOccurrence && Date.parse(d.lastOccurrence) >= Date.parse(occIso)) return false;
      var nd = Object.assign({}, d, { lastOccurrence: occIso, claimedBy: tabId, claimedByUser: userName, claimedAt: new Date().toISOString() });
      return saveRecord(api, r.schedule, nd)
        .then(function () { return new Promise(function (res) { setTimeout(res, waitMs == null ? 2500 + Math.random() * 2000 : waitMs); }); })
        .then(function () { return loadRecords(api); })
        .then(function (r2) {
          var d2 = r2.schedule && r2.schedule.details;
          return !!d2 && d2.lastOccurrence === occIso && d2.claimedBy === tabId;
        });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Access check                                                        */
  /* ------------------------------------------------------------------ */
  function checkAdmin(api, extraAllowedGroupIds) {
    return getSession(api).then(function (session) {
      return call(api, "Get", { typeName: "User", search: { name: session.userName } }).then(function (users) {
        var u = users && users[0];
        var ids = ((u && u.securityGroups) || []).map(function (g) { return g.id; });
        var allowed = [ADMIN_GROUP_ID].concat(extraAllowedGroupIds || []);
        return {
          userName: session.userName,
          timeZoneId: (u && u.timeZoneId) || null,
          isAdmin: ids.some(function (id) { return allowed.indexOf(id) !== -1; })
        };
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Reads: current assignments                                          */
  /* ------------------------------------------------------------------ */
  function chunk(arr, n) {
    var out = [];
    for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  function driverIdOf(c) {
    if (!c || !c.driver) return null;
    return typeof c.driver === "string" ? c.driver : c.driver.id;
  }
  function isRealDriver(id) {
    return !!id && id !== UNKNOWN_DRIVER_ID && id !== "NoDriverId";
  }

  /**
   * Current DriverChange per device.
   *
   * IMPORTANT: a fleet-wide DriverChange search with includeOverlappedChanges
   * returns the latest change per DRIVER, not per device. Once UnknownDriver
   * is used on one asset, its earlier UnknownDriver changes on other assets
   * drop out of that result and those assets look assigned again. So we ask
   * per device (deviceSearch + includeOverlappedChanges), which returns the
   * change in effect on that device right now. All types are considered
   * (Driver, TripDriver, ...): the latest one wins.
   */
  function getCurrentChanges(api, deviceIds, nowIso) {
    var calls = deviceIds.map(function (id) {
      return ["Get", { typeName: "DriverChange", search: { deviceSearch: { id: id }, fromDate: nowIso, includeOverlappedChanges: true } }];
    });
    return Promise.all(chunk(calls, BATCH_SIZE).map(function (c) { return multiCall(api, c); }))
      .then(function (parts) {
        var results = [].concat.apply([], parts);
        var current = {};
        deviceIds.forEach(function (id, i) {
          var latest = null;
          (results[i] || []).forEach(function (c) {
            if (Date.parse(c.dateTime) > Date.parse(nowIso)) return; // future changes don't count yet
            if (!latest || Date.parse(c.dateTime) > Date.parse(latest.dateTime)) latest = c;
          });
          current[id] = latest;
        });
        return current;
      });
  }

  /**
   * Returns the list of assets that currently have a real driver assigned,
   * within scope, with names, driving state and HOS login flag.
   * opts.deviceIds limits the check to specific assets (used to verify a run).
   */
  function getAssignments(api, opts) {
    opts = opts || {};
    var now = opts.now || new Date();
    var nowIso = now.toISOString();
    var groupIds = (opts.groupIds || []).filter(Boolean);

    var deviceSearch = { fromDate: nowIso }; // active devices only
    if (groupIds.length) deviceSearch.groups = groupIds.map(function (id) { return { id: id }; });

    return multiCall(api, [
      ["Get", { typeName: "Device", search: deviceSearch }],
      ["Get", { typeName: "DeviceStatusInfo" }]
    ]).then(function (res) {
      var devices = res[0] || [], statuses = res[1] || [];
      if (opts.deviceIds) {
        var only = {};
        opts.deviceIds.forEach(function (id) { only[id] = true; });
        devices = devices.filter(function (d) { return only[d.id]; });
      }
      var statusMap = {};
      statuses.forEach(function (st) { if (st.device) statusMap[st.device.id] = st; });

      return getCurrentChanges(api, devices.map(function (d) { return d.id; }), nowIso).then(function (current) {
        var rows = devices
          .filter(function (d) { return isRealDriver(driverIdOf(current[d.id])); })
          .map(function (d) {
            var c = current[d.id];
            var st = statusMap[d.id] || {};
            return {
              deviceId: d.id,
              deviceName: d.name,
              driverId: driverIdOf(c),
              driverName: driverIdOf(c),
              assignedAt: c.dateTime,
              changeType: c.type || "Driver",
              isDriving: !!st.isDriving,
              hosLoggedIn: false
            };
          });
        return decorate(api, rows, now);
      });
    });
  }

  /** Adds driver names and HOS login flags (both best-effort). */
  function decorate(api, rows, now) {
    if (!rows.length) return Promise.resolve(rows);
    var nowIso = now.toISOString();
    var driverIds = Array.from(new Set(rows.map(function (r) { return r.driverId; })));
    var nameCalls = driverIds.map(function (id) { return ["Get", { typeName: "User", search: { id: id } }]; });

    var namesP = Promise.all(chunk(nameCalls, BATCH_SIZE).map(function (c) { return multiCall(api, c); }))
      .then(function (parts) {
        var names = {};
        [].concat.apply([], parts).forEach(function (arr) {
          var u = arr && arr[0];
          if (u) names[u.id] = ((u.firstName || "") + " " + (u.lastName || "")).trim() || u.name;
        });
        rows.forEach(function (r) { if (names[r.driverId]) r.driverName = names[r.driverId]; });
      })
      .catch(function () { /* names are cosmetic */ });

    // HOS: flag drivers whose most recent Login/Logoff in the last 24 h is a Login
    var hosP = call(api, "Get", {
      typeName: "DutyStatusLog",
      search: {
        fromDate: new Date(now.getTime() - 24 * 3600000).toISOString(),
        toDate: nowIso,
        statuses: ["Login", "Logoff"]
      }
    }).then(function (logs) {
      var last = {};
      (logs || []).forEach(function (l) {
        var id = driverIdOf(l);
        if (!id) return;
        if (!last[id] || Date.parse(l.dateTime) > Date.parse(last[id].dateTime)) last[id] = l;
      });
      rows.forEach(function (r) { r.hosLoggedIn = !!(last[r.driverId] && last[r.driverId].status === "Login"); });
    }).catch(function () { /* HOS not in use or no clearance */ });

    return Promise.all([namesP, hosP]).then(function () {
      rows.sort(function (a, b) { return String(a.deviceName).localeCompare(String(b.deviceName)); });
      return rows;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Write: unassign                                                     */
  /* ------------------------------------------------------------------ */
  function addCall(row, iso) {
    return ["Add", {
      typeName: "DriverChange",
      entity: { device: { id: row.deviceId }, driver: { id: UNKNOWN_DRIVER_ID }, dateTime: iso, type: "Driver" }
    }];
  }

  /**
   * Unassign drivers from the given rows. If a multiCall batch fails, some of
   * its writes may already have landed (multiCall isn't transactional), so we
   * re-read those assets and retry one-by-one only the ones still assigned.
   */
  function unassign(api, rows, opts) {
    opts = opts || {};
    var iso = (opts.now || new Date()).toISOString();
    var targets = rows.filter(function (r) { return !(opts.skipDriving && r.isDriving); });
    var skipped = rows.filter(function (r) { return opts.skipDriving && r.isDriving; });
    var ok = [], failed = [];

    var seq = Promise.resolve();
    chunk(targets, BATCH_SIZE).forEach(function (batch) {
      seq = seq.then(function () {
        return multiCall(api, batch.map(function (r) { return addCall(r, iso); }))
          .then(function () { ok.push.apply(ok, batch); })
          .catch(function () {
            var checkAt = new Date(Date.parse(iso) + 1000).toISOString();
            return getCurrentChanges(api, batch.map(function (r) { return r.deviceId; }), checkAt)
              .catch(function () { return {}; })
              .then(function (current) {
                return batch.reduce(function (p, r) {
                  return p.then(function () {
                    var c = current[r.deviceId];
                    if (c && !isRealDriver(driverIdOf(c))) { ok.push(r); return; } // already written
                    return call(api, "Add", addCall(r, iso)[1])
                      .then(function () { ok.push(r); })
                      .catch(function (e) { failed.push(Object.assign({}, r, { error: errText(e) })); });
                  });
                }, Promise.resolve());
              });
          });
      });
    });

    return seq.then(function () {
      return { at: iso, unassigned: ok, failed: failed, skipped: skipped };
    });
  }

  /**
   * Full run: read -> unassign -> verify -> log.
   * Verify re-reads every asset we wrote to; any that still has a real driver
   * (e.g. Geotab Drive or a key re-asserted the login) is reported as stillAssigned.
   */
  function run(api, opts) {
    opts = opts || {};
    var started = new Date();
    return getAssignments(api, { now: started, groupIds: opts.groupIds })
      .then(function (rows) { return unassign(api, rows, { now: started, skipDriving: opts.skipDriving }); })
      .then(function (result) {
        if (!result.unassigned.length) return result;
        var ids = result.unassigned.map(function (r) { return r.deviceId; });
        return getAssignments(api, { now: new Date(Math.max(Date.now(), started.getTime() + 1000)), deviceIds: ids })
          .then(function (still) {
            var stillIds = {};
            still.forEach(function (r) { stillIds[r.deviceId] = r; });
            result.stillAssigned = still;
            result.unassigned = result.unassigned.filter(function (r) { return !stillIds[r.deviceId]; });
            return result;
          }, function () { result.verifyFailed = true; return result; });
      })
      .then(function (result) {
        var slim = function (r) { return { device: r.deviceName, driver: r.driverName, type: r.changeType, hos: r.hosLoggedIn || undefined, error: r.error }; };
        var entry = {
          at: result.at,
          trigger: opts.trigger || "manual",
          occurrence: opts.occurrence || null,
          by: opts.userName || null,
          unassigned: result.unassigned.map(slim),
          skipped: result.skipped.map(slim),
          failed: result.failed.map(slim),
          stillAssigned: (result.stillAssigned || []).map(slim),
          note: result.verifyFailed ? "Couldn't re-check assets after the run." : undefined
        };
        return appendLog(api, entry).then(function () { return entry; }, function () { return entry; });
      });
  }

  var api = {
    ADDIN_ID: ADDIN_ID,
    UNKNOWN_DRIVER_ID: UNKNOWN_DRIVER_ID,
    localParts: localParts,
    zonedToUtc: zonedToUtc,
    occurrencesBetween: occurrencesBetween,
    nextOccurrence: nextOccurrence,
    evaluateDue: evaluateDue,
    loadRecords: loadRecords,
    saveSchedule: saveSchedule,
    appendLog: appendLog,
    claimOccurrence: claimOccurrence,
    checkAdmin: checkAdmin,
    getAssignments: getAssignments,
    getCurrentChanges: getCurrentChanges,
    unassign: unassign,
    run: run,
    errText: errText
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.A1UnassignCore = api;
})(typeof window !== "undefined" ? window : this);

