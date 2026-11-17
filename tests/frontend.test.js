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
test('classroom demo notice is visible and old events are removed from the catalogue',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'http://localhost:3000/#home',runScripts:'outside-only'}),w=dom.window;
 const event={id:1,title:'Future fixture',venue:'Hall',location:'Area',category:'Theatre',status:'live',prices:{vip:100,std:50,con:20},available:20,startsAt:new Date(Date.now()+86400000).toISOString()};
 w.EE={demoMode:true,paymentMethods:['card'],resaleEnabled:false};
 w.fetch=async url=>({ok:true,json:async()=>url==='/api/session'?{user:null}:[event,{...event,id:2,title:'Past fixture',startsAt:new Date(Date.now()-86400000).toISOString()}]});
 try{w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8'));await tick();await tick();assert.equal(w.document.querySelector('#demo-notice').hidden,false);assert.match(w.document.querySelector('#demo-notice').textContent,/No real payment/);assert.match(w.document.querySelector('#grid').textContent,/Future fixture/);assert.doesNotMatch(w.document.querySelector('#grid').textContent,/Past fixture/)}finally{w.close()}
});
test('an old event link shows booking closed without requesting seats or joining a queue',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'http://localhost:3000/#event-2',runScripts:'outside-only'}),w=dom.window,calls=[];
 w.EE={demoMode:true,paymentMethods:['card'],resaleEnabled:false};
 w.fetch=async url=>{calls.push(url);return {ok:true,json:async()=>url==='/api/session'?{user:null}:{id:2,title:'Past fixture',venue:'Hall',status:'live',startsAt:new Date(Date.now()-86400000).toISOString(),bookingOpen:false}}};
 try{w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8'));await tick();await tick();assert.match(w.document.querySelector('#app').textContent,/Booking is closed/);assert.equal(calls.some(u=>u.includes('/seats')||u.includes('/queue')),false);assert.equal(w.document.querySelector('[data-a="pay"]'),null)}finally{w.close()}
});
