'use strict';
/* Eventease API: Express + PostgreSQL. Opaque HttpOnly browser sessions and verified order recovery. */
const path = require('path'), express = require('express'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const { Pool } = require('pg'), bcrypt = require('bcryptjs'), crypto = require('crypto');
const { databaseConfig } = require('./db-config');
const { browserSecurity } = require('./browser-security');
const { paymentProvider } = require('./payment-provider');
const { commerce } = require('./commerce');
function createApp(overrides = {}) {
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses'), { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const E = overrides.env || process.env, JWT = E.JWT_SECRET, QR = E.QR_SECRET, BATCH = +E.QUEUE_BATCH || 20;
if (!JWT || !QR || JWT.length < 32 || QR.length < 32 || JWT === QR) throw new Error('Set distinct JWT_SECRET and QR_SECRET values of at least 32 characters');
if (E.CRON_SECRET && E.CRON_SECRET.length<32) throw new Error('CRON_SECRET must be at least 32 characters');

if (E.NODE_ENV === 'production' && !E.SES_FROM && !overrides.mailRecovery) throw new Error('Production requires SES_FROM for email verification');
const pool = overrides.pool || new Pool({ ...databaseConfig(E), max: 8 });
const provider = overrides.provider || paymentProvider(E);
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
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const pub = e => ({ id: e.id, title: e.title, category: e.category, startsAt: e.starts_at, venue: e.venue, location: e.location, bookingOpen: e.status === 'live' && new Date(e.starts_at).getTime() > Date.now(), prices: { vip: +e.price_vip, std: +e.price_std, con: +e.price_con },
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
const notifyOrder = async (o, subject, body) => { const base = { userId: o.user_id, email: o.buyer_email, phone: o.buyer_phone,
  subject: provider.demoMode ? '[Classroom demo] ' + subject : subject,
  body: provider.demoMode ? 'Classroom demo only. No real payment was taken and these tickets are not valid for entry.\n\n' + body : body };
  await notify({ ...base, channel: 'email' }); if (o.alert_channel !== 'email') await notify({ ...base, channel: o.alert_channel }); };

// Recovery codes are sent directly and are never stored in notification bodies or logs.
const mailRecovery = overrides.mailRecovery || (ses ? async (email, code) => {
  await ses.send(new SendEmailCommand({ Source: E.SES_FROM, Destination: { ToAddresses: [email] },
    Message: { Subject: { Data: 'Verify your Eventease access' }, Body: { Text: { Data: `Your verification code is ${code}. It expires in 10 minutes. Do not share this code.` } } } }));
} : null);
const security = browserSecurity({ pool, env: E, bad, wrap, mailRecovery });
const auth = security.auth, orderFor = security.orderFor;
const need = (...roles) => (req, res, next) => !req.user ? next(new HttpError(401, 'Sign in required')) : !roles.includes(req.user.role) ? next(new HttpError(403, 'Not allowed for your role')) : next();

async function orderView(o) {
  const pending = o.status === 'pending_payment' ? (await q("select checkout_url from payment_jobs where order_id=$1 and status='pending'",[o.id])).rows[0] : null;
  const checkoutUrl = pending?.checkout_url && /^https:\/\/checkout\.stripe\.com\//.test(pending.checkout_url) ? pending.checkout_url : undefined;
  const t = (await q('select t.*,e.title,e.starts_at,e.venue from tickets t join events e on e.id=t.event_id where t.order_id=$1 order by t.seat', [o.id])).rows;
  const l = (await q(`select id,ticket_id,price from resale_listings where status='open' and ticket_id=any($1)`, [t.map(x => x.id)])).rows;
  return { checkoutUrl, id: String(o.id), eventId: o.event_id, status: o.status, total: +o.total, discount: +o.discount, paymentMethod: o.payment_method, createdAt: o.created_at, buyer: { name: o.buyer_name, email: o.buyer_email },
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
 return tx(async cl => {
  await cl.query('select id from events where id=$1 for no key update',[eventId]);
  await cl.query(`update queue_entries set status='done' where event_id=$1 and status='admitted' and admitted_until<now()`, [eventId]);
  const n = +(await cl.query(`select count(*) from queue_entries where event_id=$1 and status='admitted'`, [eventId])).rows[0].count;
  if (n < BATCH) await cl.query(`update queue_entries set status='admitted',admitted_until=now()+interval '10 minutes' where id in (select id from queue_entries where event_id=$1 and status='waiting' order by id limit $2)`, [eventId, BATCH - n]);
 });
}
async function requireAdmitted(eventId, holder) {
  if (!holder) bad(400, 'Missing X-Guest-Token or sign-in');
  await admitBatch(eventId);
  const r = await q(`select 1 from queue_entries where event_id=$1 and holder=$2 and status='admitted' and admitted_until>now()`, [eventId, holder]);
  if (!r.rowCount) bad(403, 'This event has a waiting room. Join the queue first.', 'QUEUE_REQUIRED');
}

/* ---------- app ---------- */
const app = express(); app.disable('x-powered-by');
if (E.NODE_ENV === 'production' && (!E.ORIGIN_VERIFY_SECRET || E.ORIGIN_VERIFY_SECRET.length<32)) throw new Error('Production requires ORIGIN_VERIFY_SECRET');
app.use((req,res,next) => {
  if (E.NODE_ENV !== 'production' || req.path === '/health' || safeEq(String(req.get('X-Origin-Verify') || ''),E.ORIGIN_VERIFY_SECRET)) return next();
  res.status(403).json({error:'Origin access denied'});
});
app.set('trust proxy', E.TRUST_PROXY_CIDRS ? E.TRUST_PROXY_CIDRS.split(',').map(x => x.trim()) : false);
const CSP = { useDefaults: true, directives: { 'script-src': ["'self'"], 'style-src': ["'self'", 'https:', "'unsafe-inline'"], 'font-src': ["'self'", 'https:', 'data:'], 'img-src': ["'self'", 'data:'], 'upgrade-insecure-requests': null } };
const shop = commerce({ pool, tx, bad, wrap, buyerOf, orderFor, orderView, issueOrder: (res,id) => security.issue(res,'order',id), seatsOf, tierOf, priceOf, provider, notifyOrder, env: E });
app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '100kb' }), wrap(async (req,res) => {
  if (!provider.webhook) bad(503, 'Webhook not configured');
  let event; try { event = provider.webhook(req.body, req.get('Stripe-Signature')); } catch { bad(400, 'Invalid webhook signature'); }
  const jobId = event.data?.object?.metadata?.jobId;
  if (['checkout.session.completed','checkout.session.expired','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed'].includes(event.type) && /^[a-f0-9-]{36}$/.test(jobId || '')) await shop.runJob(jobId);
  res.json({ received: true });
}));
app.use(helmet({ contentSecurityPolicy: CSP }), express.json({ limit: '100kb' }));
app.get('/config.js', (req, res) => res.set('Cache-Control','no-store').type('js').send(`window.EE=${JSON.stringify({ paymentMethods: provider.methods, demoMode: provider.demoMode === true, resaleEnabled: E.NODE_ENV !== 'production' })};`));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', security.boundary, rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false }));
const strict = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api', (req,res,next) => {
  if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return next(new HttpError(400, 'Expected a JSON object'));
  const b = req.body || {};
  for (const [key,value] of Object.entries(b)) {
    if (typeof value === 'string' && value.length > (key.toLowerCase().includes('password') ? 128 : 1024)) return next(new HttpError(400, 'Input is too long'));
  }
  for (const key of ['email','password','currentPassword','newPassword','name','title','venue','location','phone','toEmail','promoCode','paymentMethod','alertChannel','startsAt']) {
    if (b[key] !== undefined && typeof b[key] !== 'string') return next(new HttpError(400, 'Invalid field type: ' + key));
  }
  if (b.buyer !== undefined && (!b.buyer || typeof b.buyer !== 'object' || Array.isArray(b.buyer) || Object.values(b.buyer).some(v => typeof v !== 'string' || v.length > 254))) return next(new HttpError(400, 'Invalid buyer details'));
  for (const key of ['password','newPassword']) if (b[key] && Buffer.byteLength(b[key],'utf8') > 72) return next(new HttpError(400, 'Password must be at most 72 bytes'));
  if (b.seats !== undefined && (!Array.isArray(b.seats) || b.seats.length > 20 || b.seats.some(v => typeof v !== 'string' || v.length > 4))) return next(new HttpError(400, 'Invalid seat selection'));
  if (b.usePoints !== undefined && typeof b.usePoints !== 'boolean') return next(new HttpError(400, 'Invalid points selection'));
  for (const key of ['priceVip','priceStd','priceCon','price']) if (b[key] !== undefined && (!Number.isFinite(Number(b[key])) || Number(b[key]) <= 0 || Number(b[key]) > 99999999.99 || Math.abs(Number(b[key])*100-Math.round(Number(b[key])*100)) > .000001)) return next(new HttpError(400, 'Invalid price'));
  for (const key of ['rows','cols']) if (b[key] !== undefined && !Number.isInteger(Number(b[key]))) return next(new HttpError(400, 'Seat dimensions must be integers'));
  if (b.email !== undefined && b.email.length > 254) return next(new HttpError(400, 'Invalid email'));
  if (b.name !== undefined && b.name.length > 120) return next(new HttpError(400, 'Name is too long'));
  next();
});
app.use(auth);
app.use('/api', security.sensitiveLimits);
security.routes(app);
shop.routes(app);

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
  if (u.role === 'organiser') return security.staffChallenge(res,u);
  await security.issue(res, 'account', u.id); res.status(201).json({ user: security.publicUser(u) });
}));
app.post('/api/auth/login', strict, wrap(async (req, res) => {
  const u = (await q('select * from users where lower(email)=lower($1)', [(req.body || {}).email || ''])).rows[0];
  if (!u || u.disabled || !(await bcrypt.compare((req.body || {}).password || '', u.password_hash))) bad(401, 'Email or password is incorrect');
  if (['admin','organiser'].includes(u.role)) return security.staffChallenge(res,u);
  await security.issue(res, 'account', u.id); res.json({ user: security.publicUser(u) });
}));
app.get('/api/me', need('customer', 'organiser', 'admin'), (req, res) => res.json(security.publicUser(req.user)));
app.put('/api/me', need('customer', 'organiser', 'admin'), strict, wrap(async (req, res) => {
  const b = req.body || {}, name = String(b.name || '').trim();
  if (!name) bad(400, 'Name is required');
  if (b.phone && !phoneOk(b.phone)) bad(400, phoneBad);
  if (b.newPassword) {
    if (String(b.newPassword).length < 8) bad(400, 'New password must be 8+ characters');
    const cur = (await q('select password_hash from users where id=$1', [req.user.id])).rows[0];
    if (!(await bcrypt.compare(String(b.currentPassword || ''), cur.password_hash))) bad(400, 'Current password is incorrect');
    await tx(async cl => { await cl.query('update users set password_hash=$2 where id=$1', [req.user.id, await bcrypt.hash(String(b.newPassword), 10)]); await cl.query('delete from browser_sessions where user_id=$1', [req.user.id]); await cl.query('update recovery_challenges set consumed_at=now() where user_id=$1 and consumed_at is null',[req.user.id]); });
    res.clearCookie('ee_session', security.clearOptions);
  }
  const u = (await q('update users set name=$2, phone=$3 where id=$1 returning id,name,email,phone,role,organiser_approved,points,referral_code', [req.user.id, name, b.phone ? phoneClean(b.phone) : null])).rows[0];
  res.json(u);
}));
app.get('/api/notifications', need('customer', 'organiser', 'admin'), wrap(async (req, res) => res.json((await q('select channel,subject,body,status,created_at from notifications where user_id=$1 order by id desc limit 20', [req.user.id])).rows)));

// Discovery
app.get('/api/events', wrap(async (req, res) => {
  const { q: s, category, location, from, maxPrice } = req.query;
  const r = await q(`select e.*,(select count(*) from tickets t where t.event_id=e.id and t.status in ('reserved','valid','used'))::int sold from events e where e.status='live' and e.starts_at>now()
    and ($1::text is null or e.title ilike '%'||$1||'%' or e.venue ilike '%'||$1||'%') and ($2::text is null or e.category=$2) and ($3::text is null or e.location=$3)
    and ($4::date is null or e.starts_at>=$4) and ($5::numeric is null or least(e.price_vip,e.price_std,e.price_con)<=$5) order by e.starts_at`, [s || null, category || null, location || null, from || null, maxPrice || null]);
  res.json(r.rows.map(pub));
}));
app.get('/api/events/:id', wrap(async (req, res) => res.json(pub(await getEvent(req.params.id, req.user)))));
app.get('/api/events/:id/seats', wrap(async (req, res) => {
  const e = await getEvent(req.params.id, req.user), staff = req.user && (req.user.role === 'admin' || req.user.id === e.organiser_id);
  if (new Date(e.starts_at).getTime() <= Date.now()) bad(409, 'This event has already started. Booking is closed.', 'EVENT_CLOSED');
  if (e.high_demand && !staff) await requireAdmitted(e.id, req.holder);
  const sold = (await q(`select seat from tickets where event_id=$1 and status in ('reserved','valid','used')`, [e.id])).rows.map(r => r.seat);
  const held = (await q('select seat,holder,expires_at from seat_holds where event_id=$1 and expires_at>now()', [e.id])).rows;
  const resale = (await q(`select l.id,l.price,t.seat,t.price face from resale_listings l join tickets t on t.id=l.ticket_id where l.status='open' and t.event_id=$1 and t.status='valid'`, [e.id])).rows;
  res.json({ event: pub(e), seats: seatsOf(e), sold, held: held.filter(h => h.holder !== req.holder).map(h => h.seat), mine: held.filter(h => h.holder === req.holder).map(h => h.seat), holdExpiresAt: held.filter(h => h.holder === req.holder).map(h => h.expires_at).sort()[0] || null, resale });
}));

// Smart queue
async function queueStatus(req, res) {
  const e = await getEvent(req.params.id, req.user, true);
  if (new Date(e.starts_at).getTime() <= Date.now()) bad(409, 'This event has already started. Booking is closed.', 'EVENT_CLOSED');
  await admitBatch(e.id);
  const me = (await q(`select * from queue_entries where event_id=$1 and holder=$2 and status in ('waiting','admitted') order by id desc limit 1`, [e.id, req.holder || ''])).rows[0];
  if (!me) return res.json({ status: e.high_demand ? 'none' : 'open' });
  const ahead = me.status === 'waiting' ? +(await q(`select count(*) from queue_entries where event_id=$1 and status='waiting' and id<$2`, [e.id, me.id])).rows[0].count : 0;
  res.json({ status: me.status, ahead, admittedUntil: me.admitted_until });
}
app.post('/api/events/:id/queue/join', wrap(async (req, res) => {
  const e = await getEvent(req.params.id, req.user, true); if (!req.holder) bad(400, 'Missing X-Guest-Token or sign-in');
  if (new Date(e.starts_at).getTime() <= Date.now()) bad(409, 'This event has already started. Booking is closed.', 'EVENT_CLOSED');
  await q("insert into queue_entries(event_id,holder) values($1,$2) on conflict(event_id,holder) where status in ('waiting','admitted') do nothing", [e.id, req.holder]);
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
    const current = (await cl.query("select * from events where id=$1 and status='live' and starts_at>now() for no key update", [e.id])).rows[0];
    if (!current || seats.some(s => !seatsOf(current).includes(s))) bad(409, 'Event or seats changed. Choose seats again.');
    await cl.query('delete from seat_holds where event_id=$1 and (holder=$2 or expires_at<=now())', [e.id, req.holder]);
    if (seats.length) { const s = await cl.query(`select seat from tickets where event_id=$1 and seat=any($2) and status in ('reserved','valid','used')`, [e.id, seats]); if (s.rowCount) bad(409, `Seat ${s.rows[0].seat} is already sold`); }
    const exp = new Date(Date.now() + c.hold_minutes * 60000);
    for (const s of seats) if (!(await cl.query('insert into seat_holds(event_id,seat,holder,expires_at) values($1,$2,$3,$4) on conflict do nothing', [e.id, s, req.holder, exp])).rowCount) bad(409, `Seat ${s} was just taken by another buyer`);
    return exp;
  });
  res.json({ seats, expiresAt: seats.length ? expires : null });
}));

// Orders and tickets
app.get('/api/orders/mine', need('customer', 'organiser', 'admin'), wrap(async (req, res) => {
  const os = (await q('select * from orders where user_id=$1 order by created_at desc', [req.user.id])).rows; res.json(await Promise.all(os.map(orderView)));
}));
app.get('/api/orders/:id', wrap(async (req, res) => res.json(await orderView(await orderFor(req, req.params.id)))));
async function lockTicket(cl, req, id) {
  const t = (await cl.query('select t.*,e.starts_at,e.status event_status from tickets t join events e on e.id=t.event_id where t.id=$1 for update of t', [Number(id) || 0])).rows[0];
  if (!t) bad(404, 'Ticket not found'); await orderFor(req, t.order_id, cl, true);
  if (t.status !== 'valid' || t.event_status !== 'live') bad(409, 'Ticket is not valid'); if (new Date(t.starts_at) <= new Date()) bad(409, 'The event has already started'); return t;
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
  await notifyOrder(r.o, `A ticket was transferred to you`, `Seat ${r.t.seat} is now yours. Open it with order #${r.o.id} and this email on Eventease (Find my order). The sender's QR code no longer works.`);
  res.json({ ok: true });
}));
app.post('/api/tickets/:id/resale', wrap(async (req, res) => {
  if (E.NODE_ENV === 'production') bad(503, 'Resale is unavailable until seller payouts are configured.');
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
  await orderFor(req, l.seller_order_id, pool, true); const changed = await q(`update resale_listings set status='withdrawn' where id=$1 and status='open' returning id`, [l.id]); if (!changed.rowCount) bad(409, 'Listing is no longer available'); res.json({ ok: true });
}));
// Gate validation by the event's organiser.
const GATE_OPEN_H = 2, GATE_CLOSE_H = 8; // gates accept scans from 2 hours before start until 8 hours after
app.post('/api/gate/scan', need('organiser'), wrap(async (req, res) => {
  const code = String((req.body || {}).code || '').trim(), p = code.split('.');
  const forged = async () => { await flag('forged_scan', code.slice(0, 80), req.user.id); res.status(422).json({ admit: false, reason: 'Signature check failed. Logged for admin review.' }); };
  if (p.length !== 4 || p[0] !== 'EE' || !/^\d+$/.test(p[1]) || !/^\d+$/.test(p[2])) return forged();
  const t = (await q('select t.*,e.organiser_id,e.title,e.starts_at,e.status event_status from tickets t join events e on e.id=t.event_id where t.id=$1', [p[1]])).rows[0];
  if (!t || !safeEq(sg(t, p[2]), p[3])) return forged();
  if (t.organiser_id !== req.user.id) return res.status(403).json({ admit: false, reason: 'This ticket is for another organiser' });
  if (String(t.qr_version) !== p[2]) return res.json({ admit: false, reason: 'This QR was replaced after a transfer or resale' });
  if (t.event_status !== 'live') return res.json({ admit: false, reason: 'Event is not active' });
  if (t.status === 'reserved') return res.json({ admit: false, reason: 'Ticket payment is pending' });
  if (t.status === 'cancelled') return res.json({ admit: false, reason: 'Ticket was cancelled' });
  if (t.status === 'used') return res.json({ admit: false, reason: 'Ticket already used' });
  const start = new Date(t.starts_at).getTime(), nowMs = Date.now();
  if (nowMs < start - GATE_OPEN_H * 36e5) return res.json({ admit: false, reason: `Too early. Gates open ${GATE_OPEN_H} hours before the event, at ${new Date(start - GATE_OPEN_H * 36e5).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short' })} (Singapore time).` });
  if (nowMs > start + GATE_CLOSE_H * 36e5) return res.json({ admit: false, reason: 'This event has already finished.' });
  if (!(await q(`update tickets set status='used',used_at=now() where id=$1 and status='valid' and qr_version=$2 returning id`, [t.id, Number(p[2])])).rowCount) return res.json({ admit: false, reason: 'Ticket already used' });
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
  const r = await tx(async cl => {
  const e = (await cl.query('select * from events where id=$1 and organiser_id=$2 for no key update', [Number(req.params.id) || 0, req.user.id])).rows[0]; if (!e) bad(404, 'Event not found');
  if (e.status === 'cancelled') bad(409, 'A cancelled event cannot be edited');
  const b = req.body || {}, sold = +(await cl.query(`select count(*) from tickets where event_id=$1 and status in ('reserved','valid','used')`, [e.id])).rows[0].count;
  const title = String(b.title ?? e.title).trim(), venue = String(b.venue ?? e.venue).trim(), location = String(b.location ?? e.location).trim(), category = b.category ?? e.category, startsAt = b.startsAt ?? e.starts_at;
  if (!title || !venue || !location || !['Concert', 'Theatre', 'Sports', 'Cultural'].includes(category) || isNaN(Date.parse(startsAt))) bad(400, 'Check title, category, date, venue and location');
  if (new Date(startsAt).getTime() !== new Date(e.starts_at).getTime() && new Date(startsAt) <= new Date()) bad(400, 'Choose a future date');
  if (new Date(startsAt).getTime() !== new Date(e.starts_at).getTime() &&
      (await cl.query("select 1 from orders where event_id=$1 and status='pending_payment' limit 1", [e.id])).rowCount)
    bad(409, 'The event start time cannot change while payments are pending. Wait for payment processing to finish.');
  let pr = [e.price_vip, e.price_std, e.price_con], rows = e.rows, cols = e.cols;
  const wantPrice = [b.priceVip, b.priceStd, b.priceCon].map(x => x === undefined ? undefined : Number(x)), wantGrid = b.rows !== undefined || b.cols !== undefined;
  const priceChanged = wantPrice.some((x, i) => x !== undefined && x !== +pr[i]), gridChanged = (b.rows !== undefined && Number(b.rows) !== e.rows) || (b.cols !== undefined && Number(b.cols) !== e.cols);
  if ((priceChanged || gridChanged) && sold > 0) bad(409, 'Prices and seat layout are locked once tickets are sold. You can still change the title, date, venue and location.');
  if (priceChanged) { pr = wantPrice.map((x, i) => x === undefined ? pr[i] : x); if (pr.some(x => !(Number(x) > 0))) bad(400, 'Prices must be above 0'); }
  if (gridChanged) { rows = Number(b.rows ?? rows); cols = Number(b.cols ?? cols); if (!(rows >= 3 && rows <= 26 && cols >= 1 && cols <= 30)) bad(400, 'Seat grid must be 3-26 rows and 1-30 seats per row'); }
  const status = e.status === 'rejected' ? 'pending' : e.status; // editing a rejected event resubmits it for approval
  if (gridChanged) await cl.query('delete from seat_holds where event_id=$1', [e.id]);
    return (await cl.query('update events set title=$2,category=$3,starts_at=$4,venue=$5,location=$6,price_vip=$7,price_std=$8,price_con=$9,rows=$10,cols=$11,status=$12 where id=$1 returning *', [e.id, title, category, startsAt, venue, location, ...pr, rows, cols, status])).rows[0]; });
  res.json(pub(r));
}));
app.get('/api/organiser/events', need('organiser'), wrap(async (req, res) => {
  const out = [];
  for (const e of (await q('select * from events where organiser_id=$1 order by starts_at', [req.user.id])).rows) {
    const tiers = (await q(`select tier,count(*)::int n from tickets where event_id=$1 and status in ('reserved','valid','used') group by tier`, [e.id])).rows, sold = tiers.reduce((t, x) => t + x.n, 0);
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
    (select count(*) from fraud_flags where not resolved)::int open_flags,(select count(*) from payment_jobs where status='pending')::int pending_payments`)).rows[0]; res.json({ ...r, booked: +r.booked });
}));
app.get('/api/admin/organisers', need('admin'), wrap(async (req, res) => res.json((await q(`select id,name,email,organiser_approved from users where role='organiser' order by organiser_approved, created_at desc`)).rows)));
app.post('/api/admin/organisers/:id/approve', need('admin'), wrap(async (req, res) => { await q(`update users set organiser_approved=true where id=$1 and role='organiser'`, [req.params.id]); res.json({ ok: true }); }));
app.get('/api/admin/events', need('admin'), wrap(async (req, res) => res.json((await q(`select * from events where ($1::text is null or status=$1) order by (status='pending') desc, id desc`, [req.query.status || null])).rows.map(pub))));
app.patch('/api/admin/events/:id', need('admin'), wrap(async (req, res) => {
  const { status, highDemand } = req.body || {};
  if (status !== undefined && !['live', 'rejected', 'cancelled'].includes(status)) bad(400, 'Invalid status');
  const event = await tx(async cl => {
    // Use the same event lock as checkout so a payment cannot start between this check and the status change.
    const e = (await cl.query('select * from events where id=$1 for no key update', [Number(req.params.id) || 0])).rows[0];
    if (!e) bad(404, 'Event not found');
    if (status !== undefined && status !== 'live' &&
        (await cl.query("select 1 from orders where event_id=$1 and status='pending_payment' limit 1", [e.id])).rowCount)
      bad(409, 'The event cannot leave live status while payments are pending. Wait for payment processing to finish.');
    return (await cl.query('update events set status=coalesce($2,status),high_demand=coalesce($3,high_demand) where id=$1 returning *', [e.id, status || null, typeof highDemand === 'boolean' ? highDemand : null])).rows[0];
  });
  res.json(pub(event));
}));
app.get('/api/admin/fraud', need('admin'), wrap(async (req, res) => res.json((await q('select * from fraud_flags where not resolved order by id desc limit 100')).rows)));
app.post('/api/admin/fraud/:id/resolve', need('admin'), wrap(async (req, res) => { await q('update fraud_flags set resolved=true where id=$1', [Number(req.params.id) || 0]); res.json({ ok: true }); }));
app.get('/api/admin/payment-jobs', need('admin'), wrap(async (req,res) => {
  res.json((await q(`select id,order_id,kind,status,attempts,last_error,next_attempt_at,created_at from payment_jobs where status='pending' order by created_at limit 100`)).rows);
}));
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
  console.error('Unhandled request failure',e.name,e.code || ''); res.status(500).json({ error: 'Something went wrong' });
});

app.locals.pool = pool;
app.locals.reconcile = shop.reconcile;
app.locals.runPaymentJob = shop.runJob;
return app;
}
if (require.main === module) {
  const app = createApp();
  const server = app.listen(+process.env.PORT || 3000, () => console.log('Eventease API started'));
  let running = false;
  const timer = setInterval(async () => { if (running) return; running = true; try { await app.locals.reconcile(); } catch (e) { console.error('Background reconciliation failed',e.name); } finally { running = false; } }, 30000);
  timer.unref();
  process.on('SIGTERM', () => { clearInterval(timer); server.close(() => app.locals.pool.end().then(() => process.exit(0))); });
}
module.exports = { createApp };
