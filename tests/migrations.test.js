'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {migrate}=require('../db/migrate');
let pg,dir,connectionConfig;
const migrationDir=path.join(__dirname,'../db/migrations');
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port}
before(async()=>{
  const {default:EmbeddedPostgres}=await import('embedded-postgres');
  dir=await fs.mkdtemp(path.join(os.tmpdir(),'ct2079-migrations-'));
  pg=new EmbeddedPostgres({databaseDir:path.join(dir,'db'),user:'fixture',password:crypto.randomBytes(16).toString('hex'),port:await freePort(),persistent:false,autoRehydrateSymlinks:true,postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await pg.initialise();await pg.start();
  connectionConfig={host:'127.0.0.1',port:pg.options.port,user:'fixture',password:pg.options.password};
});
after(async()=>{if(pg)await pg.stop();if(dir)await fs.rm(dir,{recursive:true,force:true})});
async function legacyDatabase(name){
  await pg.createDatabase(name);const config={...connectionConfig,database:name},pool=new Pool(config);
  await pool.query(await fs.readFile(path.join(__dirname,'../db/schema.sql'),'utf8'));
  return {config,pool};
}
async function account(pool,email,role,referral){return (await pool.query("insert into users(name,email,password_hash,role,referral_code) values('Migration fixture',$1,'fixture-hash',$2,$3) returning id",[email,role,referral])).rows[0].id}
async function applyOriginal(pool){
  const sql=await fs.readFile(path.join(migrationDir,'001_security.sql'),'utf8');
  assert.equal(crypto.createHash('sha256').update(sql).digest('hex'),'4f01404a9dc8030d4826f711835b090551f0b00919634a69fc2d6591fc365889','The already-published 001 migration must stay unchanged');
  await pool.query(sql);
  await pool.query('create table schema_migrations(name text primary key,applied_at timestamptz not null default now())');
  await pool.query("insert into schema_migrations(name) values('001_security.sql')");
}
test('follow-up preserves reviewed original fixture accounts after the earlier migration',async()=>{
  const {config,pool}=await legacyDatabase('migration_original');
  try{
    const tuples=[['ava.tan@mail.sg','customer','REF-AVA'],['raj@harbourlive.sg','organiser','REF-RAJ'],['mei@eventeaseplus.sg','admin','REF-MEI'],['kai@lcsports.sg','organiser','REF-KAI']];
    const ids=[];for(const tuple of tuples)ids.push(await account(pool,...tuple));
    await applyOriginal(pool);
    assert.equal((await pool.query('select count(*)::int n from users where disabled')).rows[0].n,4);
    await pool.query("update users set disabled=false,password_hash='reviewed-password-hash' where id=$1",[ids[2]]);
    await migrate(config);await migrate(config);
    assert.equal((await pool.query('select disabled from users where id=$1',[ids[2]])).rows[0].disabled,false);
    assert.equal((await pool.query('select count(*)::int n from users where disabled')).rows[0].n,3);
    assert.deepEqual((await pool.query('select name from schema_migrations order by name')).rows.map(r=>r.name),['001_security.sql','002_retire_renamed_fixture.sql']);
  }finally{await pool.end()}
});
test('follow-up retires the renamed pre-upgrade fixture once without losing events or orders',async()=>{
  const {config,pool}=await legacyDatabase('migration_renamed');
  try{
    const fixture=await account(pool,'mei@eventease.sg','admin','REF-MEI');
    const unrelated=await account(pool,'mei@another.example','admin','REF-REVIEWED');
    const event=(await pool.query("insert into events(organiser_id,title,category,starts_at,venue,location,price_vip,price_std,price_con,status) values($1,'Preserved event','Concert',now()+interval '1 day','Hall','Area',100,50,20,'live') returning id",[fixture])).rows[0].id;
    const order=(await pool.query("insert into orders(buyer_name,buyer_email,event_id,subtotal,total,payment_method) values('Test buyer','buyer@example.test',$1,50,50,'card') returning id",[event])).rows[0].id;
    await applyOriginal(pool);
    assert.equal((await pool.query('select disabled from users where id=$1',[fixture])).rows[0].disabled,false);
    await pool.query("insert into browser_sessions(token_hash,kind,user_id,fresh_until,expires_at) values('fixture-session','account',$1,now()+interval '1 hour',now()+interval '2 hours')",[fixture]);
    const challenge=crypto.randomUUID();await pool.query("insert into recovery_challenges(id,user_id,code_hash,expires_at) values($1,$2,'fixture-code',now()+interval '10 minutes')",[challenge,fixture]);
    await migrate(config);
    assert.equal((await pool.query('select disabled from users where id=$1',[fixture])).rows[0].disabled,true);
    assert.equal((await pool.query('select disabled from users where id=$1',[unrelated])).rows[0].disabled,false);
    assert.equal((await pool.query('select count(*)::int n from browser_sessions where user_id=$1',[fixture])).rows[0].n,0);
    assert.ok((await pool.query('select consumed_at from recovery_challenges where id=$1',[challenge])).rows[0].consumed_at);
    assert.equal((await pool.query('select organiser_id from events where id=$1',[event])).rows[0].organiser_id,fixture);
    assert.equal((await pool.query('select total from orders where id=$1',[order])).rows[0].total,'50.00');
    await pool.query("update users set disabled=false,password_hash='reviewed-password-hash' where id=$1",[fixture]);
    await migrate(config);
    assert.equal((await pool.query('select disabled from users where id=$1',[fixture])).rows[0].disabled,false,'A recorded migration must not repeat cleanup after operator review');
    assert.equal((await pool.query("select count(*)::int n from schema_migrations where name='002_retire_renamed_fixture.sql'")).rows[0].n,1);
  }finally{await pool.end()}
});
test('follow-up does not retire a renamed administrator provisioned after migration 001',async()=>{
  const {config,pool}=await legacyDatabase('migration_new_admin');
  try{
    await applyOriginal(pool);
    const reviewed=await account(pool,'mei@eventease.sg','admin','REF-MEI');
    await pool.query("update users set created_at=(select applied_at from schema_migrations where name='001_security.sql')+interval '1 second' where id=$1",[reviewed]);
    await migrate(config);
    assert.equal((await pool.query('select disabled from users where id=$1',[reviewed])).rows[0].disabled,false);
  }finally{await pool.end()}
});
