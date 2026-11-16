'use strict';
const fs = require('fs');
function databaseConfig(env = process.env) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const url = new URL(connectionString);
  for (const name of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
    if (url.searchParams.has(name)) throw new Error('Configure database TLS with DB_SSL and DB_CA_FILE, not URL SSL overrides');
  }
  const tls = env.DB_SSL === 'true';
  if (env.NODE_ENV === 'production' && !tls) throw new Error('Production requires DB_SSL=true');
  return { connectionString, ssl: tls ? { rejectUnauthorized: true, ...(env.DB_CA_FILE ? { ca: fs.readFileSync(env.DB_CA_FILE, 'utf8') } : {}) } : false,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 15000 };
}
module.exports = { databaseConfig };
