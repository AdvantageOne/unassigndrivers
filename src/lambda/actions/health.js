/*
 * Scheduled Driver Unassign - health
 * AdvantageOne
 *
 * No session required: this is the deploy smoke test and the thing the deploy
 * script calls after applying. It reports shape, never secrets — customer keys
 * are counted, not listed.
 */
"use strict";

async function health(context) {
  const config = await context.configStore.get();
  const customers = Object.values(config.customers || {});
  return {
    status: "ok",
    version: context.env.version,
    deployment: context.env.deploymentName,
    region: context.env.region,
    now: context.now().toISOString(),
    customers: {
      total: customers.length,
      enabled: customers.filter((customer) => customer.enabled === true).length
    },
    addIn: {
      name: config.addIn.name,
      pageName: config.addIn.pageName,
      securityIdConfigured: Boolean(config.addIn.securityId && config.addIn.securityId.id)
    },
    scheduleGroupPrefix: context.env.scheduleGroupPrefix,
    scheduleTargetConfigured: Boolean(context.env.targetFunctionArn && context.env.schedulerRoleArn)
  };
}

module.exports = { health };
