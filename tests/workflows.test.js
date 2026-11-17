'use strict';
const {test, before, after, beforeEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), net = require('node:net'), crypto = require('node:crypto');
const {Pool} = require('pg');
const bcrypt = require('bcryptjs');
const {createApp} = require('../src/server');
const {migrate} = require('../db/migrate');
const {paymentProvider,PaymentDeclined} = require('../src/payment-provider');
const {databaseConfig} = require('../src/db-config');
let pg, pool, server, base, app, dir, organiser, eventId, connectionConfig;
let payments = new Map(), refundsFail = false, payMode = 'paid', sent = [];
const env = {NODE_ENV:'test',APP_ORIGIN:'http://localhost:3000',JWT_SECRET:'j'.repeat(48),QR_SECRET:'q'.repeat(48),ALLOW_SIMULATED_PAYMENTS:'true',QUEUE_BATCH:'2'};
const provider = {methods:['card'],validate: m => {if(m!=='card') throw Object.assign(new Error('Method unavailable'),{s:400})},
  pay: async j => {if(payMode==='declined') throw new PaymentDeclined('Declined'); if(payMode==='outage') throw new Error('Temporary provider outage');
    if (!payments.has(j.id)) payments.set(j.id, 'SIM-'+j.id); return {paid:payMode!=='pending',ref:payments.get(j.id)}},
  refund: async () => {if(refundsFail) throw new Error('Temporary refund outage'); return {settled:true}}};
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
function client(){let jar=new Map(); const guest=crypto.randomBytes(12).toString('hex');return {jar,guest,async send(url,body,opts={}) {
  const method=opts.method || (body===undefined?'GET':'POST');
  const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json','Origin':env.APP_ORIGIN,'X-EE-Request':'1','X-Guest-Token':guest,'Cookie':[...jar].map(([k,v])=>k+'='+v).join('; '),...(opts.key?{'Idempotency-Key':opts.key}:{}),...opts.headers},...(method==='GET'?{}:{body:JSON.stringify(body || {})})});
  for(const cookie of r.headers.getSetCookie()){const [k,v]=cookie.split(';')[0].split('=');if(v)jar.set(k,v);else jar.delete(k)}
  return {status:r.status,body:await r.json(),headers:r.headers};
}}}
async function user(email,role='customer'){return (await pool.query('insert into users(name,email,password_hash,role,organiser_approved) values($1,$2,$3,$4,true) returning *',['Test User',email,await bcrypt.hash('LocalFixture123!',4),role])).rows[0]}
async function login(c,email){const r=await c.send('/api/auth/login',{email,password:'LocalFixture123!'});if(r.body.challengeId){const code=sent.at(-1).code;return c.send('/api/auth/verify',{challengeId:r.body.challengeId,code})}return r}
async function hold(c,seats){const r=await c.send('/api/events/'+eventId+'/holds',{seats},{method:'PUT'});assert.equal(r.status,200,JSON.stringify(r.body))}
async function buy(c,seats=['A1'],extra={},key=crypto.randomUUID()){await hold(c,seats);const r=await c.send('/api/checkout',{eventId,paymentMethod:'card',buyer:{name:'Guest Fixture',email:'buyer@example.test'},...extra},{key});return {r,key}}
before(async()=>{
  const {default:EmbeddedPostgres}=await import('embedded-postgres');dir=await fs.mkdtemp(path.join(os.tmpdir(),'ct2079-test-'));
  const port=await freePort();pg=new EmbeddedPostgres({databaseDir:path.join(dir,'db'),user:'fixture',password:crypto.randomBytes(16).toString('hex'),port,persistent:false,autoRehydrateSymlinks:true,postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await pg.initialise();await pg.start();
  const config={host:'127.0.0.1',port,user:'fixture',password:pg.options.password,database:'postgres'};
  connectionConfig=config;await migrate(config);await migrate(config);pool=new Pool({...config,max:12});
  app=createApp({pool,env,provider,mailRecovery:async(email,code)=>sent.push({email,code})});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(pool)await pool.end();if(pg)await pg.stop();if(dir)await fs.rm(dir,{recursive:true,force:true})});
beforeEach(async()=>{
  await pool.query('truncate browser_sessions,recovery_challenges,request_limits,payment_jobs,referral_rewards,loyalty_ledger,notifications,fraud_flags,resale_listings,queue_entries,seat_holds,tickets,orders,events,users restart identity cascade');
  await pool.query("update settings set value=8 where key='max_seats'");organiser=await user('organiser@example.test','organiser');
  eventId=(await pool.query("insert into events(organiser_id,title,category,starts_at,venue,location,price_vip,price_std,price_con,status) values($1,'Fixture event','Concert',now()+interval '10 days','Fixture hall','Fixture area',100,50,20,'live') returning id",[organiser.id])).rows[0].id;
  payments=new Map();refundsFail=false;payMode='paid';sent=[];
});
test('migration applies once and sessions are HttpOnly and revocable',async()=>{
  await user('customer@example.test');const c=client();const l=await login(c,'customer@example.test');assert.equal(l.status,200);assert.match(l.headers.get('set-cookie'),/HttpOnly/);assert.equal(l.body.token,undefined);
  assert.equal((await c.send('/api/me')).status,200);await c.send('/api/auth/logout',{});assert.equal((await c.send('/api/me')).status,401);
});
test('staff password sign-in requires emailed code before creating a session',async()=>{
 const c=client(),r=await c.send('/api/auth/login',{email:organiser.email,password:'LocalFixture123!'});assert.equal(r.status,202);assert.equal(c.jar.has('ee_session'),false);
 const done=await c.send('/api/auth/verify',{challengeId:r.body.challengeId,code:sent.at(-1).code});assert.equal(done.status,200);assert.equal(done.body.user.role,'organiser');
});
test('normal guest purchase is calculated from held seats and survives a repeated request',async()=>{
 const c=client(),{r,key}=await buy(c,['A1','C1']);assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.order.total,150);assert.equal(r.body.order.tickets.length,2);assert.ok(r.body.order.tickets[0].qr);
 const repeat=await c.send('/api/checkout',{eventId,paymentMethod:'card',buyer:{name:'Guest Fixture',email:'buyer@example.test'}},{key});assert.equal(repeat.body.order.id,r.body.order.id);assert.equal(payments.size,1);
 assert.equal((await c.send('/api/orders/'+r.body.order.id)).status,200);
});
test('order recovery sends a code, then grants access without exposing the code in notification storage',async()=>{
 const owner=client(),{r}=await buy(owner);const recovery=client();const start=await recovery.send('/api/orders/lookup',{orderId:r.body.order.id,email:'buyer@example.test'});
 assert.equal(start.status,202);assert.equal(start.body.order,undefined);assert.equal(start.body.orderToken,undefined);
 const verified=await recovery.send('/api/orders/verify',{challengeId:start.body.challengeId,code:sent.at(-1).code});assert.equal(verified.status,200);assert.equal((await recovery.send('/api/orders/'+r.body.order.id)).status,200);
 const notes=(await pool.query('select body from notifications')).rows;assert.ok(notes.every(n=>!n.body.includes(sent.at(-1).code)));
});
test('password change invalidates all account sessions',async()=>{
 await user('customer@example.test');const a=client(),b=client();await login(a,'customer@example.test');await login(b,'customer@example.test');
 const changed=await a.send('/api/me',{name:'New Name',currentPassword:'LocalFixture123!',newPassword:'AnotherFixture456!'},{method:'PUT'});assert.equal(changed.status,200);assert.equal((await b.send('/api/me')).status,401);
});
test('pending payments reserve inventory and are completed by reconciliation',async()=>{
 payMode='outage';const c=client(),{r}=await buy(c);assert.equal(r.status,202);assert.equal(r.body.order.status,'pending_payment');assert.equal(r.body.order.tickets[0].qr,null);
 payMode='paid';await pool.query("update payment_jobs set next_attempt_at=now()");await app.locals.reconcile();const done=await c.send('/api/orders/'+r.body.order.id);assert.equal(done.body.status,'paid');assert.ok(done.body.tickets[0].qr);
});
test('definite payment failure releases seats and restores redeemed points',async()=>{
 const u=await user('customer@example.test');await pool.query('update users set points=100 where id=$1',[u.id]);const c=client();await login(c,u.email);payMode='declined';const {r}=await buy(c,['A1'],{usePoints:true});assert.equal(r.body.order.status,'payment_failed');
 assert.equal((await pool.query('select points from users where id=$1',[u.id])).rows[0].points,100);await hold(client(),['A1']);
});
test('refund outage stays pending and reconciliation completes it once',async()=>{
 const c=client(),{r}=await buy(c);refundsFail=true;const cancelled=await c.send('/api/orders/'+r.body.order.id+'/cancel',{});assert.equal(cancelled.body.pending,true);assert.equal(cancelled.body.refunded,0);
 refundsFail=false;await pool.query('update payment_jobs set next_attempt_at=now()');await app.locals.reconcile();assert.equal((await c.send('/api/orders/'+r.body.order.id)).body.status,'cancelled');
 assert.equal((await pool.query("select count(*)::int n from payment_jobs where kind='refund'")).rows[0].n,1);
});
test('transfer changes ownership and QR version; a new buyer can complete a resale',async()=>{
 const c=client(),{r}=await buy(c);const t=r.body.order.tickets[0];const transferred=await c.send('/api/tickets/'+t.id+'/transfer',{toEmail:'recipient@example.test'});assert.equal(transferred.status,200);
 const o=(await pool.query("select * from orders where buyer_email='recipient@example.test'")).rows[0];const recipient=client();const start=await recipient.send('/api/orders/lookup',{orderId:o.id,email:o.buyer_email});await recipient.send('/api/orders/verify',{challengeId:start.body.challengeId,code:sent.at(-1).code});
 const view=await recipient.send('/api/orders/'+o.id);assert.notEqual(view.body.tickets[0].qr,t.qr);
 const listing=await recipient.send('/api/tickets/'+t.id+'/resale',{price:90});assert.equal(listing.status,201);
 const buyer=client(),purchased=await buyer.send('/api/resale/'+listing.body.id+'/buy',{paymentMethod:'card',buyer:{name:'New Buyer',email:'new@example.test'}},{key:crypto.randomUUID()});assert.equal(purchased.status,201);assert.equal(purchased.body.order.total,90);assert.notEqual(purchased.body.order.tickets[0].qr,view.body.tickets[0].qr);
});
test('normal queue joins have one active entry per holder and respect batch capacity',async()=>{
 await pool.query('update events set high_demand=true where id=$1',[eventId]);const a=client(),b=client(),c=client();for(const x of [a,a,b,c])assert.equal((await x.send('/api/events/'+eventId+'/queue/join',{})).status,200);
 assert.equal((await pool.query("select count(*)::int n from queue_entries where status='admitted'")).rows[0].n,2);assert.equal((await pool.query('select count(*)::int n from queue_entries')).rows[0].n,3);
});
test('standard competing reservations keep one buyer per seat',async()=>{
 const a=client(),b=client();const results=await Promise.all([a.send('/api/events/'+eventId+'/holds',{seats:['A1']},{method:'PUT'}),b.send('/api/events/'+eventId+'/holds',{seats:['A1']},{method:'PUT'})]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
});
test('production configuration requires verified TLS and rejects simulated payments',()=>{
 assert.throws(()=>databaseConfig({NODE_ENV:'production',DATABASE_URL:'postgres://localhost/test',DB_SSL:'false'}),/DB_SSL/);
 const p=paymentProvider({NODE_ENV:'test',ALLOW_SIMULATED_PAYMENTS:'false'});assert.throws(()=>p.validate('card'),/not enabled/);
});
test('a completed provider operation survives a temporary finalization error without another charge',async()=>{
 const originalConnect=pool.connect.bind(pool);let failOnce=true;
 pool.connect=(callback)=>{
   const pending=originalConnect().then(cl=>{
     const query=cl.query.bind(cl),release=cl.release.bind(cl);
     cl.query=(sql,...args)=>{if(failOnce && String(sql).includes("update orders set status='paid'")){failOnce=false;return Promise.reject(new Error('Fixture database interruption'))}return query(sql,...args)};
     cl.release=(...args)=>{cl.query=query;cl.release=release;return release(...args)};
     return cl;
   });
   if(callback){pending.then(cl=>callback(null,cl,cl.release),callback);return}
   return pending;
 };
 try{const c=client(),{r}=await buy(c);assert.equal(r.body.order.status,'pending_payment');assert.equal(payments.size,1);await pool.query('update payment_jobs set next_attempt_at=now()');await app.locals.reconcile();assert.equal((await c.send('/api/orders/'+r.body.order.id)).body.status,'paid');assert.equal(payments.size,1)}finally{pool.connect=originalConnect}
});
test('gate admission accepts a paid ticket once during its event window',async()=>{
 const c=client(),{r}=await buy(c);await pool.query("update events set starts_at=now()+interval '1 hour' where id=$1",[eventId]);const staff=client();await login(staff,organiser.email);
 const code=r.body.order.tickets[0].qr;assert.equal((await staff.send('/api/gate/scan',{code})).body.admit,true);assert.equal((await staff.send('/api/gate/scan',{code})).body.admit,false);
});
test('a limited promo is reserved once across independent events',async()=>{
 await pool.query("insert into promo_codes(code,percent,usage_limit) values('FIXTURE10',10,1)");const other=(await pool.query("insert into events(organiser_id,title,category,starts_at,venue,location,price_vip,price_std,price_con,status) select organiser_id,'Second fixture',category,starts_at,venue,location,price_vip,price_std,price_con,status from events where id=$1 returning id",[eventId])).rows[0].id;
 const a=client(),b=client();await hold(a,['A1']);assert.equal((await b.send('/api/events/'+other+'/holds',{seats:['A1']},{method:'PUT'})).status,200);
 const results=await Promise.all([a.send('/api/checkout',{eventId,paymentMethod:'card',buyer:{name:'Fixture A',email:'a@example.test'},promoCode:'FIXTURE10'},{key:crypto.randomUUID()}),b.send('/api/checkout',{eventId:other,paymentMethod:'card',buyer:{name:'Fixture B',email:'b@example.test'},promoCode:'FIXTURE10'},{key:crypto.randomUUID()})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[201,400]);assert.equal((await pool.query("select used from promo_codes where code='FIXTURE10'")).rows[0].used,1);
});
test('referral rewards wait for a verified qualifying purchase and are awarded once after the event',async()=>{
 const ref=await user('referrer@example.test'),buyer=await user('referred@example.test');await pool.query("update users set referral_code='REF-FIXTURE' where id=$1",[ref.id]);
 const c=client();await login(c,buyer.email);const {r}=await buy(c,['A1'],{promoCode:'REF-FIXTURE'});assert.equal(r.body.order.total,95);
 const start=await c.send('/api/orders/lookup',{orderId:r.body.order.id,email:buyer.email});await c.send('/api/orders/verify',{challengeId:start.body.challengeId,code:sent.at(-1).code});await app.locals.reconcile();assert.equal((await pool.query('select points from users where id=$1',[ref.id])).rows[0].points,0);
 await pool.query("update events set starts_at=now()-interval '1 hour' where id=$1",[eventId]);await app.locals.reconcile();await app.locals.reconcile();assert.equal((await pool.query('select points from users where id=$1',[ref.id])).rows[0].points,50);
});
test('upgrading an existing database preserves events and disables the original fixture administrator',async()=>{
 await pg.createDatabase('upgrade_fixture');const config={...connectionConfig,database:'upgrade_fixture'};const upgrade=new Pool(config);
 try{await upgrade.query(await fs.readFile(path.join(__dirname,'../db/schema.sql'),'utf8'));const u=(await upgrade.query("insert into users(name,email,password_hash,role,referral_code) values('Legacy fixture','mei@eventease.sg','fixture-hash','admin','REF-MEI') returning id")).rows[0];
 await upgrade.query("insert into events(organiser_id,title,category,starts_at,venue,location,price_vip,price_std,price_con) values($1,'Preserved fixture','Concert',now()+interval '1 day','Hall','Area',100,50,20)",[u.id]);
 await migrate(config);await migrate(config);assert.equal((await upgrade.query('select disabled from users where id=$1',[u.id])).rows[0].disabled,true);assert.equal((await upgrade.query('select count(*)::int n from events')).rows[0].n,1);
 }finally{await upgrade.end()}
});
test('event status and start time remain stable while a checkout payment is pending',async()=>{
 const admin=await user('admin@example.test','admin'),adminClient=client(),organiserClient=client();
 await login(adminClient,admin.email);await login(organiserClient,organiser.email);
 payMode='outage';const buyer=client(),{r}=await buy(buyer);assert.equal(r.body.order.status,'pending_payment');
 const before=(await pool.query('select status,starts_at from events where id=$1',[eventId])).rows[0];
 for(const status of ['cancelled','rejected']) {
  const changed=await adminClient.send('/api/admin/events/'+eventId,{status},{method:'PATCH'});
  assert.equal(changed.status,409,JSON.stringify(changed.body));
 }
 const later=new Date(new Date(before.starts_at).getTime()+86400000).toISOString();
 const rescheduled=await organiserClient.send('/api/organiser/events/'+eventId,{startsAt:later},{method:'PUT'});
 assert.equal(rescheduled.status,409,JSON.stringify(rescheduled.body));
 const still=(await pool.query('select status,starts_at from events where id=$1',[eventId])).rows[0];
 assert.equal(still.status,'live');assert.equal(still.starts_at.getTime(),before.starts_at.getTime());
 // Non-destructive event updates stay available while the payment provider is unavailable.
 assert.equal((await adminClient.send('/api/admin/events/'+eventId,{highDemand:true},{method:'PATCH'})).status,200);
 assert.equal((await organiserClient.send('/api/organiser/events/'+eventId,{title:'Updated fixture title'},{method:'PUT'})).status,200);
 payMode='paid';await pool.query('update payment_jobs set next_attempt_at=now()');await app.locals.reconcile();
 assert.equal((await buyer.send('/api/orders/'+r.body.order.id)).body.status,'paid');
 assert.equal((await organiserClient.send('/api/organiser/events/'+eventId,{startsAt:later},{method:'PUT'})).status,200);
 assert.equal((await adminClient.send('/api/admin/events/'+eventId,{status:'cancelled'},{method:'PATCH'})).status,200);
});
