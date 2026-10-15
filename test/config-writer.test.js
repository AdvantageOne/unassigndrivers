/*
 * The tenant registry is read by every request and written rarely, so the write
 * path has to survive two Lambda containers writing at once. These tests use an
 * in-memory object with ETags and inject a competing writer to prove the loser
 * re-reads instead of clobbering.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createConfigWriter, isPreconditionFailure } = require("../src/lambda/lib/config-writer");
const { createFakeConfig, clone } = require("./support/fakes");

function preconditionError() {
  const error = new Error("At least one of the pre-conditions you specified did not hold");
  error.name = "PreconditionFailed";
  error.$metadata = { httpStatusCode: 412 };
  return error;
}

/** A tiny S3-shaped store: one object, an ETag that changes on every write. */
function store(initial) {
  let text = JSON.stringify(initial, null, 2);
  let etag = "etag-1";
  const writes = [];
  return {
    writes,
    get text() {
      return text;
    },
    async read() {
      return { text, etag };
    },
    async write(next, expectedEtag) {
      if (expectedEtag !== etag) throw preconditionError();
      text = next;
      etag = `etag-${writes.length + 2}`;
      writes.push(JSON.parse(next));
      return { etag };
    },
    /** Simulates another writer (another container, or the onboard script). */
    compete(mutate) {
      const config = JSON.parse(text);
      mutate(config);
      text = JSON.stringify(config, null, 2);
      etag = `etag-competing-${Math.random()}`;
    }
  };
}

test("a mutation writes with the ETag it read", async () => {
  const s3 = store(createFakeConfig({}));
  const writer = createConfigWriter({ read: s3.read, write: s3.write });

  const result = await writer.mutate((config) => {
    config.customers.tenant_a.notes = "touched";
    return config;
  });

  assert.equal(result.unchanged, undefined);
  assert.equal(result.attempts, 1);
  assert.equal(s3.writes.length, 1);
  assert.equal(s3.writes[0].customers.tenant_a.notes, "touched");
});

test("a competing write is not lost: the loser re-reads and re-applies", async () => {
  const s3 = store(createFakeConfig({}));
  let competed = false;
  const writer = createConfigWriter({
    read: s3.read,
    // The competing write lands after our read and before our write, which is
    // the only ordering that can lose data.
    write: async (text, etag) => {
      if (!competed) {
        competed = true;
        s3.compete((config) => {
          config.customers.other_tenant = { key: "other_tenant", geotab: { database: "other_tenant" }, secretName: "unassign/other_tenant", enabled: true };
        });
      }
      return s3.write(text, etag);
    }
  });

  const result = await writer.mutate((config) => {
    config.customers.tenant_a.notes = "mine";
    return config;
  });

  assert.equal(result.attempts, 2, "the first attempt must hit the ETag guard and retry");
  const stored = JSON.parse(s3.text);
  assert.equal(stored.customers.other_tenant.key, "other_tenant", "the other writer's record survives");
  assert.equal(stored.customers.tenant_a.notes, "mine");
  assert.equal(Object.keys(stored.customers).length, 2);
});

test("giving up after the configured attempts is an internal error, not a partial write", async () => {
  const s3 = store(createFakeConfig({}));
  const writer = createConfigWriter({
    read: s3.read,
    write: async (text, etag) => {
      s3.compete(() => {}); // someone else writes on every attempt
      return s3.write(text, etag);
    },
    attempts: 3
  });

  await assert.rejects(
    () => writer.mutate((config) => config),
    (error) => error.code === "INTERNAL" && /changed 3 times/.test(error.message)
  );
  assert.equal(s3.writes.length, 0);
});

test("a mutator that changes nothing writes nothing", async () => {
  const s3 = store(createFakeConfig({}));
  const writer = createConfigWriter({ read: s3.read, write: s3.write });

  const result = await writer.mutate(() => null);
  assert.deepEqual(result, { unchanged: true, attempts: 1 });
  assert.equal(s3.writes.length, 0);
});

test("a broken configuration is never rewritten", async () => {
  const broken = store(createFakeConfig({}));
  const writer = createConfigWriter({
    read: async () => ({ text: '{"schemaVersion":1,"customers":{}}', etag: "etag-1" }),
    write: broken.write
  });

  await assert.rejects(() => writer.mutate((config) => config), /addIn/);
  assert.equal(broken.writes.length, 0);
});

test("errors that are not precondition failures propagate", async () => {
  const writer = createConfigWriter({
    read: async () => ({ text: JSON.stringify(createFakeConfig({})), etag: "etag-1" }),
    write: async () => {
      throw new Error("AccessDenied");
    }
  });
  await assert.rejects(() => writer.mutate((config) => config), /AccessDenied/);
});

test("precondition failures are recognised from either shape", () => {
  assert.ok(isPreconditionFailure(preconditionError()));
  assert.ok(isPreconditionFailure({ name: "412" }));
  assert.ok(isPreconditionFailure({ $metadata: { httpStatusCode: 412 } }));
  assert.equal(isPreconditionFailure(new Error("nope")), false);
  assert.equal(isPreconditionFailure(null), false);
});

test("the writer never mutates the object it was given", async () => {
  const config = createFakeConfig({});
  const original = clone(config);
  const s3 = store(config);
  const writer = createConfigWriter({ read: s3.read, write: s3.write });

  await writer.mutate((current) => {
    current.customers.tenant_a.notes = "changed";
    return current;
  });

  assert.deepEqual(config, original, "the cached configuration must not be edited in place");
});
