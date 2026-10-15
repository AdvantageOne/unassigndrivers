/*
 * Scheduled Driver Unassign - AWS SDK adapters
 * AdvantageOne
 *
 * The only file in the service that imports the AWS SDK. Clients are created
 * on first use so unit tests (and any local run) never need the SDK installed —
 * the Lambda nodejs22.x runtime provides it.
 *
 * Each adapter exposes the small semantic surface the rest of the code expects,
 * which is also what tests fake.
 */
"use strict";

const { appError } = require("./lib/errors");

function s3ClientFactory() {
  const { S3Client } = require("@aws-sdk/client-s3");
  return new S3Client({});
}

function createConfigLoader(options) {
  const region = options.region;
  let s3;
  return async function load() {
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    if (!s3) s3 = s3ClientFactory();
    try {
      const result = await s3.send(new GetObjectCommand({ Bucket: options.bucket, Key: options.key }));
      return await result.Body.transformToString();
    } catch (error) {
      const name = error && (error.name || error.code);
      if (name === "NoSuchKey" || name === "NoSuchBucket" || name === "NotFound") {
        throw appError(
          "INTERNAL",
          `The configuration object s3://${options.bucket}/${options.key} does not exist. Run scripts/deploy.sh for this region.`
        );
      }
      throw error;
    }
  };
}

/**
 * Reads and writes the tenant registry. `read` keeps the ETag so a write can be
 * conditional, which is what makes concurrent onboarding safe.
 */
function createConfigReadWrite(options) {
  let s3;
  function client() {
    if (!s3) s3 = s3ClientFactory();
    return s3;
  }
  return {
    async read() {
      const { GetObjectCommand } = require("@aws-sdk/client-s3");
      try {
        const result = await client().send(new GetObjectCommand({ Bucket: options.bucket, Key: options.key }));
        return { text: await result.Body.transformToString(), etag: result.ETag || null };
      } catch (error) {
        const name = error && (error.name || error.code);
        if (name === "NoSuchKey" || name === "NoSuchBucket" || name === "NotFound") {
          throw appError(
            "INTERNAL",
            `The configuration object s3://${options.bucket}/${options.key} does not exist. Run scripts/deploy.sh for this region.`
          );
        }
        throw error;
      }
    },
    async write(text, etag) {
      const { PutObjectCommand } = require("@aws-sdk/client-s3");
      const input = {
        Bucket: options.bucket,
        Key: options.key,
        Body: text,
        ContentType: "application/json",
        ServerSideEncryption: "AES256"
      };
      if (etag) input.IfMatch = etag;
      const result = await client().send(new PutObjectCommand(input));
      return { etag: result.ETag || null };
    }
  };
}

function createSecretPublisherAdapter() {
  let client;
  return {
    async createSecret(input) {
      const { SecretsManagerClient, CreateSecretCommand } = require("@aws-sdk/client-secrets-manager");
      if (!client) client = new SecretsManagerClient({});
      return client.send(new CreateSecretCommand(input));
    },
    async putSecretValue(input) {
      const { SecretsManagerClient, PutSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
      if (!client) client = new SecretsManagerClient({});
      return client.send(new PutSecretValueCommand(input));
    }
  };
}

function createSecretFetcher() {
  let client;
  return async function fetchSecret(secretId) {
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    if (!client) client = new SecretsManagerClient({});
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    const text = result.SecretString || (result.SecretBinary ? Buffer.from(result.SecretBinary).toString("utf8") : null);
    if (!text) throw appError("INTERNAL", `Secret "${secretId}" has no string value.`);
    return text;
  };
}

function createSchedulerAdapter(options) {
  const region = options.region;
  let sdk = null;
  let client = null;

  function send(commandName, input) {
    if (!sdk) sdk = require("@aws-sdk/client-scheduler");
    if (!client) client = new sdk.SchedulerClient({ region });
    const Command = sdk[commandName];
    if (!Command) throw appError("INTERNAL", `The AWS SDK is missing ${commandName}.`);
    return client.send(new Command(input));
  }

  return {
    createScheduleGroup: (input) => send("CreateScheduleGroupCommand", input),
    createSchedule: (input) => send("CreateScheduleCommand", input),
    updateSchedule: (input) => send("UpdateScheduleCommand", input),
    getSchedule: (input) => send("GetScheduleCommand", input),
    deleteSchedule: (input) => send("DeleteScheduleCommand", input),
    listSchedules: (input) => send("ListSchedulesCommand", input)
  };
}

module.exports = {
  createConfigLoader,
  createConfigReadWrite,
  createSecretFetcher,
  createSecretPublisherAdapter,
  createSchedulerAdapter
};
