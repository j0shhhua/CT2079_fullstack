'use strict';
// Operator-only utility. Never exposed as an HTTP endpoint.
const {Client} = require('pg'), bcrypt = require('bcryptjs');
const {databaseConfig} = require('../src/db-config');
(async () => {
  const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length<12 || Buffer.byteLength(password)>72) throw new Error('Provide BOOTSTRAP_ADMIN_EMAIL and a password of 12+ characters, at most 72 bytes');
  const c = new Client(databaseConfig()); await c.connect();
  try {
    await c.query('begin');
    const u = (await c.query(`insert into users(name,email,password_hash,role,organiser_approved) values('Administrator',$1,$2,'admin',true)
      on conflict(lower(email)) do update set password_hash=excluded.password_hash,role='admin',disabled=false returning id`, [email,await bcrypt.hash(password,12)])).rows[0];
    await c.query('delete from browser_sessions where user_id=$1',[u.id]);
    await c.query('update recovery_challenges set consumed_at=now() where user_id=$1 and consumed_at is null',[u.id]);
    await c.query('commit'); console.log('Administrator prepared. Email verification is required at sign-in.');
  } catch(e) { await c.query('rollback'); throw e; } finally {await c.end()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
