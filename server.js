/**
 * MailFlow Backend — server.js
 * Stack: Node.js + Express + Resend SDK + SQLite (via better-sqlite3)
 *
 * Instalar dependencias:
 *   npm install express resend better-sqlite3 cors dotenv
 *
 * Variables de entorno (.env):
 *   RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
 *   SENDER_EMAIL=hola@tudominio.com
 *   SENDER_NAME=Tu Empresa
 *   TRACKING_DOMAIN=https://track.tudominio.com
 *   PORT=3001
 *   WEBHOOK_SECRET=tu_secreto_resend   (opcional, para verificar firma)
 */

require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const { Resend } = require("resend");
const Database  = require("better-sqlite3");
const crypto    = require("crypto");
const path      = require("path");

const app    = express();
const resend = new Resend(process.env.RESEND_API_KEY);
const db     = new Database(path.join(__dirname, "mailflow.db"));
const PORT   = process.env.PORT || 3001;
const DOMAIN = process.env.TRACKING_DOMAIN || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());

/* ─── DATABASE SETUP ────────────────────────────────────────────────────────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS campaigns (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    status      TEXT DEFAULT 'draft',
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    name        TEXT,
    status      TEXT DEFAULT 'subscribed',  -- subscribed | bounced | unsubscribed
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sequences (
    id           TEXT PRIMARY KEY,
    campaign_id  TEXT NOT NULL,
    step         INTEGER NOT NULL,
    subject      TEXT NOT NULL,
    body_html    TEXT NOT NULL,
    delay_days   INTEGER DEFAULT 0,
    condition    TEXT,                       -- null | 'opened_previous'
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );

  CREATE TABLE IF NOT EXISTS sends (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    campaign_id  TEXT NOT NULL,
    contact_id   TEXT NOT NULL,
    step         INTEGER NOT NULL,
    message_id   TEXT,                       -- Resend message ID
    status       TEXT DEFAULT 'sent',        -- sent | bounced | delivered
    sent_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS opens (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    campaign_id  TEXT NOT NULL,
    contact_id   TEXT NOT NULL,
    step         INTEGER NOT NULL,
    opened_at    TEXT DEFAULT (datetime('now')),
    ip           TEXT,
    user_agent   TEXT
  );

  CREATE TABLE IF NOT EXISTS automation_queue (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    campaign_id  TEXT NOT NULL,
    contact_id   TEXT NOT NULL,
    step         INTEGER NOT NULL,
    send_after   TEXT NOT NULL,              -- ISO datetime
    status       TEXT DEFAULT 'pending',    -- pending | sent | cancelled
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    type         TEXT NOT NULL,              -- open | click | bounce | unsubscribe | send
    campaign_id  TEXT,
    contact_id   TEXT,
    step         INTEGER,
    meta         TEXT,                       -- JSON string for extra data
    created_at   TEXT DEFAULT (datetime('now'))
  );
`);

/* ─── HELPERS ───────────────────────────────────────────────────────────────── */
const uid = () => crypto.randomBytes(8).toString("hex");

/** Pixel 1×1 GIF transparente */
const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

/** Genera HTML del email con pixel y enlace de baja */
function buildEmailHtml({ subject, body, pixelUrl, unsubscribeUrl }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${subject}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           max-width: 600px; margin: 0 auto; padding: 32px 24px; color: #1a1a2e; background: #fff; }
    h1   { color: #5b3fff; font-size: 24px; margin-bottom: 16px; }
    .cta { display: inline-block; margin-top: 24px; padding: 14px 32px; background: #5b3fff;
           color: #fff; border-radius: 8px; text-decoration: none; font-weight: 700; }
    .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #eee;
              font-size: 11px; color: #999; }
    .footer a { color: #999; }
  </style>
</head>
<body>
  <h1>${subject}</h1>
  <div>${body.replace(/\n/g, "<br>")}</div>
  <a class="cta" href="#">Ver más →</a>
  <div class="footer">
    © ${new Date().getFullYear()} Tu Empresa ·
    <a href="${unsubscribeUrl}">Cancelar suscripción</a>
  </div>
  <!-- Pixel de rastreo de apertura -->
  <img src="${pixelUrl}" width="1" height="1"
       style="display:block;width:1px;height:1px;opacity:0;border:0" alt="">
</body>
</html>`;
}

/** Programa el siguiente email en la secuencia para un contacto */
async function scheduleNextEmail(campaignId, contactId, currentStep) {
  const next = db.prepare(`
    SELECT * FROM sequences
    WHERE campaign_id = ? AND step = ? AND condition = 'opened_previous'
  `).get(campaignId, currentStep + 1);

  if (!next) return null; // No hay siguiente paso

  const contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId);
  if (!contact || contact.status !== "subscribed") return null;

  // Verificar si ya está en cola
  const existing = db.prepare(`
    SELECT id FROM automation_queue
    WHERE campaign_id = ? AND contact_id = ? AND step = ? AND status = 'pending'
  `).get(campaignId, contactId, next.step);
  if (existing) return null;

  const sendAfter = new Date(Date.now() + next.delay_days * 86400 * 1000).toISOString();
  db.prepare(`
    INSERT INTO automation_queue (id, campaign_id, contact_id, step, send_after)
    VALUES (?, ?, ?, ?, ?)
  `).run(uid(), campaignId, contactId, next.step, sendAfter);

  console.log(`[AUTOMATION] Programado email paso ${next.step} para ${contact.email} en ${sendAfter}`);
  return { step: next.step, sendAfter };
}

/* ─── SEND EMAIL ─────────────────────────────────────────────────────────────── */
/**
 * POST /api/send
 * Body: { to, subject, bodyHtml?, bodyText?, campaignId, contactId, step, from?, apiKey? }
 */
app.post("/api/send", async (req, res) => {
  const {
    to, subject, bodyHtml, bodyText,
    campaignId, contactId, step,
    from = process.env.SENDER_EMAIL,
    fromName = process.env.SENDER_NAME || "MailFlow",
  } = req.body;

  if (!to || !subject || !campaignId || !contactId) {
    return res.status(400).json({ ok: false, error: "Faltan campos requeridos" });
  }

  // Verificar contacto no rebotado
  const contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId);
  if (contact && contact.status === "bounced") {
    return res.json({ ok: false, error: "Contacto con rebote — excluido" });
  }

  const pixelUrl       = `${DOMAIN}/pixel/${campaignId}/${contactId}/${step}.png`;
  const unsubscribeUrl = `${DOMAIN}/unsub/${contactId}`;
  const html = bodyHtml || buildEmailHtml({
    subject, body: bodyText || subject, pixelUrl, unsubscribeUrl
  });

  try {
    const { data, error } = await resend.emails.send({
      from:    `${fromName} <${from}>`,
      to:      [to],
      subject,
      html,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "X-Campaign-Id":    campaignId,
        "X-Contact-Id":     contactId,
      },
    });

    if (error) {
      console.error("[RESEND ERROR]", error);
      return res.json({ ok: false, error: error.message });
    }

    // Registrar envío
    db.prepare(`
      INSERT OR IGNORE INTO sends (id, campaign_id, contact_id, step, message_id, status)
      VALUES (?, ?, ?, ?, ?, 'sent')
    `).run(uid(), campaignId, contactId, step, data.id);

    db.prepare(`
      INSERT INTO events (type, campaign_id, contact_id, step, meta)
      VALUES ('send', ?, ?, ?, ?)
    `).run(campaignId, contactId, step, JSON.stringify({ messageId: data.id }));

    console.log(`[SEND] ✓ ${to} | step ${step} | msg ${data.id}`);
    return res.json({ ok: true, id: data.id });

  } catch (err) {
    console.error("[SEND EXCEPTION]", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ─── PIXEL TRACKING ─────────────────────────────────────────────────────────── */
/**
 * GET /pixel/:campaignId/:contactId/:step.png
 * Registra la apertura del email y programa el siguiente en la secuencia.
 */
app.get("/pixel/:campaignId/:contactId/:stepFile", async (req, res) => {
  // Responder siempre con el pixel (no bloquear la carga del email)
  res.set({
    "Content-Type":  "image/gif",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma":        "no-cache",
  });
  res.send(PIXEL_GIF);

  // Procesar en segundo plano
  const { campaignId, contactId, stepFile } = req.params;
  const step = parseInt(stepFile.replace(".png", ""), 10);
  if (isNaN(step)) return;

  try {
    // Evitar duplicados: solo registrar la primera apertura por envío
    const alreadyOpen = db.prepare(`
      SELECT id FROM opens WHERE campaign_id=? AND contact_id=? AND step=?
    `).get(campaignId, contactId, step);

    if (!alreadyOpen) {
      db.prepare(`
        INSERT INTO opens (id, campaign_id, contact_id, step, ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uid(), campaignId, contactId, step,
        req.ip, req.get("user-agent") || "");

      db.prepare(`
        INSERT INTO events (type, campaign_id, contact_id, step)
        VALUES ('open', ?, ?, ?)
      `).run(campaignId, contactId, step);

      console.log(`[OPEN] Campaign:${campaignId} Contact:${contactId} Step:${step}`);
      await scheduleNextEmail(campaignId, contactId, step);
    }
  } catch (err) {
    console.error("[PIXEL ERROR]", err);
  }
});

/* ─── UNSUBSCRIBE ────────────────────────────────────────────────────────────── */
/**
 * GET /unsub/:contactId
 * Marca el contacto como dado de baja y cancela sus emails en cola.
 */
app.get("/unsub/:contactId", (req, res) => {
  const { contactId } = req.params;
  db.prepare("UPDATE contacts SET status='unsubscribed' WHERE id=?").run(contactId);
  db.prepare("UPDATE automation_queue SET status='cancelled' WHERE contact_id=? AND status='pending'").run(contactId);
  db.prepare("INSERT INTO events (type, contact_id) VALUES ('unsubscribe', ?)").run(contactId);
  console.log(`[UNSUB] Contact:${contactId}`);
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
    <h2 style="color:#5b3fff">Has cancelado tu suscripción</h2>
    <p>Ya no recibirás más correos de nuestra parte.</p>
  </body></html>`);
});

/* ─── RESEND WEBHOOK (rebotes y eventos) ─────────────────────────────────────── */
/**
 * POST /webhooks/resend
 * Recibe eventos de Resend: email.bounced, email.complained, email.delivered
 * Configura esta URL en Resend Dashboard → Webhooks
 */
app.post("/webhooks/resend", (req, res) => {
  // Verificación de firma (opcional pero recomendado)
  const svix_id        = req.headers["svix-id"];
  const svix_timestamp = req.headers["svix-timestamp"];
  const svix_signature = req.headers["svix-signature"];

  if (process.env.WEBHOOK_SECRET) {
    const payload   = JSON.stringify(req.body);
    const toSign    = `${svix_id}.${svix_timestamp}.${payload}`;
    const expected  = crypto.createHmac("sha256", process.env.WEBHOOK_SECRET)
                            .update(toSign).digest("base64");
    const signature = (svix_signature || "").split(" ").find(s => s.startsWith("v1,"))?.slice(3);
    if (!signature || !crypto.timingSafeEqual(
      Buffer.from(signature), Buffer.from(expected)
    )) {
      console.warn("[WEBHOOK] Firma inválida — ignorado");
      return res.status(401).json({ error: "Firma inválida" });
    }
  }

  res.json({ received: true }); // Responder 200 rápido

  const { type, data } = req.body;
  console.log(`[WEBHOOK] ${type}`, data?.email_id);

  // Extraer campaignId y contactId de los headers del email original
  const headers     = data?.headers || {};
  const campaignId  = headers["x-campaign-id"];
  const contactId   = headers["x-contact-id"];
  const toEmail     = data?.to?.[0] || "";

  try {
    if (type === "email.bounced") {
      // Marcar contacto como rebotado
      if (contactId) {
        db.prepare("UPDATE contacts SET status='bounced' WHERE id=?").run(contactId);
        db.prepare("UPDATE automation_queue SET status='cancelled' WHERE contact_id=? AND status='pending'").run(contactId);
      } else {
        db.prepare("UPDATE contacts SET status='bounced' WHERE email=?").run(toEmail);
      }
      db.prepare(`
        INSERT INTO events (type, campaign_id, contact_id, meta)
        VALUES ('bounce', ?, ?, ?)
      `).run(campaignId||null, contactId||null, JSON.stringify({
        reason: data?.bounce?.message || "Hard bounce",
        email: toEmail,
      }));
      console.log(`[BOUNCE] ${toEmail} marcado como rebotado`);
    }

    else if (type === "email.complained") {
      // Queja SPAM → dar de baja inmediatamente
      if (contactId) {
        db.prepare("UPDATE contacts SET status='unsubscribed' WHERE id=?").run(contactId);
        db.prepare("UPDATE automation_queue SET status='cancelled' WHERE contact_id=? AND status='pending'").run(contactId);
      }
      db.prepare(`INSERT INTO events (type, campaign_id, contact_id) VALUES ('unsubscribe', ?, ?)`).run(campaignId||null, contactId||null);
      console.log(`[COMPLAINT] ${toEmail} dado de baja por queja`);
    }

    else if (type === "email.delivered") {
      db.prepare("UPDATE sends SET status='delivered' WHERE message_id=?").run(data?.email_id);
      console.log(`[DELIVERED] ${data?.email_id}`);
    }

    else if (type === "email.clicked") {
      db.prepare(`INSERT INTO events (type, campaign_id, contact_id, meta) VALUES ('click', ?, ?, ?)`).run(
        campaignId||null, contactId||null,
        JSON.stringify({ url: data?.click?.link, email: toEmail })
      );
    }
  } catch (err) {
    console.error("[WEBHOOK PROCESSING ERROR]", err);
  }
});

/* ─── AUTOMATION PROCESSOR ───────────────────────────────────────────────────── */
/**
 * POST /api/automation/process
 * Procesa la cola de emails pendientes cuyo send_after <= NOW
 * Llamar con un cron job cada 15 minutos: */15 * * * * curl -X POST http://localhost:3001/api/automation/process
 */
app.post("/api/automation/process", async (req, res) => {
  const pending = db.prepare(`
    SELECT q.*, c.email, c.name, c.status as contact_status,
           s.subject, s.body_html, s.delay_days
    FROM automation_queue q
    JOIN contacts c ON c.id = q.contact_id
    JOIN sequences s ON s.campaign_id = q.campaign_id AND s.step = q.step
    WHERE q.status = 'pending'
      AND q.send_after <= datetime('now')
      AND c.status = 'subscribed'
    LIMIT 50
  `).all();

  if (pending.length === 0) {
    return res.json({ processed: 0, queued: 0 });
  }

  let processed = 0;
  const errors  = [];

  for (const item of pending) {
    try {
      const pixelUrl       = `${DOMAIN}/pixel/${item.campaign_id}/${item.contact_id}/${item.step}.png`;
      const unsubscribeUrl = `${DOMAIN}/unsub/${item.contact_id}`;
      const html           = item.body_html || buildEmailHtml({
        subject: item.subject, body: item.subject, pixelUrl, unsubscribeUrl
      });

      const { data, error } = await resend.emails.send({
        from:    `${process.env.SENDER_NAME || "MailFlow"} <${process.env.SENDER_EMAIL}>`,
        to:      [item.email],
        subject: item.subject,
        html,
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "X-Campaign-Id":    item.campaign_id,
          "X-Contact-Id":     item.contact_id,
        },
      });

      if (error) {
        errors.push({ id: item.id, error: error.message });
        continue;
      }

      // Marcar como enviado
      db.prepare("UPDATE automation_queue SET status='sent' WHERE id=?").run(item.id);
      db.prepare(`
        INSERT INTO sends (id, campaign_id, contact_id, step, message_id, status)
        VALUES (?, ?, ?, ?, ?, 'sent')
      `).run(uid(), item.campaign_id, item.contact_id, item.step, data.id);

      console.log(`[AUTO-SEND] ✓ ${item.email} step ${item.step}`);
      processed++;

    } catch (err) {
      errors.push({ id: item.id, error: err.message });
      console.error("[AUTO-SEND ERROR]", err.message);
    }
  }

  const stillQueued = db.prepare(
    "SELECT COUNT(*) as n FROM automation_queue WHERE status='pending'"
  ).get().n;

  res.json({ processed, queued: stillQueued, errors });
});

/* ─── STATS API ──────────────────────────────────────────────────────────────── */
/** GET /api/stats/:campaignId */
app.get("/api/stats/:campaignId", (req, res) => {
  const { campaignId } = req.params;
  const sent     = db.prepare("SELECT COUNT(*) as n FROM sends WHERE campaign_id=?").get(campaignId).n;
  const opened   = db.prepare("SELECT COUNT(DISTINCT contact_id) as n FROM opens WHERE campaign_id=?").get(campaignId).n;
  const bounced  = db.prepare("SELECT COUNT(*) as n FROM sends WHERE campaign_id=? AND status='bounced'").get(campaignId).n;
  const byStep   = db.prepare(`
    SELECT step, COUNT(*) as sent,
           (SELECT COUNT(DISTINCT contact_id) FROM opens o WHERE o.campaign_id=s.campaign_id AND o.step=s.step) as opened
    FROM sends s WHERE campaign_id=? GROUP BY step ORDER BY step
  `).all(campaignId);
  res.json({ sent, opened, bounced, byStep });
});

/** GET /api/events */
app.get("/api/events", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM events ORDER BY created_at DESC LIMIT 100"
  ).all();
  res.json(rows);
});

/** GET /api/queue */
app.get("/api/queue", (req, res) => {
  const rows = db.prepare(`
    SELECT q.*, c.email, s.subject
    FROM automation_queue q
    JOIN contacts c ON c.id = q.contact_id
    JOIN sequences s ON s.campaign_id = q.campaign_id AND s.step = q.step
    WHERE q.status = 'pending'
    ORDER BY q.send_after ASC
    LIMIT 100
  `).all();
  res.json(rows);
});

/** GET /api/contacts */
app.get("/api/contacts", (req, res) => {
  res.json(db.prepare("SELECT * FROM contacts ORDER BY created_at DESC").all());
});

/** POST /api/contacts — importar contacto */
app.post("/api/contacts", (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: "Email requerido" });
  const id = uid();
  db.prepare("INSERT OR IGNORE INTO contacts (id, email, name) VALUES (?, ?, ?)").run(id, email, name || "");
  res.json({ ok: true, id });
});

/* ─── START ──────────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`
  ┌──────────────────────────────────────┐
  │  MailFlow Backend                    │
  │  http://localhost:${PORT}                │
  │                                      │
  │  Endpoints:                          │
  │  POST /api/send                      │
  │  GET  /pixel/:cId/:uid/:step.png     │
  │  POST /webhooks/resend               │
  │  POST /api/automation/process        │
  │  GET  /api/stats/:campaignId         │
  │  GET  /api/events                    │
  │  GET  /api/queue                     │
  └──────────────────────────────────────┘
  `);
});
