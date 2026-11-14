'use strict';
// 1) Creates all tables on a brand-new database (db/schema.sql).
// 2) Applies any new files in db/migrations/ (in name order), each once, inside a transaction.
// Safe to run on every deploy. To change the database later, add a file such as
// db/migrations/002_add_something.sql and make it additive (add columns/tables; do not drop).
const fs = require('fs'), path = require('path'), { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false });
  await c.connect();
  if ((await c.query(`select to_regclass('public.users') t`)).rows[0].t) console.log('Base schema already exists.');
  else { await c.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')); console.log('Schema created.'); }
  await c.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const dir = path.join(__dirname, 'migrations');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort() : [];
  const done = new Set((await c.query('select name from schema_migrations')).rows.map(r => r.name));
  let n = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    try {
      await c.query('begin');
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query('insert into schema_migrations(name) values($1)', [f]);
      await c.query('commit'); n++; console.log('Applied migration ' + f);
    } catch (e) { await c.query('rollback'); throw new Error(`Migration ${f} failed: ${e.message}`); }
  }
  console.log(n ? `${n} migration(s) applied.` : 'No new migrations.');
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
