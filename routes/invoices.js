/**
 * AgentKontor — PDF-Rechnungen (§19 UStG Kleinunternehmer)
 *
 * GET  /api/invoices           — list user's invoices
 * GET  /api/invoices/:id/pdf   — download PDF
 * POST /api/invoices/generate  — generate from Stripe invoice (called by webhook)
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const path   = require('path');
const fs     = require('fs');

function getPool(req) { return req.app.locals.pool; }

/* ── LIST INVOICES ──────────────────────────────────────── */
router.get('/', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const r = await pool.query(
      'SELECT id, invoice_number, amount_eur, description, status, issued_at FROM invoices WHERE user_id=$1 ORDER BY issued_at DESC',
      [req.userId]
    );
    res.json({ invoices: r.rows });
  } catch(e) { res.json({ invoices: [] }); }
});

/* ── GENERATE PDF ───────────────────────────────────────── */
router.get('/:id/pdf', auth, async (req, res) => {
  const pool = getPool(req);
  try {
    const inv = await pool.query(
      'SELECT i.*, u.name AS customer_name, u.email AS customer_email FROM invoices i JOIN users u ON i.user_id=u.id WHERE i.id=$1 AND i.user_id=$2',
      [req.params.id, req.userId]
    );
    if (!inv.rows.length) return res.status(404).json({ error: 'Rechnung nicht gefunden' });

    const invoice = inv.rows[0];
    const html    = generateInvoiceHTML(invoice);

    // Try puppeteer for PDF generation, fall back to HTML
    try {
      const puppeteer = require('puppeteer');
      const browser   = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page      = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true });
      await browser.close();

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="rechnung-${invoice.invoice_number}.pdf"`);
      res.send(pdf);
    } catch {
      // Fallback: send HTML as download
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="rechnung-${invoice.invoice_number}.html"`);
      res.send(html);
    }
  } catch(e) {
    console.error('Invoice PDF error:', e.message);
    res.status(500).json({ error: 'Fehler beim Generieren' });
  }
});

/* ── GENERATE FROM STRIPE (internal) ───────────────────── */
async function generateFromStripe(pool, stripeInvoice, userId) {
  try {
    // Get next invoice number
    const seq = await pool.query("SELECT nextval('invoice_seq') AS n");
    const invoiceNumber = `AK-${new Date().getFullYear()}-${String(seq.rows[0].n).padStart(4, '0')}`;
    const amountEur    = (stripeInvoice.amount_paid || 0) / 100;

    const r = await pool.query(
      `INSERT INTO invoices (user_id, stripe_invoice_id, invoice_number, amount_eur, description, status, issued_at)
       VALUES ($1,$2,$3,$4,$5,'paid',NOW())
       ON CONFLICT (stripe_invoice_id) DO NOTHING
       RETURNING id`,
      [userId, stripeInvoice.id, invoiceNumber, amountEur, 'AgentKontor Pro — Monatliches Abonnement']
    );

    if (r.rows.length) {
      console.log(`✅ Invoice generated: ${invoiceNumber} for user ${userId}`);
    }
    return r.rows[0]?.id;
  } catch(e) { console.error('Invoice generation error:', e.message); }
}

/* ── HTML TEMPLATE (§19 UStG) ───────────────────────────── */
function generateInvoiceHTML(invoice) {
  const date = new Date(invoice.issued_at).toLocaleDateString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #1a1a1a; background: #fff; padding: 40px; max-width: 800px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 48px; }
  .logo { font-size: 20pt; font-weight: 800; color: #1a1a1a; }
  .logo span { color: #6c5ce7; }
  .invoice-title { font-size: 14pt; font-weight: 700; margin-bottom: 4px; }
  .invoice-meta { font-size: 9pt; color: #666; }
  .addresses { display: flex; gap: 80px; margin-bottom: 36px; }
  .address h3 { font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #888; margin-bottom: 8px; }
  .address p { font-size: 10pt; line-height: 1.7; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 28px; }
  th { padding: 9px 12px; text-align: left; background: #f8f8f8; border-bottom: 2px solid #e0e0e0; font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #666; }
  td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; font-size: 10pt; }
  .total-section { display: flex; justify-content: flex-end; }
  .total-box { width: 280px; }
  .total-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 10pt; }
  .total-row.final { font-weight: 700; font-size: 12pt; border-top: 2px solid #1a1a1a; padding-top: 10px; margin-top: 4px; }
  .notice { margin-top: 36px; padding: 16px; background: #f8f8f8; border-left: 3px solid #6c5ce7; font-size: 9pt; color: #555; line-height: 1.6; }
  .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e0e0e0; font-size: 8.5pt; color: #888; display: flex; gap: 40px; }
</style>
</head>
<body>
<div class="header">
  <div class="logo">Agent<span>Kontor</span></div>
  <div>
    <div class="invoice-title">Rechnung</div>
    <div class="invoice-meta">Nr. ${invoice.invoice_number}</div>
    <div class="invoice-meta">Datum: ${date}</div>
  </div>
</div>

<div class="addresses">
  <div class="address">
    <h3>Rechnungssteller</h3>
    <p>
      <strong>Mark Rusniok</strong><br>
      superhecht.ai<br>
      Gottesweg 20<br>
      50969 Köln<br>
      Deutschland<br>
      info@think-cloud.org
    </p>
  </div>
  <div class="address">
    <h3>Rechnungsempfänger</h3>
    <p>
      <strong>${invoice.customer_name || invoice.customer_email}</strong><br>
      ${invoice.customer_email}
    </p>
  </div>
</div>

<table>
  <thead>
    <tr><th>Position</th><th>Beschreibung</th><th style="text-align:right">Betrag</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>1</td>
      <td>${invoice.description || 'AgentKontor Pro — Monatliches Abonnement'}</td>
      <td style="text-align:right">€${parseFloat(invoice.amount_eur).toFixed(2)}</td>
    </tr>
  </tbody>
</table>

<div class="total-section">
  <div class="total-box">
    <div class="total-row">
      <span>Nettobetrag</span>
      <span>€${parseFloat(invoice.amount_eur).toFixed(2)}</span>
    </div>
    <div class="total-row">
      <span>Umsatzsteuer</span>
      <span>€0,00</span>
    </div>
    <div class="total-row final">
      <span>Gesamtbetrag</span>
      <span>€${parseFloat(invoice.amount_eur).toFixed(2)}</span>
    </div>
  </div>
</div>

<div class="notice">
  <strong>Hinweis gemäß § 19 UStG:</strong> Kein Ausweis von Umsatzsteuer, da Kleinunternehmer im Sinne von § 19 Abs. 1 UStG.
</div>

<div class="footer">
  <div><strong>AgentKontor / superhecht.ai</strong><br>Mark Rusniok<br>Gottesweg 20, 50969 Köln</div>
  <div><strong>Kontakt</strong><br>info@think-cloud.org<br>https://agentkontor.de</div>
  <div><strong>Zahlung</strong><br>Bezahlt via Stripe<br>Datum: ${date}</div>
</div>
</body>
</html>`;
}

module.exports = router;
module.exports.generateFromStripe = generateFromStripe;
