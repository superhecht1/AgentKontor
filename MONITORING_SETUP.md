# Monitoring Setup — AgentKontor

## 1. Sentry (Error-Tracking) — kostenlos bis 5.000 Events/Monat

### Installation
```bash
npm install @sentry/node
```

### In server.js ganz oben einfügen (vor allem anderen):
```javascript
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.1, // 10% der Requests tracen
});

// Request-Handler (vor allen anderen Middlewares)
app.use(Sentry.Handlers.requestHandler());

// Error-Handler (nach allen Routes, vor app.listen)
app.use(Sentry.Handlers.errorHandler());
```

### Render Environment Variable:
```
SENTRY_DSN=https://xxxx@o0.ingest.sentry.io/0
```

### Sentry Account erstellen:
1. sentry.io → Sign Up (kostenlos)
2. Neues Projekt → Node.js
3. DSN kopieren → in Render eintragen

---

## 2. Uptime-Monitoring — kostenlos

### Option A: UptimeRobot (empfohlen)
1. uptimerobot.com → kostenloser Account
2. "Add New Monitor" → HTTP(s)
3. URL: `https://agentkontor.de`
4. Intervall: 5 Minuten
5. Alert-Email: info@think-cloud.org
6. Optional: Statuspage einrichten

### Option B: BetterUptime
1. betteruptime.com → kostenloser Plan
2. Monitor + Statuspage in einem

---

## 3. Cron-Job (DB-Cleanup) — täglich

### cron-job.org (kostenlos)
1. cron-job.org → Account erstellen
2. Neuer Cronjob:
   - URL: `https://agentkontor.de/api/cron/cleanup`
   - Methode: POST
   - Header: `x-cron-secret: DEIN_SECRET`
   - Schedule: täglich 03:00 Uhr

### Render Environment Variable:
```
CRON_SECRET=beliebiger-geheimer-string-hier
```

---

## 4. Logs in Render

Render Dashboard → dein Service → **Logs**

Wichtige Log-Muster:
- `✅ DB ready` — Start erfolgreich
- `REGISTER ERROR:` — Registrierungsfehler
- `⚠ Payment failed` — Stripe-Zahlungsproblem
- `Cron cleanup:` — Aufräumjob gelaufen

---

## 5. Status-Page (optional)

Wenn du eine öffentliche Statusseite willst:
- **instatus.com** — schöne kostenlose Statuspage
- Oder UptimeRobot Public Status Page aktivieren

URL-Vorschlag: `status.agentkontor.de`
