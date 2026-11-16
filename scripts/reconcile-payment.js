'use strict';
// Operator-only reference linking. It verifies provider records; it never accepts an arbitrary paid flag.
const {createApp} = require('../src/server');
(async()=>{
 const id=process.env.PAYMENT_JOB_ID,sessionId=process.env.STRIPE_SESSION_ID,refundId=process.env.STRIPE_REFUND_ID;
 if(!/^[a-f0-9-]{36}$/.test(id || '') || (!sessionId && !refundId) || (sessionId && refundId)) throw new Error('Provide PAYMENT_JOB_ID and exactly one STRIPE_SESSION_ID or STRIPE_REFUND_ID');
 const app=createApp(),pool=app.locals.pool;
 try{
  const cl=await pool.connect();
  try {
  await cl.query('select pg_advisory_lock(hashtextextended($1,0))',['payment:'+id]);
  const job=(await cl.query("select * from payment_jobs where id=$1 and status='pending'",[id])).rows[0];if(!job)throw new Error('Pending job not found');
  const stripe=require('stripe')(process.env.STRIPE_SECRET_KEY);
  if(sessionId){
   if(job.kind==='refund' || !sessionId.startsWith('cs_'))throw new Error('A Checkout Session is required for a purchase job');
   const session=await stripe.checkout.sessions.retrieve(sessionId);
   if(session.metadata.jobId!==id || session.amount_total!==Number(job.amount_cents) || session.currency!=='sgd')throw new Error('Provider session does not match the job');
   await cl.query('update payment_jobs set payment_ref=$2,next_attempt_at=now(),last_error=null where id=$1',[id,sessionId]);
  }else{
   if(job.kind!=='refund' || !refundId.startsWith('re_'))throw new Error('A refund record is required for a refund job');
   const refund=await stripe.refunds.retrieve(refundId);
   if(refund.payment_intent!==job.payment_ref || refund.amount!==Number(job.amount_cents) || refund.currency!=='sgd' || refund.metadata.jobId!==id)throw new Error('Provider refund does not match the job');
   await cl.query('update payment_jobs set refund_ref=$2,next_attempt_at=now(),last_error=null where id=$1',[id,refundId]);
  }
  }finally{await cl.query('select pg_advisory_unlock(hashtextextended($1,0))',['payment:'+id]);cl.release()}
  await app.locals.runPaymentJob(id);
  console.log('Provider reference verified and job reconciled. Check the administrator status screen for its outcome.');
 }finally{await pool.end()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
