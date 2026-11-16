'use strict';
const crypto = require('crypto');
const { hash } = require('./browser-security');
const { PaymentDeclined } = require('./payment-provider');
const cents = value => { const n = Math.round(Number(value) * 100); if (!Number.isSafeInteger(n) || n < 0) throw Object.assign(new Error('Invalid amount'), { s: 400 }); return n; };
const fingerprint = value => hash(JSON.stringify(value));

function commerce({ pool, tx, bad, wrap, buyerOf, orderFor, orderView, issueOrder, seatsOf, tierOf, priceOf, provider, notifyOrder, env }) {
  async function price(cl, e, seats, b, user, reserve = false) {
    const sub = seats.reduce((sum, s) => sum + cents(priceOf(e, s)), 0);
    let disc = 0, promo = null, referrer = null, points = 0, promoReserved = false;
    if (b.promoCode) {
      const code = String(b.promoCode).trim().toUpperCase();
      if (code.length > 64) bad(400, 'Invalid promo code');
      const p = (await cl.query(`select * from promo_codes where code=$1 and active and (valid_until is null or valid_until>now())
        and (usage_limit is null or used<usage_limit)` + (reserve ? ' for update' : ''), [code])).rows[0];
      if (p) { disc = Math.round(sub * p.percent / 100); promo = code; promoReserved = reserve; }
      else {
        const r = (await cl.query('select id from users where referral_code=$1', [code])).rows[0];
        if (!r || (user && r.id === user.id)) bad(400, 'Promo or referral code not recognised');
        disc = Math.round(sub * .05); promo = code;
        // Guest referrals receive the discount; rewards require a verified account and settlement after the event.
        if (user) referrer = r.id;
      }
    }
    if (b.usePoints && user) points = Math.min(Math.floor(user.points / 10), Math.floor((sub - disc) / 500));
    disc += points * 100;
    if (promoReserved) await cl.query('update promo_codes set used=used+1 where code=$1', [promo]);
    return { sub: sub / 100, disc: disc / 100, total: (sub - disc) / 100, promo, referrer, pointsSpent: points * 10, promoReserved };
  }
  async function insertPending(cl, req, e, details, p, method, kind, key, fp, listingId) {
    const o = (await cl.query(`insert into orders(user_id,buyer_name,buyer_email,buyer_phone,event_id,subtotal,discount,total,promo_code,
      payment_method,payment_provider,alert_channel,status,referral_user_id,points_spent,promo_reserved)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending_payment',$13,$14,$15) returning *`,
    [req.user?.id || null, details.buyer.name, details.buyer.email, details.buyer.phone || null, e.id, p.sub, p.disc, p.total, p.promo,
      kind === 'resale' ? 'resale' : method, method, details.ch, p.referrer || null, p.pointsSpent || 0, p.promoReserved || false])).rows[0];
    if (p.pointsSpent) {
      await cl.query('update users set points=points-$2 where id=$1', [req.user.id, p.pointsSpent]);
      await cl.query(`insert into loyalty_ledger(user_id,delta,reason,order_id) values($1,$2,'Points redeemed',$3)`, [req.user.id, -p.pointsSpent, o.id]);
    }
    const id = crypto.randomUUID();
    await cl.query(`insert into payment_jobs(id,request_key,holder,fingerprint,kind,order_id,amount_cents,method,listing_id)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, key, req.holder, fp, kind, o.id, cents(p.total), method, listingId || null]);
    return { o, jobId: id };
  }
  function request(req, kind, details) {
    provider.validate(details.method);
    const key = req.get('Idempotency-Key');
    if (!/^[a-f0-9-]{36}$/.test(key || '')) bad(400, 'A purchase request ID is required');
    const fp = fingerprint([kind, req.body.eventId || req.params.id, details.buyer, details.method, req.body.promoCode || '', !!req.body.usePoints]);
    return { key, fp };
  }
  async function prior(cl, req, key, fp) {
    // Also serializes reuse of a request ID while the first request is reserving stock.
    await cl.query('select pg_advisory_xact_lock(hashtextextended($1,0))', ['request:' + key]);
    const j = (await cl.query('select * from payment_jobs where request_key=$1', [key])).rows[0];
    if (!j) return null;
    if (j.holder !== req.holder || j.fingerprint !== fp) bad(409, 'Purchase request ID was already used');
    return { o: (await cl.query('select * from orders where id=$1', [j.order_id])).rows[0], jobId: j.id };
  }
  async function response(req, res, r) {
    let result;
    try { result = await runJob(r.jobId); } catch (e) { console.error('Payment processing deferred', e.name); }
    const o = (await pool.query('select * from orders where id=$1', [r.o.id])).rows[0];
    if (!req.user) await issueOrder(res, o.id);
    res.status(o.status === 'paid' ? 201 : 202).json({ order: await orderView(o), pending: o.status === 'pending_payment', checkoutUrl: result?.checkoutUrl });
  }
  async function release(cl, o, job) {
    if (job.kind === 'resale') {
      await cl.query(`update tickets set status='valid' where id=(select ticket_id from resale_listings where id=$1) and status='reserved'`, [job.listing_id]);
      await cl.query(`update resale_listings set status='open' where id=$1 and status='pending'`, [job.listing_id]);
    } else await cl.query(`update tickets set status='cancelled' where order_id=$1 and status='reserved'`, [o.id]);
    if (o.promo_reserved) await cl.query('update promo_codes set used=greatest(0,used-1) where code=$1', [o.promo_code]);
    if (o.user_id && o.points_spent) {
      await cl.query('update users set points=points+$2 where id=$1', [o.user_id, o.points_spent]);
      await cl.query(`insert into loyalty_ledger(user_id,delta,reason,order_id) values($1,$2,'Payment failed: points restored',$3)`, [o.user_id, o.points_spent, o.id]);
    }
    await cl.query(`update orders set status='payment_failed' where id=$1`, [o.id]);
  }
  async function runJob(id) {
    const cl = await pool.connect(); let locked = false, notification, sellerNotice, result;
    try {
      locked = (await cl.query('select pg_try_advisory_lock(hashtextextended($1,0)) ok', ['payment:' + id])).rows[0].ok;
      if (!locked) return;
      const j = (await cl.query('select * from payment_jobs where id=$1', [id])).rows[0];
      if (!j || j.status !== 'pending') return;
      // Do not recreate an unknown Stripe operation after its idempotency retention window.
      const unknownOperation = j.kind === 'refund' ? !j.refund_ref : !j.payment_ref;
      if (Date.now() - new Date(j.created_at).getTime() > 20 * 3600000 && unknownOperation && j.method === 'stripe') {
        await cl.query(`update payment_jobs set last_error='Manual provider reconciliation required',next_attempt_at='infinity' where id=$1`, [id]); return;
      }
      const o = (await cl.query('select * from orders where id=$1', [j.order_id])).rows[0];
      try {
        if (j.kind === 'refund') {
          const refund = await provider.refund(j);
          await cl.query('update payment_jobs set refund_ref=$2 where id=$1',[id,refund.refundRef || null]);
          result = { paid: refund.settled, ref: j.payment_ref };
          if (refund.attention) { await cl.query(`update payment_jobs set last_error='Refund requires manual provider reconciliation',next_attempt_at='infinity' where id=$1`,[id]); return result; }
        }
        else result = j.payment_ref?.startsWith('pi_') || j.payment_ref === 'FREE' || j.payment_ref?.startsWith('SIM-') ? { paid: true, ref: j.payment_ref } : await provider.pay(j);
        await cl.query('update payment_jobs set payment_ref=$2,checkout_url=$3,attempts=attempts+1,next_attempt_at=now()+interval \'30 seconds\' where id=$1', [id, result.ref, result.checkoutUrl || null]);
        if (!result.paid) return result;
        await cl.query('begin');
        await cl.query('select id from events where id=$1 for no key update', [o.event_id]);
        const current = (await cl.query('select * from orders where id=$1 for update', [o.id])).rows[0];
        if (j.kind === 'refund') {
          await cl.query(`update orders set status='cancelled' where id=$1 and status='refund_pending'`, [o.id]);
          notification = [o, 'Refund completed', `Your refund of S$${(Number(j.amount_cents) / 100).toFixed(2)} has completed.`];
        } else if (current.status === 'pending_payment') {
          if (j.kind === 'resale') {
            const seller = (await cl.query('select o.* from orders o join resale_listings l on l.seller_order_id=o.id where l.id=$1',[j.listing_id])).rows[0];
            sellerNotice = [seller,'Your ticket sold','Your resale ticket has sold. Its previous QR code is no longer valid.'];
            await cl.query(`update tickets set order_id=$1,qr_version=qr_version+1,status='valid' where id=(select ticket_id from resale_listings where id=$2) and status='reserved'`, [o.id, j.listing_id]);
            await cl.query(`update resale_listings set status='sold' where id=$1`, [j.listing_id]);
          } else await cl.query(`update tickets set status='valid' where order_id=$1 and status='reserved'`, [o.id]);
          await cl.query(`update orders set status='paid',payment_ref=$2 where id=$1`, [o.id, result.ref]);
          if (o.user_id && j.kind === 'purchase') {
            const earn = Math.floor(Number(o.total) / 10);
            await cl.query('update users set points=points+$2 where id=$1', [o.user_id, earn]);
            await cl.query(`insert into loyalty_ledger(user_id,delta,reason,order_id) values($1,$2,'Purchase',$3)`, [o.user_id, earn, o.id]);
          }
          notification = [o, 'Tickets confirmed', `Payment is complete. Open order #${o.id} to view your tickets.`];
        }
        await cl.query(`update payment_jobs set status='done',payment_token=null,last_error=null where id=$1`, [id]);
        await cl.query('commit');
      } catch (e) {
        notification = undefined;
        sellerNotice = undefined;
        await cl.query('rollback');
        if (e instanceof PaymentDeclined && j.kind !== 'refund') {
          await cl.query('begin');
          await cl.query('select id from events where id=$1 for no key update', [o.event_id]);
          await release(cl, o, j);
          await cl.query(`update payment_jobs set status='failed',last_error='Payment not completed' where id=$1`, [id]);
          await cl.query('commit');
        } else {
          await cl.query(`update payment_jobs set attempts=attempts+1,last_error=$2,next_attempt_at=now()+interval '1 minute' where id=$1`, [id, 'Provider or processing error; retry pending']);
          console.error('Payment job needs retry', e.name);
        }
      }
    } finally {
      if (locked) await cl.query('select pg_advisory_unlock(hashtextextended($1,0))', ['payment:' + id]);
      cl.release();
    }
    if (notification) await notifyOrder(...notification).catch(() => console.error('Order notification deferred'));
    if (sellerNotice) await notifyOrder(...sellerNotice).catch(() => console.error('Seller notification deferred'));
    return result;
  }
  async function settleReferrals() {
    // Reward only after the event, for an account whose email ownership was verified by recovery.
    const candidates = (await pool.query(`select o.* from orders o join events e on e.id=o.event_id
      where o.status='paid' and o.referral_user_id is not null and o.user_id is not null and o.total>=10
      and e.starts_at<now() and e.status='live' and exists(select 1 from recovery_challenges r where r.order_id=o.id and r.consumed_at is not null)
      and not exists(select 1 from referral_rewards r where r.referred_user_id=o.user_id)
      and not exists(select 1 from orders earlier where earlier.user_id=o.user_id and earlier.status='paid' and earlier.id<o.id)
      limit 50`)).rows;
    for (const o of candidates) await tx(async cl => {
      const added = await cl.query(`insert into referral_rewards(referred_user_id,referrer_id,order_id) values($1,$2,$3) on conflict do nothing returning order_id`, [o.user_id, o.referral_user_id, o.id]);
      if (added.rowCount) {
        await cl.query('update users set points=points+50 where id=$1', [o.referral_user_id]);
        await cl.query(`insert into loyalty_ledger(user_id,delta,reason,order_id) values($1,50,'Referral reward',$2)`, [o.referral_user_id, o.id]);
      }
    });
  }
  async function reconcile() {
    const jobs = (await pool.query(`select id from payment_jobs where status='pending' and next_attempt_at<=now() order by created_at limit 20`)).rows;
    for (const job of jobs) await runJob(job.id);
    await settleReferrals();
    await pool.query('delete from browser_sessions where expires_at<now()');
    await pool.query('delete from request_limits where expires_at<now()');
    // Keep consumed verification evidence for reward eligibility; purge unused challenges promptly.
    await pool.query('delete from recovery_challenges where consumed_at is null and expires_at<now()-interval \'1 day\'');
  }
  function routes(app) {
    app.post('/api/checkout', wrap(async (req, res) => {
      const d = buyerOf(req), { key, fp } = request(req, 'purchase', d);
      const r = await tx(async cl => {
        const old = await prior(cl, req, key, fp); if (old) return old;
        const e = (await cl.query(`select * from events where id=$1 and status='live' and starts_at>now() for no key update`, [Number(req.body.eventId) || 0])).rows[0];
        if (!e) bad(404, 'Event not on sale');
        if (req.user && req.user.role !== 'customer') bad(403, 'Only customers or guests can book');
        if (e.high_demand && !(await cl.query(`select 1 from queue_entries where event_id=$1 and holder=$2 and status='admitted' and admitted_until>now()`, [e.id, req.holder])).rowCount) bad(403, 'Join the waiting room first', 'QUEUE_REQUIRED');
        const holds = (await cl.query('select seat from seat_holds where event_id=$1 and holder=$2 and expires_at>now() order by seat for update', [e.id, req.holder])).rows.map(x => x.seat);
        const max = (await cl.query(`select value from settings where key='max_seats'`)).rows[0].value;
        if (!holds.length || holds.length > max || holds.some(s => !seatsOf(e).includes(s))) bad(409, 'Choose valid seats within the booking limit');
        const u = req.user ? (await cl.query('select * from users where id=$1 for update', [req.user.id])).rows[0] : null;
        const p = await price(cl, e, holds, req.body, u, true);
        const saved = await insertPending(cl, req, e, d, p, d.method, 'purchase', key, fp);
        for (const seat of holds) await cl.query(`insert into tickets(order_id,event_id,seat,tier,price,status) values($1,$2,$3,$4,$5,'reserved')`, [saved.o.id, e.id, seat, tierOf(e, seat), priceOf(e, seat)]);
        await cl.query('delete from seat_holds where event_id=$1 and holder=$2', [e.id, req.holder]);
        await cl.query(`update queue_entries set status='done' where event_id=$1 and holder=$2 and status='admitted'`, [e.id, req.holder]);
        return saved;
      });
      await response(req, res, r);
    }));
    app.post('/api/quote', wrap(async (req, res) => {
      const e = (await pool.query(`select * from events where id=$1 and status='live' and starts_at>now()`, [Number(req.body.eventId) || 0])).rows[0];
      if (!e) bad(404, 'Event not on sale');
      const seats = (await pool.query('select seat from seat_holds where event_id=$1 and holder=$2 and expires_at>now()', [e.id, req.holder || ''])).rows.map(x => x.seat);
      const p = await price(pool, e, seats, req.body, req.user);
      res.json({ subtotal: p.sub, discount: p.disc, total: p.total, promo: p.promo, seats });
    }));
    app.post('/api/orders/:id/cancel', wrap(async (req, res) => {
      const allowed = await orderFor(req, req.params.id, pool, true);
      const r = await tx(async cl => {
        const e = (await cl.query('select * from events where id=$1 for no key update', [allowed.event_id])).rows[0];
        const o = (await cl.query('select * from orders where id=$1 for update', [allowed.id])).rows[0];
        if (o.status === 'refund_pending' || o.status === 'cancelled') return { o, jobId: (await cl.query(`select id from payment_jobs where order_id=$1 and kind='refund'`, [o.id])).rows[0]?.id };
        if (o.status !== 'paid') bad(409, 'Order is not refundable');
        if (['resale','transfer'].includes(o.payment_method)) bad(400, 'Transferred or resale tickets cannot be refunded');
        const cutoff = (await cl.query(`select value from settings where key='refund_hours'`)).rows[0].value;
        if ((new Date(e.starts_at) - Date.now()) / 3600000 < cutoff) bad(409, 'The refund window has closed');
        const tickets = (await cl.query(`select * from tickets where order_id=$1 and status='valid' for update`, [o.id])).rows;
        if (!tickets.length) bad(409, 'No refundable tickets remain');
        const ratio = Math.min(1, tickets.reduce((sum,t) => sum + cents(t.price), 0) / Math.max(1, cents(o.subtotal)));
        const amount = Math.round(cents(o.total) * ratio);
        await cl.query(`update tickets set status='cancelled' where order_id=$1 and status='valid'`, [o.id]);
        await cl.query(`update resale_listings set status='withdrawn' where ticket_id=any($1) and status='open'`, [tickets.map(t => t.id)]);
        await cl.query(`update orders set status='refund_pending' where id=$1`, [o.id]);
        if (o.user_id) {
          const earned = (await cl.query(`select coalesce(sum(delta),0)::int n from loyalty_ledger where order_id=$1 and user_id=$2 and reason='Purchase'`, [o.id, o.user_id])).rows[0].n;
          const restored = Math.floor(o.points_spent * ratio), remove = Math.ceil(earned * ratio);
          const user = (await cl.query('select points from users where id=$1 for update', [o.user_id])).rows[0];
          const delta = Math.max(-user.points, restored - remove);
          await cl.query('update users set points=points+$2 where id=$1', [o.user_id, delta]);
          await cl.query(`insert into loyalty_ledger(user_id,delta,reason,order_id) values($1,$2,'Cancellation adjustment',$3)`, [o.user_id, delta, o.id]);
        }
        const rewards = (await cl.query(`select user_id,sum(delta)::int n from loyalty_ledger where order_id=$1 and reason='Referral reward' group by user_id`, [o.id])).rows;
        for (const reward of rewards) {
          await cl.query('update users set points=greatest(0,points-$2) where id=$1', [reward.user_id, reward.n]);
          await cl.query(`insert into loyalty_ledger(user_id,delta,reason,order_id) values($1,$2,'Referral reversed',$3)`, [reward.user_id, -reward.n, o.id]);
        }
        const id = crypto.randomUUID();
        await cl.query(`insert into payment_jobs(id,request_key,holder,fingerprint,kind,order_id,amount_cents,method,payment_ref)
          values($1,$2,$3,'refund','refund',$4,$5,$6,$7)`, [id, 'refund:' + o.id, req.holder || 'order:' + o.id, o.id, amount, o.payment_provider || o.payment_method, o.payment_ref]);
        return { o, jobId: id };
      });
      if (r.jobId) await runJob(r.jobId);
      const current = (await pool.query('select status from orders where id=$1', [r.o.id])).rows[0];
      const job = r.jobId ? (await pool.query('select amount_cents from payment_jobs where id=$1', [r.jobId])).rows[0] : null;
      res.json({ ok: true, pending: current.status === 'refund_pending', refunded: current.status === 'cancelled' && job ? Number(job.amount_cents) / 100 : 0 });
    }));
    app.post('/api/resale/:id/buy', wrap(async (req, res) => {
      if (env.NODE_ENV === 'production') bad(503, 'Resale purchases are unavailable until seller payouts are configured.');
      const d = buyerOf(req), { key, fp } = request(req, 'resale', d);
      const r = await tx(async cl => {
        const old = await prior(cl, req, key, fp); if (old) return old;
        if (req.user && req.user.role !== 'customer') bad(403, 'Only customers or guests can book');
        const peek = (await cl.query('select t.event_id,l.ticket_id from resale_listings l join tickets t on t.id=l.ticket_id where l.id=$1', [Number(req.params.id) || 0])).rows[0];
        if (!peek) bad(404, 'Listing not available');
        const e = (await cl.query(`select * from events where id=$1 and status='live' and starts_at>now() for no key update`, [peek.event_id])).rows[0];
        if (!e) bad(409, 'Event is no longer on sale');
        const t = (await cl.query('select * from tickets where id=$1 for update', [peek.ticket_id])).rows[0];
        const l = (await cl.query(`select * from resale_listings where id=$1 and status='open' for update`, [req.params.id])).rows[0];
        if (!l || t.status !== 'valid' || String(t.order_id) !== String(l.seller_order_id)) bad(409, 'Listing is no longer available');
        const seller = (await cl.query('select * from orders where id=$1', [l.seller_order_id])).rows[0];
        if (seller.user_id && seller.user_id === req.user?.id || seller.buyer_email.toLowerCase() === d.buyer.email.toLowerCase()) bad(400, 'You cannot buy your own ticket');
        const p = { sub: Number(l.price), disc: 0, total: Number(l.price) };
        const saved = await insertPending(cl, req, e, d, p, d.method, 'resale', key, fp, l.id);
        await cl.query(`update tickets set status='reserved' where id=$1`, [t.id]);
        await cl.query(`update resale_listings set status='pending' where id=$1`, [l.id]);
        return saved;
      });
      await response(req, res, r);
    }));
  }
  return { routes, runJob, reconcile, price };
}
module.exports = { commerce, cents };
