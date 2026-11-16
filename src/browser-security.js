'use strict';
const crypto = require('crypto');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x.length === 2));
const publicUser = u => Object.fromEntries(['id','name','email','phone','role','organiser_approved','points','referral_code'].map(k => [k, u[k]]));

function browserSecurity({ pool, env, bad, wrap, mailRecovery }) {
  const secure = env.NODE_ENV === 'production';
  const origin = env.APP_ORIGIN || 'http://localhost:3000';
  const parsed = new URL(origin);
  if (parsed.origin !== origin || (secure && parsed.protocol !== 'https:')) throw new Error('APP_ORIGIN must be an exact HTTPS origin in production');
  const options = { httpOnly: true, secure, sameSite: 'strict', path: '/api', maxAge: 2 * 3600000 };
  const clearOptions = { httpOnly: true, secure, sameSite: 'strict', path: '/api' };
  async function issue(res, kind, id) {
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query(`insert into browser_sessions(token_hash,kind,user_id,order_id,fresh_until,expires_at)
      values($1,$2,$3,$4,now()+interval '15 minutes',now()+interval '2 hours')`,
    [hash(token), kind, kind === 'account' ? id : null, kind === 'order' ? id : null]);
    res.cookie(kind === 'account' ? 'ee_session' : 'ee_order_' + id, token, options);
  }
  async function read(req, name, cl = pool) {
    const token = cookies(req)[name];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return (await cl.query('select * from browser_sessions where token_hash=$1 and expires_at>now()', [hash(token)])).rows[0] || null;
  }
  const auth = wrap(async (req, res, next) => {
    const s = await read(req, 'ee_session');
    if (s && s.kind === 'account') { req.session = s; req.user = (await pool.query('select * from users where id=$1 and not disabled', [s.user_id])).rows[0]; }
    const g = req.headers['x-guest-token'];
    req.holder = req.user ? req.user.id : typeof g === 'string' && /^[a-f0-9]{24,64}$/.test(g) ? 'g:' + g : null;
    next();
  });
  function boundary(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      const cron = req.path === '/admin/reminders' && env.CRON_SECRET && req.get('X-Cron-Secret') === env.CRON_SECRET;
      if (!cron && (req.get('Origin') !== origin || req.get('X-EE-Request') !== '1' || !req.is('application/json'))) return next(Object.assign(new Error('Request origin or content type is not allowed'), { s: 403 }));
    }
    next();
  }
  async function limit(key, max, seconds = 900) {
    const bucket = Math.floor(Date.now() / (seconds * 1000));
    const result = await pool.query(`insert into request_limits(key,count,expires_at) values($1,1,now()+$2*interval '1 second')
      on conflict(key) do update set count=request_limits.count+1 returning count`, [hash(key + ':' + bucket), seconds * 2]);
    if (result.rows[0].count > max) bad(429, 'Too many attempts. Please try again later.');
  }
  const sensitiveLimits = wrap(async (req, res, next) => {
    let group, max;
    if (/^\/auth\/(login|register|verify)$|^\/orders\/(lookup|verify)$/.test(req.path)) { group = 'identity'; max = 20; }
    else if (/holds$|queue\/join$/.test(req.path)) { group = 'reservations'; max = 60; }
    else if (/checkout$|\/buy$|\/cancel$|\/transfer$|\/resale$/.test(req.path) && req.method !== 'GET') { group = 'commerce'; max = 30; }
    else if (req.path === '/gate/scan') { group = 'gate'; max = 300; }
    if (group) {
      await limit(group + ':ip:' + req.ip, max);
      const identity = req.user ? req.user.id : String(req.body?.email || req.body?.buyer?.email || '').trim().toLowerCase();
      if (identity) await limit(group + ':identity:' + identity, max);
    }
    next();
  });
  async function orderFor(req, id, cl = pool, manage = false) {
    const o = (await cl.query('select * from orders where id=$1', [Number(id) || 0])).rows[0];
    if (!o) bad(404, 'Order not available');
    let session = req.user && (req.user.role === 'admin' || o.user_id === req.user.id) ? req.session : null;
    if (!session) {
      const s = await read(req, 'ee_order_' + o.id, cl);
      if (s?.kind === 'order' && String(s.order_id) === String(o.id)) session = s;
    }
    if (!session) bad(403, 'Order not available');
    if (manage && new Date(session.fresh_until) <= new Date()) bad(403, 'Verify your email with Find my order, or log in again before changing tickets.', 'REAUTH_REQUIRED');
    return o;
  }
  async function staffChallenge(res, user) {
    if (!mailRecovery) bad(503, 'Staff email verification is not configured');
    const id = crypto.randomUUID(), code = String(crypto.randomInt(0,1000000)).padStart(6,'0');
    const digest = crypto.createHmac('sha256',env.JWT_SECRET).update(id + ':' + code).digest('hex');
    await pool.query(`insert into recovery_challenges(id,user_id,code_hash,expires_at) values($1,$2,$3,now()+interval '10 minutes')`, [id,user.id,digest]);
    await mailRecovery(user.email,code);
    res.status(202).json({challengeId:id});
  }
  function routes(app) {
    app.get('/api/session', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));
    app.post('/api/auth/logout', wrap(async (req, res) => {
      const tokens = Object.entries(cookies(req)).filter(([k]) => k === 'ee_session' || /^ee_order_\d+$/.test(k));
      if (tokens.length) await pool.query('delete from browser_sessions where token_hash=any($1)', [tokens.map(([,v]) => hash(v))]);
      tokens.forEach(([k]) => res.clearCookie(k, clearOptions));
      res.json({ ok: true });
    }));
    app.post('/api/orders/lookup', wrap(async (req, res) => {
      if (!mailRecovery) bad(503, 'Email verification is not configured. Contact the organiser for assistance.');
      const b = req.body || {}, id = crypto.randomUUID(), code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const o = (await pool.query('select id,buyer_email from orders where id=$1 and lower(buyer_email)=lower($2)', [Number(b.orderId) || 0, String(b.email || '').trim()])).rows[0];
      const digest = crypto.createHmac('sha256', env.JWT_SECRET).update(id + ':' + code).digest('hex');
      await pool.query(`insert into recovery_challenges(id,order_id,code_hash,expires_at) values($1,$2,$3,now()+interval '10 minutes')`, [id, o?.id || null, digest]);
      if (o) { try { await mailRecovery(o.buyer_email, code); } catch { console.error('Recovery email delivery failed'); } }
      res.status(202).json({ challengeId: id, message: 'If the order details match, a verification code has been sent to the buyer email.' });
    }));
    app.post('/api/orders/verify', wrap(async (req, res) => {
      const { challengeId, code } = req.body || {};
      if (!/^[a-f0-9-]{36}$/.test(challengeId || '') || !/^\d{6}$/.test(code || '')) bad(400, 'Invalid or expired verification code');
      const cl = await pool.connect(); let orderId;
      try {
        await cl.query('begin');
        const c = (await cl.query('select * from recovery_challenges where id=$1 for update', [challengeId])).rows[0];
        if (c && !c.consumed_at && c.attempts < 5 && new Date(c.expires_at) > new Date()) {
          await cl.query('update recovery_challenges set attempts=attempts+1 where id=$1', [challengeId]);
          const digest = crypto.createHmac('sha256', env.JWT_SECRET).update(challengeId + ':' + code).digest('hex');
          if (c.order_id && crypto.timingSafeEqual(Buffer.from(c.code_hash), Buffer.from(digest))) {
            orderId = c.order_id; await cl.query('update recovery_challenges set consumed_at=now() where id=$1', [challengeId]);
          }
        }
        await cl.query('commit');
      } catch (e) { await cl.query('rollback'); throw e; } finally { cl.release(); }
      if (!orderId) bad(400, 'Invalid or expired verification code');
      await issue(res, 'order', orderId);
      res.json({ orderId: String(orderId) });
    }));
    app.post('/api/auth/verify', wrap(async (req,res) => {
      const {challengeId,code} = req.body || {};
      if (!/^[a-f0-9-]{36}$/.test(challengeId || '') || !/^\d{6}$/.test(code || '')) bad(400,'Invalid or expired verification code');
      const cl = await pool.connect(); let user;
      try {
        await cl.query('begin');
        const c = (await cl.query('select * from recovery_challenges where id=$1 for update',[challengeId])).rows[0];
        if (c?.user_id && !c.consumed_at && c.attempts<5 && new Date(c.expires_at)>new Date()) {
          await cl.query('update recovery_challenges set attempts=attempts+1 where id=$1',[challengeId]);
          const digest = crypto.createHmac('sha256',env.JWT_SECRET).update(challengeId + ':' + code).digest('hex');
          if (crypto.timingSafeEqual(Buffer.from(c.code_hash),Buffer.from(digest))) {
            user = (await cl.query('select * from users where id=$1 and not disabled',[c.user_id])).rows[0];
            await cl.query('update recovery_challenges set consumed_at=now() where id=$1',[challengeId]);
          }
        }
        await cl.query('commit');
      } catch(e) { await cl.query('rollback'); throw e; } finally { cl.release(); }
      if (!user) bad(400,'Invalid or expired verification code');
      await issue(res,'account',user.id); res.json({user:publicUser(user)});
    }));
  }
  return { auth, boundary, sensitiveLimits, issue, orderFor, routes, publicUser, options, clearOptions, staffChallenge };
}
module.exports = { browserSecurity, hash, publicUser };
