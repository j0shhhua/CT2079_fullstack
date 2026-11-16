'use strict';
const fs = require('fs'), path = require('path'), { Client } = require('pg');
const { databaseConfig } = require('../src/db-config');
async function migrate(config = databaseConfig()) {
  const c = new Client(config);
  await c.connect();
  try {
    await c.query('select pg_advisory_lock(2079,0)');
    await c.query('begin');
    if (!(await c.query("select to_regclass('public.users') t")).rows[0].t) await c.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
    await c.query('create table if not exists schema_migrations(name text primary key,applied_at timestamptz not null default now())');
    await c.query('commit');
    const dir = path.join(__dirname,'migrations');
    const done = new Set((await c.query('select name from schema_migrations')).rows.map(r => r.name));
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await c.query('begin');
      await c.query(fs.readFileSync(path.join(dir,file),'utf8'));
      await c.query('insert into schema_migrations(name) values($1)',[file]);
      await c.query('commit'); console.log('Applied migration ' + file);
    }
  } catch (e) { await c.query('rollback'); throw e; }
  finally { await c.query('select pg_advisory_unlock(2079,0)'); await c.end(); }
}
if (require.main === module) migrate().catch(e => { console.error('Migration failed:',e.message); process.exitCode = 1; });
module.exports = { migrate };
