'use strict';
// Explicitly enabled local/staging fixtures only. Never seeds production.
const { Client } = require('pg'), bcrypt = require('bcryptjs');
const { databaseConfig } = require('../src/db-config');
(async () => {
  if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DEMO_SEED !== 'true') throw new Error('Demo seeding is disabled');
  const password = process.env.DEMO_SEED_PASSWORD || '';
  if (password.length < 12 || Buffer.byteLength(password)>72) throw new Error('Set a DEMO_SEED_PASSWORD of 12+ characters and at most 72 bytes');
  const c = new Client(databaseConfig());
  await c.connect();
  if ((await c.query('select 1 from users limit 1')).rowCount) { console.log('Users exist, skipping seed.'); return c.end(); }
  const hash = await bcrypt.hash(password, 12), id = {};
  const U = [['ava', 'Ava Tan', 'ava.tan@mail.sg', 'customer', true, 120, '+65 9123 4567'], ['raj', 'Raj, Harbour Live', 'raj@harbourlive.sg', 'organiser', true, 0, null],
    ['mei', 'Mei, Admin', 'mei@eventeaseplus.sg', 'admin', true, 0, null], ['kai', 'Kai, Lion City Sports', 'kai@lcsports.sg', 'organiser', false, 0, null]];
  for (const [k, n, e, r, ok, pts, ph] of U) id[k] = (await c.query('insert into users(name,email,phone,password_hash,role,organiser_approved,points,referral_code) values($1,$2,$3,$4,$5,$6,$7,$8) returning id',
    [n, e, ph, hash, r, ok, pts, 'REF-' + k.toUpperCase()])).rows[0].id;
  const day = d => new Date(Date.now() + d * 864e5).toISOString();
  const EV = [['Neon Tides Live', 'Concert', 12, 'Singapore Indoor Stadium', 'Kallang', 'raj', 168, 98, 58, 'live', true], ['The Last Lantern', 'Theatre', 6, 'Victoria Theatre', 'Downtown', 'raj', 120, 78, 45, 'live'],
    ['Lions v Tigers: Derby Night', 'Sports', 20, 'National Stadium', 'Kallang', 'kai', 150, 80, 40, 'live'], ['Peranakan Heritage Gala', 'Cultural', 30, 'Asian Civilisations Museum', 'Civic District', 'raj', 110, 70, 35, 'live'],
    ['Symphony Under Stars', 'Concert', 45, 'Esplanade Concert Hall', 'Marina Bay', 'raj', 188, 118, 60, 'live'], ['Dragon Boat Invitational', 'Sports', 9, 'Marina Reservoir', 'Marina South', 'kai', 60, 35, 18, 'live'],
    ['Wayang Kulit Revival', 'Cultural', 1, 'Malay Heritage Centre', 'Kampong Gelam', 'raj', 75, 45, 22, 'live'], ['Riverside Jazz Night', 'Concert', 16, 'Clarke Quay Riverside', 'Clarke Quay', 'raj', 95, 60, 30, 'live'],
    ['Futsal Finals', 'Sports', 25, 'OCBC Arena', 'Kallang', 'kai', 80, 45, 25, 'pending']];
  for (const [t, cat, d, v, loc, o, a, b, k, st, hot] of EV) {
    const e = (await c.query('insert into events(organiser_id,title,category,starts_at,venue,location,price_vip,price_std,price_con,status,high_demand) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',
      [id[o], t, cat, day(d), v, loc, a, b, k, st, !!hot])).rows[0];
    if (st !== 'live') continue;
    const o1 = (await c.query(`insert into orders(buyer_name,buyer_email,event_id,subtotal,total,payment_method,status) values('Demo buyers','demo@eventeaseplus.sg',$1,0,0,'card','paid') returning id`, [e.id])).rows[0].id;
    for (let i = 0; i < 80; i++) if (Math.random() < .3) { const s = String.fromCharCode(65 + (i / 10 | 0)) + (i % 10 + 1), r = i / 10 | 0; await c.query('insert into tickets(order_id,event_id,seat,tier,price) values($1,$2,$3,$4,$5)', [o1, e.id, s, r < 2 ? 'vip' : r < 7 ? 'std' : 'con', r < 2 ? a : r < 7 ? b : k]); }
  }
  console.log('Seeded local fixtures. Use the password provided through DEMO_SEED_PASSWORD.'); await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
