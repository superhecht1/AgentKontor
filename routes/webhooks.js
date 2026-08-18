'use strict';
const express = require('express');
const router = express.Router();

// Generic webhook receiver — extend as needed
router.post('/incoming', async (req, res) => {
  console.log('[webhook] incoming:', req.body);
  res.json({ received: true });
});

// Stripe is handled in routes/stripe.js
// Slack  is handled in routes/slack-webhook.js

module.exports = router;
