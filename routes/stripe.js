/**
 * AgentKontor — Stripe Integration
 * POST /api/stripe/create-checkout  — start Pro checkout session
 * POST /api/stripe/portal           — customer portal (manage/cancel)
 * POST /api/stripe/webhook          — Stripe webhook (raw body required)
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');

function getPool(req) { return req.app.locals.pool; }
function getStripe()  { return require('stripe')(process.env.STRIPE_SECRET_KEY); }

/* ── CREATE CHECKOUT SESSION ─────────────────────────────── */
router.post('/create-checkout', auth, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY)
    return res.status(503).json({ error: 'Stripe nicht konfiguriert' });

  const pool   = getPool(req);
  const stripe = getStripe();

  try {
    const r = await pool.query(
      'SELECT email, name, stripe_customer_id FROM users WHERE id=$1', [req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    const user = r.rows[0];

    // Create or reuse Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name:  user.name,
        metadata: { userId: String(req.userId) },
      });
      customerId = customer.id;
      await pool.query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2', [customerId, req.userId]);
    }

    const baseUrl = process.env.APP_URL || 'https://agentkontor.de';

    const { cycle = 'monthly', coupon } = req.body;
    const priceId = cycle === 'yearly'
      ? (process.env.STRIPE_YEARLY_PRICE_ID || process.env.STRIPE_PRO_PRICE_ID)
      : process.env.STRIPE_PRO_PRICE_ID;

    if (!priceId) return res.status(500).json({ error: 'Stripe Price ID nicht konfiguriert' });

    const session = await stripe.checkout.sessions.create({
      customer:   customerId,
      mode:       'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/app?upgrade=success`,
      cancel_url:  `${baseUrl}/app?upgrade=cancelled`,
      allow_promotion_codes: true,
      metadata: { userId: String(req.userId) },
      subscription_data: {
        metadata: { userId: String(req.userId) },
      },
    });

    res.json({ url: session.url });
  } catch(e) {
    console.error('Stripe checkout error:', e);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

/* ── CUSTOMER PORTAL (manage / cancel) ───────────────────── */
router.post('/portal', auth, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY)
    return res.status(503).json({ error: 'Stripe nicht konfiguriert' });

  const pool   = getPool(req);
  const stripe = getStripe();

  try {
    const r = await pool.query('SELECT stripe_customer_id FROM users WHERE id=$1', [req.userId]);
    if (!r.rows[0]?.stripe_customer_id)
      return res.status(400).json({ error: 'Kein Stripe-Konto verknüpft' });

    const baseUrl = process.env.APP_URL || 'https://agentkontor.de';
    const session = await stripe.billingPortal.sessions.create({
      customer:   r.rows[0].stripe_customer_id,
      return_url: `${baseUrl}/app`,
    });
    res.json({ url: session.url });
  } catch(e) {
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

/* ── WEBHOOK (raw body, no JSON parse) ───────────────────── */
router.post('/webhook', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET)
    return res.status(503).send('Stripe nicht konfiguriert');

  const stripe = getStripe();
  const sig    = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) {
    console.error('Stripe webhook signature error:', e.message);
    return res.status(400).send("Webhook-Signatur ungültig");
  }

  const pool = req.app.locals.pool;

  try {
    switch(event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId  = session.metadata?.userId;
        if (userId && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          const periodEnd = new Date(sub.current_period_end * 1000);
          await pool.query(
            `UPDATE users SET plan='pro', stripe_subscription_id=$1, plan_period_end=$2 WHERE id=$3`,
            [session.subscription, periodEnd, userId]
          );
          console.log(`✅ Upgraded user ${userId} to Pro`);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          const periodEnd = new Date(sub.current_period_end * 1000);
          const userId = sub.metadata?.userId;
          if (userId) {
            await pool.query(
              `UPDATE users SET plan='pro', plan_period_end=$1,
               billing_cycle=CASE WHEN $3='year' THEN 'yearly' ELSE 'monthly' END
               WHERE id=$2`,
              [periodEnd, userId, sub.items?.data?.[0]?.plan?.interval || 'month']
            );
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          const userId = sub.metadata?.userId;
          if (userId) {
            console.warn(`⚠️ Payment failed for user ${userId}`);
            // Send dunning email
            setImmediate(async () => {
              try {
                const ur = await pool.query('SELECT email, name FROM users WHERE id=$1', [userId]);
                if (!ur.rows.length || !process.env.SMTP_HOST) return;
                const { email, name } = ur.rows[0];
                const nodemailer = require('nodemailer');
                const t = nodemailer.createTransport({
                  host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT||'587'), secure: false,
                  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
                });
                const portalUrl = process.env.APP_URL + '/app';
                await t.sendMail({
                  from: `AgentKontor <${process.env.SMTP_FROM||'noreply@agentkontor.de'}>`,
                  to: email,
                  subject: 'Zahlung fehlgeschlagen – AgentKontor Pro',
                  html: `<div style="font-family:sans-serif;max-width:520px;margin:40px auto;padding:32px;background:#fff;border-radius:12px">
                    <h2 style="color:#1a1916">Hallo ${name},</h2>
                    <p style="color:#7a786e;line-height:1.7">deine Zahlung für AgentKontor Pro konnte leider nicht verarbeitet werden. Wir versuchen es in den nächsten Tagen erneut.</p>
                    <p style="color:#7a786e;line-height:1.7">Bitte prüfe deine Zahlungsmethode um eine Unterbrechung deines Pro-Zugangs zu vermeiden.</p>
                    <a href="${portalUrl}" style="display:inline-block;background:#6c5ce7;color:#fff;padding:11px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:14px">Zahlungsmethode aktualisieren →</a>
                    <p style="color:#a8a49a;font-size:.76rem;margin-top:20px">Fragen? info@think-cloud.org</p>
                  </div>`
                });
              } catch(e) { console.warn('Dunning email error:', e.message); }
            });
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub    = event.data.object;
        const userId = sub.metadata?.userId;
        if (userId) {
          await pool.query(
            `UPDATE users SET plan='free', stripe_subscription_id=NULL, plan_period_end=NULL WHERE id=$1`,
            [userId]
          );
          console.log(`📉 Downgraded user ${userId} to Free`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub     = event.data.object;
        const userId  = sub.metadata?.userId;
        if (userId) {
          const newPlan   = sub.status === 'active' ? 'pro' : 'free';
          const periodEnd = new Date(sub.current_period_end * 1000);
          await pool.query(
            `UPDATE users SET plan=$1, plan_period_end=$2 WHERE id=$3`,
            [newPlan, periodEnd, userId]
          );
        }
        break;
      }

      default:
        // Ignore unhandled events
    }
  } catch(e) {
    console.error('Stripe webhook handler error:', e);
    return res.status(500).json({ error: 'Interner Fehler' });
  }

  res.json({ received: true });
});

module.exports = router;
