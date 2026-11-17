'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const script=path.join(__dirname,'../deploy/deploy.sh');

// Exercise the real deployment control flow with disposable command doubles.
// No Docker daemon, sudo access, network or /run writes are involved.
const commandDouble=String.raw`
const fs=require('node:fs'),path=require('node:path');
const statePath=process.env.DEPLOY_FIXTURE_STATE;
const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
const tool=path.basename(process.argv[1]),args=process.argv.slice(2);
state.calls.push([tool,...args]);
const finish=(status=0,text='')=>{fs.writeFileSync(statePath,JSON.stringify(state));if(text)process.stdout.write(text+'\n');process.exit(status)};
if(tool==='flock')finish();
if(tool==='stat')finish(0,'600');
if(tool==='sleep')finish();
if(tool==='curl')finish(state.running==='eventease'?0:1);
if(tool!=='sudo')finish(99);
if(args[0]==='touch'){state.maintenance=true;finish()}
if(args[0]==='rm'){state.maintenance=false;finish()}
if(args[0]!=='docker')finish(99);
const a=args.slice(1);
if(a[0]==='inspect'){
 const name=a.at(-1),format=a[a.indexOf('--format')+1];
 if(name!==state.running)finish(1);
 finish(0,format==='{{.State.Running}}'?'true':'legacy-image');
}
if(a[0]==='image'&&a[1]==='inspect'){
 const image=a.at(-1),format=a[a.indexOf('--format')+1];
 if(image!=='legacy-image')finish(1);
 if(format==='{{.Id}}')finish(0,image);
 finish(0,format.includes('org.eventeaseplus.security-schema')?'1':'<no value>');
}
if(a[0]==='build'||a[0]==='tag'||a[0]==='rmi'||a[0]==='logs'||a[0]==='images')finish();
if(a[0]==='rm'){
 if(a.includes(state.running))state.running=null;
 finish();
}
if(a[0]==='run'){
 if(a.includes('scripts/check-config.js'))finish(state.failPreflight?1:0);
 if(a.includes('-e'))finish(state.failPreviousPreflight?1:0);
 if(a.includes('db/migrate.js'))finish(state.failMigration?1:0);
 if(a.includes('-d')){
  const image=a.at(-1);
  if(state.running)finish(125,'port already allocated');
  if(image==='eventease:current'&&state.failNewStart)finish(125,'fixture startup failure');
  state.running='eventease';state.startedImage=image;finish(0,'fixture-container');
 }
}
finish(99);
`;

async function runFixture(options={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'eventease-deploy-test-'));
 try{
  const bin=path.join(dir,'bin'),statePath=path.join(dir,'state.json'),envPath=path.join(dir,'eventeaseplus.env'),ca=path.join(dir,'ca.pem');
  await fs.mkdir(bin);await fs.writeFile(envPath,'QR_SECRET=fixture-keep-this-value\n',{mode:0o600});await fs.writeFile(ca,'fixture CA');
  await fs.writeFile(statePath,JSON.stringify({running:'eventeaseplus',calls:[],maintenance:false,...options}));
  for(const name of ['sudo','flock','stat','curl','sleep'])await fs.writeFile(path.join(bin,name),'#!'+process.execPath+'\n'+commandDouble,{mode:0o755});
  const result=spawnSync('bash',[script,'fixture-release'],{encoding:'utf8',env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,EVENTEASE_DEPLOY_HOME:dir,EVENTEASE_ENV_FILE:'',DB_CA_HOST_FILE:ca,DEPLOY_FIXTURE_STATE:statePath}});
  const state=JSON.parse(await fs.readFile(statePath,'utf8'));
  assert.equal(await fs.readFile(envPath,'utf8'),'QR_SECRET=fixture-keep-this-value\n');
  assert.ok(!result.stdout.includes('fixture-keep-this-value'));
  return {result,state,envPath};
 }finally{await fs.rm(dir,{recursive:true,force:true})}
}
const callIndex=(calls,predicate)=>calls.findIndex(predicate);

test('deployment transitions a legacy container only after configuration and migrations succeed',async()=>{
 const {result,state,envPath}=await runFixture();
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 assert.equal(state.running,'eventease');assert.equal(state.maintenance,false);
 assert.equal(state.startedImage,'eventease:current');
 const {calls}=state,preflight=callIndex(calls,c=>c.includes('scripts/check-config.js')),maintenance=callIndex(calls,c=>c[1]==='touch'),migration=callIndex(calls,c=>c.includes('db/migrate.js')),remove=callIndex(calls,c=>c[1]==='docker'&&c[2]==='rm');
 assert.ok(preflight>=0&&preflight<maintenance&&maintenance<migration&&migration<remove);
 assert.ok(calls[remove].includes('eventease')&&calls[remove].includes('eventeaseplus'));
 assert.deepEqual(calls.filter(c=>c[0]==='flock').map(c=>c.at(-1)),['9','8']);
 for(const c of calls.filter(c=>c[1]==='docker'&&c[2]==='run')){
  assert.ok(c.includes('NODE_ENV=production'));assert.equal(c[c.indexOf('--env-file')+1],envPath);
 }
 assert.ok(calls[maintenance].includes('/run/eventease-maintenance')&&calls[maintenance].includes('/run/eventeaseplus-maintenance'));
});

test('a failed new container start reaches compatible legacy-image rollback',async()=>{
 const {result,state}=await runFixture({failNewStart:true});
 assert.equal(result.status,1);assert.match(result.stdout,/Rolled back and healthy/);
 assert.equal(state.running,'eventease');assert.equal(state.startedImage,'legacy-image');assert.equal(state.maintenance,false);
 assert.ok(state.calls.some(c=>c.includes('legacy-image')&&c.some(a=>a.includes('org.eventeaseplus.security-schema'))));
});

test('configuration preflight failure leaves the previous application running without maintenance',async()=>{
 const {result,state}=await runFixture({failPreflight:true});
 assert.equal(result.status,1);assert.equal(state.running,'eventeaseplus');assert.equal(state.maintenance,false);
 assert.equal(state.calls.some(c=>c.includes('db/migrate.js')||c[1]==='touch'||(c[1]==='docker'&&c[2]==='rm')),false);
});

test('migration failure preserves the old container and keeps maintenance enabled',async()=>{
 const {result,state}=await runFixture({failMigration:true});
 assert.equal(result.status,1);assert.equal(state.running,'eventeaseplus');assert.equal(state.maintenance,true);
 assert.equal(state.calls.some(c=>c[1]==='docker'&&c[2]==='rm'),false);
});

test('an incompatible previous configuration is detected before maintenance and is not started as rollback',async()=>{
 const {result,state}=await runFixture({failPreviousPreflight:true,failNewStart:true});
 assert.equal(result.status,1);assert.match(result.stdout,/previous image cannot use the current configuration/);
 assert.match(result.stdout,/Maintenance remains enabled/);assert.equal(state.maintenance,true);
 const preflight=callIndex(state.calls,c=>c.includes('-e')&&c.includes('legacy-image'));
 const maintenance=callIndex(state.calls,c=>c[1]==='touch');
 assert.ok(preflight>=0&&preflight<maintenance);
 assert.equal(state.calls.some(c=>c[1]==='docker'&&c[2]==='run'&&c.includes('-d')&&c.at(-1)==='legacy-image'),false);
});
