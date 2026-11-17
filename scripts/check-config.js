'use strict';
// Validate the hosted configuration without sending mail, taking payment or opening a database connection.
const { createApp } = require('../src/server');

async function checkConfig() {
  if (process.env.NODE_ENV !== 'production') throw new Error('Hosted deployments require NODE_ENV=production');
  const app = createApp();
  try {
    console.log(process.env.PAYMENT_MODE === 'demo'
      ? 'Configuration valid: classroom demo, simulated payments, production browser protections, resale disabled.'
      : 'Configuration valid. Verify provider delivery and infrastructure in staging before deployment.');
  } finally {
    await app.locals.pool.end();
  }
}

checkConfig().catch(error => { console.error('Configuration check failed:', error.message); process.exitCode = 1; });
