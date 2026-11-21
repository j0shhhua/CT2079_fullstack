'use strict';
const { Pool } = require('pg');
const { databaseConfig } = require('../src/db-config');
const { approveOrganiser } = require('../src/organiser-approval');

async function main() {
  const email = String(process.env.ORGANISER_EMAIL || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Set ORGANISER_EMAIL to the registered organiser email.');
  const pool = new Pool(databaseConfig(process.env));
  try {
    const result = await approveOrganiser(pool, { email });
    console.log(result.alreadyApproved ? 'This organiser is already approved.' : 'Organiser approved. They must log in and verify the code sent to their email.');
  } finally { await pool.end(); }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
