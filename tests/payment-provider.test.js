'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {paymentProvider}=require('../src/payment-provider');
const env={NODE_ENV:'production',ALLOW_SIMULATED_PAYMENTS:'true',APP_ORIGIN:'https://tickets.example.test',STRIPE_WEBHOOK_SECRET:'fixture'};
test('hosted Checkout uses the saved amount and stable operation key',async()=>{
 let created;const adapter={checkout:{sessions:{create:async(body,options)=>{created={body,options};return {id:'cs_fixture',url:'https://checkout.stripe.com/c/pay/fixture',amount_total:2500,currency:'sgd',metadata:{jobId:'job'},status:'open',payment_status:'unpaid'}},retrieve:async()=>({amount_total:2500,currency:'sgd',metadata:{jobId:'job'},payment_status:'paid',payment_intent:'pi_fixture'})}}};
 const p=paymentProvider(env,adapter);assert.throws(()=>p.validate('card'),/not enabled/);const pending=await p.pay({id:'job',order_id:'1001',amount_cents:2500,method:'stripe'});assert.equal(pending.paid,false);assert.equal(created.body.line_items[0].price_data.unit_amount,2500);assert.equal(created.options.idempotencyKey,'job');
 const done=await p.pay({id:'job',order_id:'1001',amount_cents:2500,method:'stripe',payment_ref:pending.ref});assert.equal(done.paid,true);assert.equal(done.ref,'pi_fixture');
});
test('pending refunds retain their provider ID and are retrieved on retry',async()=>{
 let creates=0,retrieves=0;const adapter={refunds:{create:async(body,options)=>{creates++;assert.equal(body.metadata.jobId,'refund-job');assert.equal(options.idempotencyKey,'refund-job');return {id:'re_fixture',status:'pending'}},retrieve:async id=>{retrieves++;assert.equal(id,'re_fixture');return {id,status:'succeeded'}}}};
 const p=paymentProvider(env,adapter),job={id:'refund-job',amount_cents:1000,payment_ref:'pi_fixture'};const pending=await p.refund(job);assert.equal(pending.settled,false);const done=await p.refund({...job,refund_ref:pending.refundRef});assert.equal(done.settled,true);assert.equal(creates,1);assert.equal(retrieves,1);
});
