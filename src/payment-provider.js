'use strict';
class PaymentDeclined extends Error {}
function paymentProvider(env, stripeClient) {
  const simulated = env.NODE_ENV !== 'production' && env.ALLOW_SIMULATED_PAYMENTS === 'true';
  const stripe = stripeClient || (env.STRIPE_SECRET_KEY ? require('stripe')(env.STRIPE_SECRET_KEY, { timeout: 15000, maxNetworkRetries: 1 }) : null);
  if (env.NODE_ENV === 'production' && (!stripe || !env.STRIPE_WEBHOOK_SECRET)) throw new Error('Production requires Stripe and webhook configuration');
  function validate(method) {
    if (['card','paynow'].includes(method) && simulated) return;
    if (method === 'stripe' && stripe) return;
    throw Object.assign(new Error('This payment method is not enabled'), { s: 400 });
  }
  async function pay(job) {
    const amount = Number(job.amount_cents);
    if (!amount) return { paid: true, ref: 'FREE' };
    validate(job.method);
    if (job.method !== 'stripe') return { paid: true, ref: 'SIM-' + job.id };
    const session = job.payment_ref?.startsWith('cs_') ? await stripe.checkout.sessions.retrieve(job.payment_ref) :
      await stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'], client_reference_id: job.id, metadata: { jobId: job.id },
        payment_intent_data: { metadata: { jobId: job.id } },
        line_items: [{ quantity: 1, price_data: { currency: 'sgd', unit_amount: amount, product_data: { name: 'Eventeaseplus order ' + job.order_id } } }],
        success_url: env.APP_ORIGIN + '/#order-' + job.order_id, cancel_url: env.APP_ORIGIN + '/#order-' + job.order_id },
      { idempotencyKey: job.id });
    if (session.amount_total !== amount || session.currency !== 'sgd' || session.metadata.jobId !== job.id) throw new Error('Payment amount or order mismatch');
    if (session.payment_status === 'paid') return { paid: true, ref: session.payment_intent };
    if (session.status === 'expired') throw new PaymentDeclined('Payment session expired');
    return { paid: false, ref: session.id, checkoutUrl: session.url };
  }
  async function refund(job) {
    if (!Number(job.amount_cents) || job.payment_ref === 'FREE' || job.payment_ref?.startsWith('SIM-')) return { settled: true };
    if (!stripe || !job.payment_ref?.startsWith('pi_')) throw new Error('Refund requires payment provider reconciliation');
    const r = job.refund_ref ? await stripe.refunds.retrieve(job.refund_ref) : await stripe.refunds.create({ payment_intent: job.payment_ref, amount: Number(job.amount_cents), metadata: {jobId:job.id} }, { idempotencyKey: job.id });
    return { settled: r.status === 'succeeded', refundRef: r.id, attention: ['failed','canceled'].includes(r.status) };
  }
  return { validate, pay, refund, methods: [...(simulated ? ['card','paynow'] : []), ...(stripe ? ['stripe'] : [])],
    webhook: stripe && env.STRIPE_WEBHOOK_SECRET ? (body, signature) => stripe.webhooks.constructEvent(body, signature, env.STRIPE_WEBHOOK_SECRET) : null };
}
module.exports = { paymentProvider, PaymentDeclined };
