'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

const AVAILABLE_MODELS = [
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', recommended: true },
  { id: 'claude-opus-4-6',   name: 'Claude Opus 4.6',   provider: 'anthropic', premium: true },
  { id: 'claude-haiku-4-5',  name: 'Claude Haiku 4.5',  provider: 'anthropic', fast: true },
  { id: 'gpt-4o',            name: 'GPT-4o',             provider: 'openai' },
  { id: 'gpt-4o-mini',       name: 'GPT-4o Mini',        provider: 'openai', fast: true },
  { id: 'gemini-2.0-flash',  name: 'Gemini 2.0 Flash',   provider: 'google', fast: true },
];

router.get('/', auth, (req, res) => {
  res.json({ models: AVAILABLE_MODELS });
});

module.exports = router;
