'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const {JSDOM}=require('jsdom');
const root=path.join(__dirname,'../public');
const tick=()=>new Promise(r=>setTimeout(r,25));
test('guest recovery screen requires email code before opening tickets',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'http://localhost:3000/#find',runScripts:'outside-only'});
 const w=dom.window,calls=[];w.EE={paymentMethods:['card']};w.fetch=async(url,o)=>{calls.push([url,o]);let data;
 if(url==='/api/session') data={user:null};
 else if(url==='/api/orders/lookup')data={challengeId:'11111111-1111-4111-8111-111111111111'};
 else if(url==='/api/orders/verify')data={orderId:'1001'};
 else if(url==='/api/orders/1001')data={id:'1001',total:100,paymentMethod:'card',status:'pending_payment',tickets:[]};
 else data=[];
 return {ok:true,json:async()=>data};};
 try {
  w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8'));await tick();
  let form=w.document.querySelector('[data-form="find"]');assert.ok(form);form.elements.orderId.value='1001';form.elements.email.value='buyer@example.test';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
  form=w.document.querySelector('[data-form="verifyOrder"]');assert.ok(form);assert.equal(calls.some(([u])=>u==='/api/orders/1001'),false);
  form.elements.code.value='123456';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();
  assert.equal(w.location.hash,'#order-1001');assert.match(w.document.querySelector('#app').textContent,/Payment pending/);
  assert.equal(w.localStorage.getItem('ee_tok'),null);assert.equal(w.sessionStorage.getItem('ee_ot'),null);
  const [,request]=calls.find(([u])=>u==='/api/orders/verify');assert.equal(request.credentials,'same-origin');assert.equal(request.headers['X-EE-Request'],'1');
 }finally{w.close()}
});
test('login screen uses cookie session and displays the returned customer',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'http://localhost:3000/#login',runScripts:'outside-only'}),w=dom.window;
 w.EE={paymentMethods:['card']};w.fetch=async(url)=>({ok:true,json:async()=>url==='/api/session'?{user:null}:url==='/api/auth/login'?{user:{name:'Test Customer',email:'customer@example.test',role:'customer'}}:[]});
 try{w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8'));await tick();const form=w.document.querySelector('[data-form="login"]');form.elements.email.value='customer@example.test';form.elements.password.value='LocalFixture123!';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();assert.equal(w.location.hash,'#home');assert.match(w.document.querySelector('#acct').textContent,/Test Customer/);assert.equal(w.localStorage.getItem('ee_tok'),null)}finally{w.close()}
});

const customer={id:'customer-fixture',name:'Test Customer',email:'customer@example.test',role:'customer'};
const pendingApproval={status:'approval_pending',code:'ORGANISER_APPROVAL_PENDING',message:'Awaiting administrator approval.'};
const challengeId='11111111-1111-4111-8111-111111111111';
function accountFixture(hash,responses){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'http://localhost:3000/#'+hash,runScripts:'outside-only'}),w=dom.window,calls=[];
 w.EE={paymentMethods:['card']};w.fetch=async(url,options)=>{
  calls.push([url,options]);const result=typeof responses[url]==='function'?responses[url](options):responses[url];
  const {status=200,body=result??[]}=result?.httpResponse?result:{body:result??[]};
  return {ok:status<400,status,json:async()=>body};
 };
 w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8'));
 return {w,calls,close:()=>w.close()};
}
async function submit(w,name,values){
 const form=w.document.querySelector(`[data-form="${name}"]`);assert.ok(form,`Missing ${name} form`);
 for(const [key,value] of Object.entries(values))form.elements[key].value=value;
 form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();
}
function assertPending(w){
 assert.equal(w.location.hash,'#pending');assert.match(w.document.querySelector('#app').textContent,/Approval pending/);
 assert.match(w.document.querySelector('#app').textContent,/Once approved, log in again/);
 assert.equal(w.document.querySelector('[data-form="verifyLogin"]'),null);
 assert.doesNotMatch(w.document.querySelector('#acct').textContent,/customer account|Test Customer/i);
 assert.equal(w.document.querySelector('#nav a[href="#org"]'),null);
 assert.ok(w.document.querySelector('#app a[href="#login"]'));
}
test('organiser registration shows approval pending and clears an existing customer display',async()=>{
 const f=accountFixture('register-organiser',{'/api/session':{user:customer},'/api/auth/register':pendingApproval});
 try{
  await tick();assert.ok(f.w.document.querySelector('#app a[href="#apply"]'));
  await submit(f.w,'register',{name:'New Organiser',email:'organiser@example.test',password:'LocalFixture123!',role:'organiser'});
  assertPending(f.w);
  const [,request]=f.calls.find(([url])=>url==='/api/auth/register');assert.equal(JSON.parse(request.body).role,'organiser');
  assert.equal(f.calls.some(([url])=>url==='/api/organiser/events'),false);
 }finally{f.close()}
});
test('pending organiser login shows its approval state without email verification or a customer account',async()=>{
 const f=accountFixture('login',{'/api/session':{user:null},'/api/auth/login':pendingApproval});
 try{await tick();await submit(f.w,'login',{email:'organiser@example.test',password:'LocalFixture123!'});assertPending(f.w)}finally{f.close()}
});
test('approved organiser must complete email verification before opening the dashboard',async()=>{
 const organiser={id:'organiser-fixture',name:'Test Organiser',email:'organiser@example.test',role:'organiser',organiser_approved:true};
 const f=accountFixture('login',{'/api/session':{user:customer},'/api/auth/login':{challengeId},'/api/auth/verify':{user:organiser},'/api/organiser/events':[]});
 try{
  await tick();await submit(f.w,'login',{email:organiser.email,password:'LocalFixture123!'});
  assert.ok(f.w.document.querySelector('[data-form="verifyLogin"]'));
  assert.doesNotMatch(f.w.document.querySelector('#acct').textContent,/Test Customer/);
  assert.equal(f.calls.some(([url])=>url==='/api/organiser/events'),false);
  await submit(f.w,'verifyLogin',{code:'123456'});
  assert.equal(f.w.location.hash,'#org');assert.match(f.w.document.querySelector('#acct').textContent,/organiser account/);
  assert.ok(f.w.document.querySelector('[data-form="create"]'));
  const [,request]=f.calls.find(([url])=>url==='/api/auth/verify');assert.deepEqual(JSON.parse(request.body),{challengeId,code:'123456'});
 }finally{f.close()}
});
test('customer requests organiser access explicitly with their current password and then sees pending approval',async()=>{
 const f=accountFixture('profile',{'/api/session':{user:customer},'/api/me/organiser-request':pendingApproval});
 try{
  await tick();const link=f.w.document.querySelector('#app a[href="#apply"]');assert.ok(link);link.click();await tick();
  assert.match(f.w.document.querySelector('#app').textContent,/Submitting signs you out/);
  assert.match(f.w.document.querySelector('#app').textContent,/booking history are kept/);
  assert.match(f.w.document.querySelector('#app').textContent,/To buy tickets, use guest checkout/);
  assert.equal(f.calls.some(([url])=>url==='/api/me/organiser-request'),false);
  await submit(f.w,'organiserRequest',{currentPassword:'LocalFixture123!'});assertPending(f.w);
  const [,request]=f.calls.find(([url])=>url==='/api/me/organiser-request');assert.deepEqual(JSON.parse(request.body),{currentPassword:'LocalFixture123!'});
 }finally{f.close()}
});
test('approval revoked during email verification returns to the pending page',async()=>{
 const f=accountFixture('login',{'/api/session':{user:null},'/api/auth/login':{challengeId},'/api/auth/verify':pendingApproval});
 try{await tick();await submit(f.w,'login',{email:'organiser@example.test',password:'LocalFixture123!'});await submit(f.w,'verifyLogin',{code:'123456'});assertPending(f.w)}finally{f.close()}
});
test('pending approval error response is handled without falling back to customer login',async()=>{
 const f=accountFixture('login',{'/api/session':{user:null},'/api/auth/login':{httpResponse:true,status:403,body:{...pendingApproval,error:'Awaiting approval'}}});
 try{await tick();await submit(f.w,'login',{email:'organiser@example.test',password:'LocalFixture123!'});assertPending(f.w)}finally{f.close()}
});
test('failed staff email delivery refreshes the session and removes the old customer display',async()=>{
 let sessionReads=0;
 const f=accountFixture('login',{'/api/session':()=>({user:sessionReads++===0?customer:null}),'/api/auth/login':{httpResponse:true,status:503,body:{error:'Verification email could not be sent. Please try again later.'}}});
 try{
  await tick();assert.match(f.w.document.querySelector('#acct').textContent,/Test Customer/);
  await submit(f.w,'login',{email:'organiser@example.test',password:'LocalFixture123!'});
  assert.equal(sessionReads,2);assert.doesNotMatch(f.w.document.querySelector('#acct').textContent,/Test Customer|customer account/i);
  assert.match(f.w.document.querySelector('#err').textContent,/Verification email could not be sent/);
  assert.ok(f.w.document.querySelector('[data-form="login"]'));
 }finally{f.close()}
});
test('an incorrect login password keeps a still-valid existing customer session visible',async()=>{
 let sessionReads=0;
 const f=accountFixture('login',{'/api/session':()=>{sessionReads++;return {user:customer}},'/api/auth/login':{httpResponse:true,status:401,body:{error:'Email or password is incorrect'}}});
 try{
  await tick();await submit(f.w,'login',{email:'organiser@example.test',password:'IncorrectFixture!'});
  assert.equal(sessionReads,2);assert.match(f.w.document.querySelector('#acct').textContent,/Test Customer/);
  assert.match(f.w.document.querySelector('#err').textContent,/Email or password is incorrect/);
 }finally{f.close()}
});
test('administrator distinguishes organisers with the same name by email and approves their separate account IDs',async()=>{
 const organisers=[
  {id:'organiser-one',name:'Test Organiser',email:'first@example.test',organiser_approved:false},
  {id:'organiser-two',name:'Test Organiser',email:'second@example.test',organiser_approved:false}
 ];
 const f=accountFixture('admin',{'/api/session':{user:{name:'Test Administrator',role:'admin'}},'/api/admin/summary':{live_events:0,pending_events:0,orders:0,booked:0,open_flags:0},'/api/admin/organisers':organisers,'/api/admin/events':[],'/api/admin/fraud':[],'/api/admin/settings':{hold_minutes:8,refund_hours:48,max_seats:8},'/api/admin/payment-jobs':[]});
 try{
  await tick();const buttons=[...f.w.document.querySelectorAll('[data-a="apO"]')];assert.equal(buttons.length,2);
  for(const [index,button] of buttons.entries()){
   const row=button.closest('.manage-item');assert.equal(button.dataset.v,organisers[index].id);
   assert.equal(row.querySelector('b').textContent,'Test Organiser');assert.equal(row.querySelector('.mute').textContent,organisers[index].email);
   assert.match(row.textContent,/Pending/);
  }
 }finally{f.close()}
});
