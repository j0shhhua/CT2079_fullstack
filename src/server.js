'use strict';
/* Eventeaseplus API: Express + PostgreSQL. Guests book with an X-Guest-Token header (random string, 16+ chars, made by the browser).
   Signed-in users send Authorization: Bearer <jwt>. Guests reopen orders with POST /api/orders/lookup, which returns an X-Order-Token. */
const path = require('path'), express = require('express'), cors = require('cors'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const { Pool } = require('pg'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), crypto = require('crypto');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses'), { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const E = process.env, JWT = E.JWT_SECRET, QR = E.QR_SECRET, BATCH = +E.QUEUE_BATCH || 20;
if (!JWT || !QR) { console.error('Set JWT_SECRET and QR_SECRET'); process.exit(1); }

const pool = new Pool({ connectionString: E.DATABASE_URL, ssl: E.DB_SSL === 'true' ? { rejectUnauthorized: false } : false, max: 8 });
const q = (t, p) => pool.query(t, p);
const ses = E.SES_FROM ? new SESClient({ region: E.AWS_REGION }) : null, sns = E.SMS_ENABLED === 'true' ? new SNSClient({ region: E.AWS_REGION }) : null;
const EMAIL = /^\S+@\S+\.\S+$/;
const phoneClean = p => String(p || '').replace(/[\s()-]/g, '');
const phoneOk = p => /^\+?\d{8,15}$/.test(phoneClean(p));
const phoneBad = 'Enter a valid phone number, for example +65 9123 4567 (8 to 15 digits)';

class HttpError extends Error { constructor(s, m, code) { super(m); this.s = s; this.code = code; } }
const bad = (s, m, code) => { throw new HttpError(s, m, code); };
const wrap = f => (req, res, next) => f(req, res, next).catch(next);
async function tx(fn) { const c = await pool.connect(); try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } }
const cfg = async () => Object.fromEntries((await q('select key,value from settings')).rows.map(r => [r.key, r.value]));
const mask = e => e[0] + '***' + e.slice(e.indexOf('@'));
const flag = (kind, detail, userId, orderId) => q('insert into fraud_flags(kind,detail,user_id,order_id) values($1,$2,$3,$4)', [kind, detail, userId || null, orderId || null]);

/* ---------- seats, pricing, QR ---------- */
const seatsOf = e => { const o = []; for (let i = 0; i < e.rows; i++) for (let n = 1; n <= e.cols; n++) o.push(String.fromCharCode(65 + i) + n); return o; };
const tierOf = (e, s) => { const i = s.charCodeAt(0) - 65; return i < 2 ? 'vip' : i < e.rows - 1 ? 'std' : 'con'; };
const priceOf = (e, s) => Number(e['price_' + tierOf(e, s)]);
const sg = (t, v) => crypto.createHmac('sha256', QR).update(`${t.id}.${v}.${t.event_id}.${t.seat}`).digest('base64url').slice(0, 16);
const qr = t => `EE.${t.id}.${t.qr_version}.${sg(t, t.qr_version)}`;
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const pub = e => ({ id: e.id, title: e.title, category: e.category, startsAt: e.starts_at, venue: e.venue, location: e.location, prices: { vip: +e.price_vip, std: +e.price_std, con: +e.price_con },
  rows: e.rows, cols: e.cols, status: e.status, highDemand: e.high_demand, capacity: e.rows * e.cols, ...(e.sold !== undefined ? { sold: e.sold, available: e.rows * e.cols - e.sold } : {}) });
const forecast = (e, sold) => { const dt = Math.max(0, (new Date(e.starts_at) - Date.now()) / 864e5), rate = sold / Math.max(1, 45 - dt), cap = e.rows * e.cols, pj = Math.min(cap, Math.round(sold + rate * dt * .8));
  return { perDay: +rate.toFixed(1), projected: pj, capacity: cap, advice: pj >= cap * .9 ? 'Likely to sell out. Consider the high-demand queue and a VIP price rise.' : pj < cap * .5 ? 'Demand is soft. Consider an early-bird push.' : 'On track.' }; };
async function getEvent(id, user, liveOnly) {
  const e = (await q('select * from events where id=$1', [Number(id) || 0])).rows[0];
  if (!e || (e.status !== 'live' && (liveOnly || !(user && (user.role === 'admin' || user.id === e.organiser_id))))) bad(404, 'Event not found');
  return e;
}

/* ---------- notifications (SES for email, SNS for SMS, WhatsApp is logged until you add a provider) ---------- */
async function notify({ userId, email, phone, channel = 'email', subject, body }) {
  let status = 'logged';
  try {
    if (channel === 'email' && ses && email) { await ses.send(new SendEmailCommand({ Source: E.SES_FROM, Destination: { ToAddresses: [email] }, Message: { Subject: { Data: subject }, Body: { Text: { Data: body } } } })); status = 'sent'; }
    else if (channel === 'sms' && sns && phone) { await sns.send(new PublishCommand({ PhoneNumber: phone, Message: body })); status = 'sent'; }
  } catch (e) { status = 'failed'; console.error('notify failed', e.message); }
  await q('insert into notifications(user_id,email,phone,channel,subject,body,status) values($1,$2,$3,$4,$5,$6,$7)', [userId || null, email, phone || null, channel, subject, body, status]);
}
const notifyOrder = async (o, subject, body) => { const base = { userId: o.user_id, email: o.buyer_email, phone: o.buyer_phone, subject, body };
  await notify({ ...base, channel: 'email' }); if (o.alert_channel !== 'email') await notify({ ...base, channel: o.alert_channel }); };

/* ---------- payments: simulated by default, Stripe test mode when STRIPE_SECRET_KEY is set ---------- */
async function charge(method, amount, token) {
  if (amount <= 0) return 'FREE';
  if (method === 'stripe' && E.STRIPE_SECRET_KEY) {
    if (!token) bad(400, 'Missing Stripe payment method');
    const stripe = require('stripe')(E.STRIPE_SECRET_KEY);
    const pi = await stripe.paymentIntents.create({ amount: Math.round(amount * 100), currency: 'sgd', payment_method: token, confirm: true, automatic_payment_methods: { enabled: true, allow_redirects: 'never' } }).catch(e => bad(402, e.message));
    if (pi.status !== 'succeeded') bad(402, 'Payment was not completed');
    return pi.id;
  }
  if (token === 'decline') bad(402, 'Payment declined (simulated)');
  return 'SIM-' + crypto.randomBytes(6).toString('hex');
}
async function refund(ref, amount) {
  if (ref && ref.startsWith('pi_') && E.STRIPE_SECRET_KEY) await require('stripe')(E.STRIPE_SECRET_KEY).refunds.create({ payment_intent: ref, amount: Math.round(amount * 100) });
}

/* ---------- auth ---------- */
const sign = u => jwt.sign({ id: u.id, role: u.role }, JWT, { expiresIn: '8h' });
async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) { try { const p = jwt.verify(h.slice(7), JWT); req.user = (await q('select id,name,email,phone,role,organiser_approved,points,referral_code from users where id=$1', [p.id])).rows[0]; } catch { /* treated as guest */ } }
    const g = req.headers['x-guest-token']; req.holder = req.user ? req.user.id : (g && g.length >= 16 ? 'g:' + g : null);
    next();
  } catch (e) { next(e); }
}
const need = (...roles) => (req, res, next) => !req.user ? next(new HttpError(401, 'Sign in required')) : !roles.includes(req.user.role) ? next(new HttpError(403, 'Not allowed for your role')) : next();

async function orderFor(req, id) {
  const o = (await q('select * from orders where id=$1', [Number(id) || 0])).rows[0]; if (!o) bad(404, 'Order not found');
  let ok = req.user && (req.user.role === 'admin' || o.user_id === req.user.id), tok = req.headers['x-order-token'];
  if (!ok && tok) { try { ok = String(jwt.verify(tok, JWT).orderId) === String(o.id); } catch { /* invalid token */ } }
  if (!ok) bad(403, 'Not your order'); return o;
}
async function orderView(o) {
  const t = (await q('select t.*,e.title,e.starts_at,e.venue from tickets t join events e on e.id=t.event_id where t.order_id=$1 order by t.seat', [o.id])).rows;
  const l = (await q(`select id,ticket_id,price from resale_listings where status='open' and ticket_id=any($1)`, [t.map(x => x.id)])).rows;
  return { id: String(o.id), eventId: o.event_id, status: o.status, total: +o.total, discount: +o.discount, paymentMethod: o.payment_method, createdAt: o.created_at, buyer: { name: o.buyer_name, email: o.buyer_email },
    tickets: t.map(x => ({ id: String(x.id), seat: x.seat, tier: x.tier, faceValue: +x.price, status: x.status, qr: x.status === 'valid' ? qr(x) : null, eventTitle: x.title, startsAt: x.starts_at, venue: x.venue, resale: l.find(r => String(r.ticket_id) === String(x.id)) || null })) };
}
function buyerOf(req) {
  const b = req.body || {}, u = req.user;
  if (!req.holder) bad(400, 'Missing X-Guest-Token or sign-in');
  const buyer = u ? { name: u.name, email: u.email, phone: (b.buyer && b.buyer.phone) || u.phone } : { name: ((b.buyer || {}).name || '').trim(), email: ((b.buyer || {}).email || '').trim(), phone: ((b.buyer || {}).phone || '').trim() };
  if (!buyer.name || !EMAIL.test(buyer.email)) bad(400, 'Enter your name and a valid email so we can send your tickets');
  if (buyer.phone && !phoneOk(buyer.phone)) bad(400, phoneBad);
  if (buyer.phone) buyer.phone = phoneClean(buyer.phone);
  const ch = ['email', 'sms', 'whatsapp'].includes(b.alertChannel) ? b.alertChannel : 'email';
  if (ch !== 'email' && !buyer.phone) bad(400, 'Add a phone number for SMS or WhatsApp alerts');
  if (!['card', 'paynow', 'stripe'].includes(b.paymentMethod)) bad(400, 'Unsupported payment method');
  return { buyer, ch, method: b.paymentMethod, b };
}
const insertOrder = (cl, o) => cl.query(`insert into orders(user_id,buyer_name,buyer_email,buyer_phone,event_id,subtotal,discount,total,promo_code,payment_method,payment_ref,alert_channel)
  values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`, [o.userId || null, o.name, o.email, o.phone || null, o.eventId, o.subtotal || 0, o.discount || 0, o.total || 0, o.promo || null, o.method, o.ref || null, o.ch || 'email']).then(r => r.rows[0]);

/* ---------- queue ---------- */
async function admitBatch(eventId) {
  await q(`update queue_entries set status='done' where event_id=$1 and status='admitted' and admitted_until<now()`, [eventId]);
  const n = +(await q(`select count(*) from queue_entries where event_id=$1 and status='admitted'`, [eventId])).rows[0].count;
  if (n < BATCH) await q(`update queue_entries set status='admitted',admitted_until=now()+interval '10 minutes' where id in (select id from queue_entries where event_id=$1 and status='waiting' order by id limit $2)`, [eventId, BATCH - n]);
}
async function requireAdmitted(eventId, holder) {
  if (!holder) bad(400, 'Missing X-Guest-Token or sign-in');
  await admitBatch(eventId);
  const r = await q(`select 1 from queue_entries where event_id=$1 and holder=$2 and status='admitted' and admitted_until>now()`, [eventId, holder]);
  if (!r.rowCount) bad(403, 'This event has a waiting room. Join the queue first.', 'QUEUE_REQUIRED');
}

/* ---------- app ---------- */
const app = express(); app.set('trust proxy', 1);
const CSP = { useDefaults: true, directives: { 'script-src': ["'self'", 'https://cdnjs.cloudflare.com'], 'style-src': ["'self'", 'https:', "'unsafe-inline'"], 'font-src': ["'self'", 'https:', 'data:'], 'img-src': ["'self'", 'data:'], 'upgrade-insecure-requests': null } };
app.use(helmet({ contentSecurityPolicy: CSP }), cors({ origin: E.CORS_ORIGINS ? E.CORS_ORIGINS.split(',') : false, allowedHeaders: ['Content-Type', 'Authorization', 'X-Guest-Token', 'X-Order-Token', 'X-Cron-Secret'] }), express.json({ limit: '100kb' }));
app.get('/config.js', (req, res) => res.type('js').send(`window.EE=${JSON.stringify({ demo: E.DEMO_LOGINS === 'true' })};`));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 600 }));
const strict = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 });
app.use(auth);

app.get('/health', wrap(async (req, res) => { await q('select 1'); res.json({ ok: true }); }));

// Accounts
app.post('/api/auth/register', strict, wrap(async (req, res) => {
  const { name, email, password, phone, role } = req.body || {};
  if (!name || !EMAIL.test(email || '') || (password || '').length < 8) bad(400, 'Name, valid email and a password of 8+ characters are required');
  if ((await q('select 1 from users where lower(email)=lower($1)', [email])).rowCount) bad(409, 'That email is already registered');
  if (phone && !phoneOk(phone)) bad(400, phoneBad);
  const r = role === 'organiser' ? 'organiser' : 'customer';
  const u = (await q(`insert into users(name,email,phone,password_hash,role,referral_code) values($1,$2,$3,$4,$5,$6) returning id,name,email,role,organiser_approved,points,referral_code`,
    [name.trim(), email.trim(), phone ? phoneClean(phone) : null, await bcrypt.hash(password, 10), r, 'REF-' + crypto.randomBytes(3).toString('hex').toUpperCase()])).rows[0];
  res.status(201).json({ token: sign(u), user: u });
}));
app.post('/api/auth/login', strict, wrap(async (req, res) => {
  const u = (await q('select * from users where lower(email)=lower($1)', [(req.body || {}).email || ''])).rows[0];
  if (!u || !(await bcrypt.compare((req.body || {}).password || '', u.password_hash))) bad(401, 'Email or password is incorrect');
  const { password_hash, ...safe } = u; res.json({ token: sign(u), user: safe });
}));
app.get('/api/me', need('customer', 'organiser', 'admin'), (req, res) => res.json(req.user));
app.put('/api/me', need('customer', 'organiser', 'admin'), strict, wrap(async (req, res) => {
  const b = req.body || {}, name = String(b.name || '').trim();
  if (!name) bad(400, 'Name is required');
  if (b.phone && !phoneOk(b.phone)) bad(400, phoneBad);
  if (b.newPassword) {
    if (String(b.newPassword).length < 8) bad(400, 'New password must be 8+ characters');
    const cur = (await q('select password_hash from users where id=$1', [req.user.id])).rows[0];
    if (!(await bcrypt.compare(String(b.currentPassword || ''), cur.password_hash))) bad(400, 'Current password is incorrect');
    await q('update users set password_hash=$2 where id=$1', [req.user.id, await bcrypt.hash(String(b.newPassword), 10)]);
  }
  const u = (await q('update users set name=$2, phone=$3 where id=$1 returning id,name,email,phone,role,organiser_approved,points,referral_code', [req.user.id, name, b.phone ? phoneClean(b.phone) : null])).rows[0];
  res.json(u);
}));
app.get('/api/notifications', need('customer', 'organiser', 'admin'), wrap(async (req, res) => res.json((await q('select channel,subject,body,status,created_at from notifications where user_id=$1 order by id desc limit 20', [req.user.id])).rows)));

// Discovery
app.get('/api/events', wrap(async (req, res) => {
  const { q: s, category, location, from, maxPrice } = req.query;
  const r = await q(`select e.*,(select count(*) from tickets t where t.event_id=e.id and t.status in ('valid','used'))::int sold from events e where e.status='live'
    and ($1::text is null or e.title ilike '%'||$1||'%' or e.venue ilike '%'||$1||'%') and ($2::text is null or e.category=$2) and ($3::text is null or e.location=$3)
    and ($4::date is null or e.starts_at>=$4) and ($5::numeric is null or least(e.price_vip,e.price_std,e.price_con)<=$5) order by e.starts_at`, [s || null, category || null, location || null, from || null, maxPrice || null]);
  res.json(r.rows.map(pub));
}));
app.get('/api/events/:id', wrap(async (req, res) => res.json(pub(await getEvent(req.params.id, req.user)))));
app.get('/api/events/:id/seats', wrap(async (req, res) => {
  const e = await getEvent(req.params.id, req.user), staff = req.user && (req.user.role === 'admin' || req.user.id === e.organiser_id);
  if (e.high_demand && !staff) await requireAdmitted(e.id, req.holder);
  const sold = (await q(`select seat from tickets where event_id=$1 and status in ('valid','used')`, [e.id])).rows.map(r => r.seat);
  const held = (await q('select seat,holder,expires_at from seat_holds where event_id=$1 and expires_at>now()', [e.id])).rows;
  const resale = (await q(`select l.id,l.price,t.seat,t.price face from resale_listings l join tickets t on t.id=l.ticket_id where l.status='open' and t.event_id=$1 and t.status='valid'`, [e.id])).rows;
  res.json({ event: pub(e), seats: seatsOf(e), sold, held: held.filter(h => h.holder !== req.holder).map(h => h.seat), mine: held.filter(h => h.holder === req.holder).map(h => h.seat), holdExpiresAt: held.filter(h => h.holder === req.holder).map(h => h.expires_at).sort()[0] || null, resale });
}));

// Smart queue
async function queueStatus(req, res) {
  const e = await getEvent(req.params.id, req.user, true); await admitBatch(e.id);
  const me = (await q(`select * from queue_entries where event_id=$1 and holder=$2 and status in ('waiting','admitted') order by id desc limit 1`, [e.id, req.holder || ''])).rows[0];
  if (!me) return res.json({ status: e.high_demand ? 'none' : 'open' });
  const ahead = me.status === 'waiting' ? +(await q(`select count(*) from queue_entries where event_id=$1 and status='waiting' and id<$2`, [e.id, me.id])).rows[0].count : 0;
  res.json({ status: me.status, ahead, admittedUntil: me.admitted_until });
}
app.post('/api/events/:id/queue/join', wrap(async (req, res) => {
  const e = await getEvent(req.params.id, req.user, true); if (!req.holder) bad(400, 'Missing X-Guest-Token or sign-in');
  if (!(await q(`select 1 from queue_entries where event_id=$1 and holder=$2 and status in ('waiting','admitted')`, [e.id, req.holder])).rowCount) await q('insert into queue_entries(event_id,holder) values($1,$2)', [e.id, req.holder]);
  return queueStatus(req, res);
}));
app.get('/api/events/:id/queue', wrap(queueStatus));

// Seat holds (replace the caller's whole hold set atomically)
app.put('/api/events/:id/holds', wrap(async (req, res) => {
  if (!req.holder) bad(400, 'Missing X-Guest-Token or sign-in');
  const e = await getEvent(req.params.id, req.user, true), seats = [...new Set((req.body || {}).seats || [])], c = await cfg(), all = new Set(seatsOf(e));
  if (seats.length > c.max_seats) bad(400, `Maximum ${c.max_seats} seats per order`);
  if (seats.some(s => !all.has(s))) bad(400, 'Unknown seat');
  if (e.high_demand) await requireAdmitted(e.id, req.holder);
  const expires = await tx(async cl => {
    await cl.query('delete from seat_holds where event_id=$1 and (holder=$2 or expires_at<=now())', [e.id, req.holder]);
    if (seats.length) { const s = await cl.query(`select seat from tickets where event_id=$1 and seat=any($2) and status in ('valid','used')`, [e.id, seats]); if (s.rowCount) bad(409, `Seat ${s.rows[0].seat} is already sold`); }
    const exp = new Date(Date.now() + c.hold_minutes * 60000);
    for (const s of seats) if (!(await cl.query('insert into seat_holds(event_id,seat,holder,expires_at) values($1,$2,$3,$4) on conflict do nothing', [e.id, s, req.holder, exp])).rowCount) bad(409, `Seat ${s} was just taken by another buyer`);
    return exp;
  });
  res.json({ seats, expiresAt: seats.length ? expires : null });
}));

// Checkout (guests and customers)
async function price(cl, e, seats, b, user) {
  const sub = seats.reduce((t, s) => t + priceOf(e, s), 0); let disc = 0, promo = null, referrer = null, pts = 0;
  if (b.promoCode) {
    const code = String(b.promoCode).trim().toUpperCase();
    const p = (await cl.query('select * from promo_codes where code=$1 and active and (valid_until is null or valid_until>now()) and (usage_limit is null or used<usage_limit)', [code])).rows[0];
    if (p) { disc = sub * p.percent / 100; promo = code; }
    else { const r = (await cl.query('select id from users where referral_code=$1', [code])).rows[0]; if (r && (!user || r.id !== user.id)) { disc = sub * .05; promo = code; referrer = r.id; } else bad(400, 'Promo or referral code not recognised'); }
  }
  if (b.usePoints && user && user.points >= 10) pts = Math.min(Math.floor(user.points / 10), Math.floor((sub - disc) * .2));
  disc = Math.round((disc + pts) * 100) / 100;
  return { sub, disc, total: Math.max(0, sub - disc), promo, referrer, pts };
}
app.post('/api/checkout', wrap(async (req, res) => {
  const { buyer, ch, method, b } = buyerOf(req);
  const r = await tx(async cl => {
    const e = (await cl.query(`select * from events where id=$1 and status='live'`, [Number(b.eventId) || 0])).rows[0]; if (!e) bad(404, 'Event not found');
    const holds = (await cl.query('select seat from seat_holds where event_id=$1 and holder=$2 and expires_at>now() order by seat for update', [e.id, req.holder])).rows.map(x => x.seat);
    if (!holds.length) bad(409, 'Your seat hold expired. Choose seats again.');
    const u = req.user ? (await cl.query('select * from users where id=$1 for update', [req.user.id])).rows[0] : null;
    const p = await price(cl, e, holds, b, u), ref = await charge(method, p.total, b.paymentToken);
    const o = await insertOrder(cl, { userId: u && u.id, ...buyer, eventId: e.id, subtotal: p.sub, discount: p.disc, total: p.total, promo: p.promo, method, ref, ch });
    for (const s of holds) await cl.query('insert into tickets(order_id,event_id,seat,tier,price) values($1,$2,$3,$4,$5)', [o.id, e.id, s, tierOf(e, s), priceOf(e, s)]);
    await cl.query('delete from seat_holds where event_id=$1 and holder=$2', [e.id, req.holder]);
    await cl.query(`update queue_entries set status='done' where event_id=$1 and holder=$2 and status='admitted'`, [e.id, req.holder]);
    if (p.promo) await cl.query('update promo_codes set used=used+1 where code=$1', [p.promo]);
    const give = async (uid, delta, why) => { await cl.query('update users set points=points+$2 where id=$1', [uid, delta]); await cl.query('insert into loyalty_ledger(user_id,delta,reason,order_id) values($1,$2,$3,$4)', [uid, delta, why, o.id]); };
    if (u) { if (p.pts) await give(u.id, -p.pts * 10, 'Points redeemed'); const earn = Math.floor(p.total / 10); if (earn) await give(u.id, earn, 'Purchase'); }
    if (p.referrer) await give(p.referrer, 50, 'Referral reward');
    const recent = +(await cl.query(`select count(*) from orders where lower(buyer_email)=lower($1) and created_at>now()-interval '10 minutes'`, [buyer.email])).rows[0].count;
    return { o, e, holds, recent };
  });
  if (r.holds.length > 6) await flag('bulk_purchase', `${r.holds.length} seats in one order`, r.o.user_id, r.o.id);
  if (r.recent >= 3) await flag('rapid_orders', `${buyer.email}: ${r.recent} orders in 10 minutes`, r.o.user_id, r.o.id);
  await notifyOrder(r.o, `Order #${r.o.id} confirmed`, `Thanks ${buyer.name}. ${r.e.title}, seats ${r.holds.join(', ')}. Total S$${r.o.total}. Open your tickets at your Eventeaseplus account or with Find my order.`);
  res.status(201).json({ order: await orderView(r.o), orderToken: req.user ? undefined : jwt.sign({ orderId: String(r.o.id) }, JWT, { expiresIn: '24h' }) });
}));

app.post('/api/quote', wrap(async (req, res) => {
  const b = req.body || {}, e = await getEvent(b.eventId, req.user, true);
  const holds = req.holder ? (await q('select seat from seat_holds where event_id=$1 and holder=$2 and expires_at>now()', [e.id, req.holder])).rows.map(x => x.seat) : [];
  if (!holds.length) return res.json({ subtotal: 0, discount: 0, total: 0, seats: [] });
  const p = await price(pool, e, holds, b, req.user && req.user.role === 'customer' ? req.user : null);
  res.json({ subtotal: p.sub, discount: p.disc, total: p.total, promo: p.promo, seats: holds });
}));

// Orders and tickets
app.get('/api/orders/mine', need('customer', 'organiser', 'admin'), wrap(async (req, res) => {
  const os = (await q('select * from orders where user_id=$1 order by created_at desc', [req.user.id])).rows; res.json(await Promise.all(os.map(orderView)));
}));
app.post('/api/orders/lookup', strict, wrap(async (req, res) => {
  const o = (await q('select * from orders where id=$1 and lower(buyer_email)=lower($2)', [Number((req.body || {}).orderId) || 0, (req.body || {}).email || ''])).rows[0];
  if (!o) bad(404, 'No order matches that number and email');
  res.json({ order: await orderView(o), orderToken: jwt.sign({ orderId: String(o.id) }, JWT, { expiresIn: '2h' }) });
}));
app.get('/api/orders/:id', wrap(async (req, res) => res.json(await orderView(await orderFor(req, req.params.id)))));
app.post('/api/orders/:id/cancel', wrap(async (req, res) => {
  const o = await orderFor(req, req.params.id), c = await cfg();
  if (o.status !== 'paid') bad(409, 'Order is already cancelled');
  if (['transfer', 'resale'].includes(o.payment_method)) bad(400, 'Transferred and resale tickets cannot be refunded. List them for resale instead.');
  const e = (await q('select * from events where id=$1', [o.event_id])).rows[0];
  if ((new Date(e.starts_at) - Date.now()) / 36e5 < c.refund_hours) bad(409, `Refunds close ${c.refund_hours} hours before the event`);
  const amount = await tx(async cl => {
    const t = (await cl.query(`select id,price from tickets where order_id=$1 and status='valid' for update`, [o.id])).rows;
    if (!t.length) bad(409, 'No refundable tickets left in this order');
    const amt = Math.round(t.reduce((s, x) => s + +x.price, 0) * (+o.total / Math.max(1, +o.subtotal)) * 100) / 100;
    await cl.query(`update tickets set status='cancelled' where order_id=$1 and status='valid'`, [o.id]);
    await cl.query(`update resale_listings set status='withdrawn' where status='open' and ticket_id=any($1)`, [t.map(x => x.id)]);
    await cl.query(`update orders set status='cancelled' where id=$1`, [o.id]);
    if (o.user_id) { const earned = Math.floor(+o.total / 10); await cl.query('update users set points=greatest(0,points-$2) where id=$1', [o.user_id, earned]); await cl.query(`insert into loyalty_ledger(user_id,delta,reason,order_id) values($1,$2,'Order cancelled',$3)`, [o.user_id, -earned, o.id]); }
    return amt;
  });
  await refund(o.payment_ref, amount);
  await notifyOrder(o, `Order #${o.id} cancelled`, `Your order was cancelled and S$${amount} will be refunded to your original payment method.`);
  res.json({ ok: true, refunded: amount });
}));

async function lockTicket(cl, req, id) {
  const t = (await cl.query('select t.*,e.starts_at from tickets t join events e on e.id=t.event_id where t.id=$1 for update of t', [Number(id) || 0])).rows[0];
  if (!t) bad(404, 'Ticket not found'); await orderFor(req, t.order_id);
  if (t.status !== 'valid') bad(409, 'Ticket is not valid'); if (new Date(t.starts_at) <= new Date()) bad(409, 'The event has already started'); return t;
}
app.post('/api/tickets/:id/transfer', wrap(async (req, res) => {
  const email = String((req.body || {}).toEmail || '').trim().toLowerCase(); if (!EMAIL.test(email)) bad(400, 'Enter a valid email to transfer to');
  const r = await tx(async cl => {
    const t = await lockTicket(cl, req, req.params.id);
    if ((await cl.query(`select 1 from resale_listings where ticket_id=$1 and status='open'`, [t.id])).rowCount) bad(409, 'Withdraw the resale listing first');
    const to = (await cl.query('select id,name from users where lower(email)=$1', [email])).rows[0];
    const o = await insertOrder(cl, { userId: to && to.id, name: to ? to.name : email.split('@')[0], email, eventId: t.event_id, method: 'transfer' });
    await cl.query('update tickets set order_id=$1,qr_version=qr_version+1 where id=$2', [o.id, t.id]); return { o, t };
  });
  await notifyOrder(r.o, `A ticket was transferred to you`, `Seat ${r.t.seat} is now yours. Open it with order #${r.o.id} and this email on Eventeaseplus (Find my order). The sender's QR code no longer works.`);
  res.json({ ok: true });
}));
app.post('/api/tickets/:id/resale', wrap(async (req, res) => {
  const p = Number((req.body || {}).price);
  const l = await tx(async cl => {
    const t = await lockTicket(cl, req, req.params.id); if (!(p > 0) || p > +t.price) bad(400, `Resale price must be above 0 and no higher than face value (S$${t.price})`);
    if ((await cl.query(`select 1 from resale_listings where ticket_id=$1 and status='open'`, [t.id])).rowCount) bad(409, 'Already listed');
    return (await cl.query('insert into resale_listings(ticket_id,seller_order_id,price) values($1,$2,$3) returning *', [t.id, t.order_id, p])).rows[0];
  });
  res.status(201).json(l);
}));
app.delete('/api/resale/:id', wrap(async (req, res) => {
  const l = (await q(`select * from resale_listings where id=$1 and status='open'`, [Number(req.params.id) || 0])).rows[0]; if (!l) bad(404, 'Listing not found');
  await orderFor(req, l.seller_order_id); await q(`update resale_listings set status='withdrawn' where id=$1`, [l.id]); res.json({ ok: true });
}));
app.post('/api/resale/:id/buy', wrap(async (req, res) => {
  const { buyer, ch, method, b } = buyerOf(req);
  const r = await tx(async cl => {
    const l = (await cl.query(`select * from resale_listings where id=$1 and status='open' for update`, [Number(req.params.id) || 0])).rows[0]; if (!l) bad(404, 'Listing is no longer available');
    const t = (await cl.query('select * from tickets where id=$1 for update', [l.ticket_id])).rows[0], so = (await cl.query('select * from orders where id=$1', [l.seller_order_id])).rows[0];
    if (t.status !== 'valid') bad(409, 'Ticket is no longer valid'); if (req.user && so.user_id === req.user.id) bad(400, 'You cannot buy your own ticket');
    const ref = await charge(method, +l.price, b.paymentToken);
    const o = await insertOrder(cl, { userId: req.user && req.user.id, ...buyer, eventId: t.event_id, subtotal: l.price, total: l.price, method: 'resale', ref, ch });
    await cl.query('update tickets set order_id=$1,qr_version=qr_version+1 where id=$2', [o.id, t.id]); await cl.query(`update resale_listings set status='sold' where id=$1`, [l.id]);
    return { o, t, so, l };
  });
  await notifyOrder(r.o, `Resale ticket confirmed`, `Seat ${r.t.seat} is yours for S$${r.l.price}. Order #${r.o.id}.`);
  await notifyOrder(r.so, `Your ticket sold`, `Your resale of seat ${r.t.seat} sold for S$${r.l.price}. The old QR code no longer works.`);
  res.status(201).json({ order: await orderView(r.o), orderToken: req.user ? undefined : jwt.sign({ orderId: String(r.o.id) }, JWT, { expiresIn: '24h' }) });
}));

// Gate validation (organiser of the event, or admin)
const GATE_OPEN_H = 2, GATE_CLOSE_H = 8; // gates accept scans from 2 hours before start until 8 hours after
app.post('/api/gate/scan', need('organiser'), wrap(async (req, res) => {
  const code = String((req.body || {}).code || '').trim(), p = code.split('.');
  const forged = async () => { await flag('forged_scan', code.slice(0, 80), req.user.id); res.status(422).json({ admit: false, reason: 'Signature check failed. Logged for admin review.' }); };
  if (p.length !== 4 || p[0] !== 'EE' || !/^\d+$/.test(p[1]) || !/^\d+$/.test(p[2])) return forged();
  const t = (await q('select t.*,e.organiser_id,e.title,e.starts_at from tickets t join events e on e.id=t.event_id where t.id=$1', [p[1]])).rows[0];
  if (!t || !safeEq(sg(t, p[2]), p[3])) return forged();
  if (t.organiser_id !== req.user.id) return res.status(403).json({ admit: false, reason: 'This ticket is for another organiser' });
  if (String(t.qr_version) !== p[2]) return res.json({ admit: false, reason: 'This QR was replaced after a transfer or resale' });
  if (t.status === 'cancelled') return res.json({ admit: false, reason: 'Ticket was cancelled' });
  if (t.status === 'used') return res.json({ admit: false, reason: 'Ticket already used' });
  const start = new Date(t.starts_at).getTime(), nowMs = Date.now();
  if (nowMs < start - GATE_OPEN_H * 36e5) return res.json({ admit: false, reason: `Too early. Gates open ${GATE_OPEN_H} hours before the event, at ${new Date(start - GATE_OPEN_H * 36e5).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short' })} (Singapore time).` });
  if (nowMs > start + GATE_CLOSE_H * 36e5) return res.json({ admit: false, reason: 'This event has already finished.' });
  if (!(await q(`update tickets set status='used',used_at=now() where id=$1 and status='valid' returning id`, [t.id])).rowCount) return res.json({ admit: false, reason: 'Ticket already used' });
  res.json({ admit: true, event: t.title, seat: t.seat });
}));

// Organiser
app.post('/api/organiser/events', need('organiser'), wrap(async (req, res) => {
  if (!req.user.organiser_approved) bad(403, 'An administrator must approve your organiser account first');
  const b = req.body || {}, pr = [b.priceVip, b.priceStd, b.priceCon].map(Number), rows = Number(b.rows) || 8, cols = Number(b.cols) || 10;
  if (!b.title || !['Concert', 'Theatre', 'Sports', 'Cultural'].includes(b.category) || !b.venue || !b.location || isNaN(Date.parse(b.startsAt)) || new Date(b.startsAt) <= new Date() || pr.some(x => !(x > 0)) || rows < 3 || rows > 26 || cols < 1 || cols > 30)
    bad(400, 'Check title, category, a future date, venue, location, prices and seat grid size');
  const e = (await q('insert into events(organiser_id,title,category,starts_at,venue,location,price_vip,price_std,price_con,rows,cols) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',
    [req.user.id, b.title.trim(), b.category, b.startsAt, b.venue.trim(), b.location.trim(), ...pr, rows, cols])).rows[0];
  res.status(201).json(pub(e));
}));
app.put('/api/organiser/events/:id', need('organiser'), wrap(async (req, res) => {
  const e = (await q('select * from events where id=$1 and organiser_id=$2', [Number(req.params.id) || 0, req.user.id])).rows[0]; if (!e) bad(404, 'Event not found');
  if (e.status === 'cancelled') bad(409, 'A cancelled event cannot be edited');
  const b = req.body || {}, sold = +(await q(`select count(*) from tickets where event_id=$1 and status in ('valid','used')`, [e.id])).rows[0].count;
  const title = String(b.title ?? e.title).trim(), venue = String(b.venue ?? e.venue).trim(), location = String(b.location ?? e.location).trim(), category = b.category ?? e.category, startsAt = b.startsAt ?? e.starts_at;
  if (!title || !venue || !location || !['Concert', 'Theatre', 'Sports', 'Cultural'].includes(category) || isNaN(Date.parse(startsAt))) bad(400, 'Check title, category, date, venue and location');
  if (new Date(startsAt).getTime() !== new Date(e.starts_at).getTime() && new Date(startsAt) <= new Date()) bad(400, 'Choose a future date');
  let pr = [e.price_vip, e.price_std, e.price_con], rows = e.rows, cols = e.cols;
  const wantPrice = [b.priceVip, b.priceStd, b.priceCon].map(x => x === undefined ? undefined : Number(x)), wantGrid = b.rows !== undefined || b.cols !== undefined;
  const priceChanged = wantPrice.some((x, i) => x !== undefined && x !== +pr[i]), gridChanged = (b.rows !== undefined && Number(b.rows) !== e.rows) || (b.cols !== undefined && Number(b.cols) !== e.cols);
  if ((priceChanged || gridChanged) && sold > 0) bad(409, 'Prices and seat layout are locked once tickets are sold. You can still change the title, date, venue and location.');
  if (priceChanged) { pr = wantPrice.map((x, i) => x === undefined ? pr[i] : x); if (pr.some(x => !(Number(x) > 0))) bad(400, 'Prices must be above 0'); }
  if (gridChanged) { rows = Number(b.rows ?? rows); cols = Number(b.cols ?? cols); if (!(rows >= 3 && rows <= 26 && cols >= 1 && cols <= 30)) bad(400, 'Seat grid must be 3-26 rows and 1-30 seats per row'); }
  const status = e.status === 'rejected' ? 'pending' : e.status; // editing a rejected event resubmits it for approval
  const r = await tx(async cl => { if (gridChanged) await cl.query('delete from seat_holds where event_id=$1', [e.id]);
    return (await cl.query('update events set title=$2,category=$3,starts_at=$4,venue=$5,location=$6,price_vip=$7,price_std=$8,price_con=$9,rows=$10,cols=$11,status=$12 where id=$1 returning *', [e.id, title, category, startsAt, venue, location, ...pr, rows, cols, status])).rows[0]; });
  res.json(pub(r));
}));
app.get('/api/organiser/events', need('organiser'), wrap(async (req, res) => {
  const out = [];
  for (const e of (await q('select * from events where organiser_id=$1 order by starts_at', [req.user.id])).rows) {
    const tiers = (await q(`select tier,count(*)::int n from tickets where event_id=$1 and status in ('valid','used') group by tier`, [e.id])).rows, sold = tiers.reduce((t, x) => t + x.n, 0);
    const rev = (await q(`select coalesce(sum(total),0) v from orders where event_id=$1 and status='paid' and payment_method not in ('transfer','resale')`, [e.id])).rows[0].v;
    const orders = (await q(`select id,buyer_email,total,created_at from orders where event_id=$1 and status='paid' and payment_method not in ('transfer','resale') order by id desc limit 50`, [e.id])).rows;
    out.push({ ...pub(e), sold, tiers, revenue: +rev, forecast: forecast(e, sold), orders: orders.map(o => ({ id: String(o.id), buyer: mask(o.buyer_email), total: +o.total, createdAt: o.created_at })) });
  }
  res.json(out);
}));

// Admin
const adminOrCron = (req, res, next) => E.CRON_SECRET && req.headers['x-cron-secret'] === E.CRON_SECRET ? next() : need('admin')(req, res, next);
app.get('/api/admin/summary', need('admin'), wrap(async (req, res) => {
  const r = (await q(`select (select count(*) from events where status='live')::int live_events,(select count(*) from events where status='pending')::int pending_events,
    (select count(*) from orders where status='paid')::int orders,(select coalesce(sum(total),0) from orders where status='paid' and payment_method not in ('transfer','resale')) booked,
    (select count(*) from fraud_flags where not resolved)::int open_flags`)).rows[0]; res.json({ ...r, booked: +r.booked });
}));
app.get('/api/admin/organisers', need('admin'), wrap(async (req, res) => res.json((await q(`select id,name,email,organiser_approved from users where role='organiser' order by organiser_approved, created_at desc`)).rows)));
app.post('/api/admin/organisers/:id/approve', need('admin'), wrap(async (req, res) => { await q(`update users set organiser_approved=true where id=$1 and role='organiser'`, [req.params.id]); res.json({ ok: true }); }));
app.get('/api/admin/events', need('admin'), wrap(async (req, res) => res.json((await q(`select * from events where ($1::text is null or status=$1) order by (status='pending') desc, id desc`, [req.query.status || null])).rows.map(pub))));
app.patch('/api/admin/events/:id', need('admin'), wrap(async (req, res) => {
  const { status, highDemand } = req.body || {};
  if (status !== undefined && !['live', 'rejected', 'cancelled'].includes(status)) bad(400, 'Invalid status');
  const r = await q('update events set status=coalesce($2,status),high_demand=coalesce($3,high_demand) where id=$1 returning *', [Number(req.params.id) || 0, status || null, typeof highDemand === 'boolean' ? highDemand : null]);
  if (!r.rowCount) bad(404, 'Event not found'); res.json(pub(r.rows[0]));
}));
app.get('/api/admin/fraud', need('admin'), wrap(async (req, res) => res.json((await q('select * from fraud_flags where not resolved order by id desc limit 100')).rows)));
app.post('/api/admin/fraud/:id/resolve', need('admin'), wrap(async (req, res) => { await q('update fraud_flags set resolved=true where id=$1', [Number(req.params.id) || 0]); res.json({ ok: true }); }));
app.get('/api/admin/settings', need('admin'), wrap(async (req, res) => res.json(await cfg())));
app.put('/api/admin/settings', need('admin'), wrap(async (req, res) => {
  const lim = { hold_minutes: [1, 30], refund_hours: [0, 720], max_seats: [1, 20] };
  for (const [k, v] of Object.entries(req.body || {})) { if (!lim[k] || !Number.isInteger(v) || v < lim[k][0] || v > lim[k][1]) bad(400, `Invalid value for ${k}`); await q('update settings set value=$2 where key=$1', [k, v]); }
  res.json(await cfg());
}));
// Reminders for events in the next 3 days. Call from an EventBridge schedule with X-Cron-Secret, or from the admin panel.
app.post('/api/admin/reminders', adminOrCron, wrap(async (req, res) => {
  const os = (await q(`select o.*,e.title,e.starts_at,e.venue from orders o join events e on e.id=o.event_id where o.status='paid' and not o.reminded and e.status='live' and e.starts_at>now() and e.starts_at<=now()+interval '3 days'`)).rows;
  for (const o of os) { await notifyOrder({ ...o, alert_channel: o.alert_channel }, `Reminder: ${o.title}`, `${o.title} starts ${new Date(o.starts_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })} at ${o.venue}. Bring your QR ticket.`); await q('update orders set reminded=true where id=$1', [o.id]); }
  res.json({ sent: os.length });
}));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((e, req, res, next) => { // eslint-disable-line no-unused-vars
  if (e.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (e.s) return res.status(e.s).json({ error: e.message, code: e.code });
  if (e.code === '23505') return res.status(409).json({ error: 'That seat was just sold' });
  console.error(e); res.status(500).json({ error: 'Something went wrong' });
});

if (require.main === module) app.listen(+E.PORT || 3000, () => console.log('Eventeaseplus API on :' + (E.PORT || 3000)));
module.exports = app;
