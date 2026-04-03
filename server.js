/**
 * MailFlow Backend — server.js
 * Stack: Node.js + Express + Resend SDK
 * Almacenamiento: en memoria (no requiere SQLite ni compilación nativa)
 *
 * Instalar: npm install express resend cors dotenv
 *
 * Variables en Railway → Variables:
 *   RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
 *   SENDER_EMAIL=hola@tudominio.com
 *   SENDER_NAME=Tu Empresa
 *   TRACKING_DOMAIN=https://tu-proyecto.railway.app
 */

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const { Resend } = require("resend");
const crypto     = require("crypto");

const app    = express();
const resend = new Resend(process.env.RESEND_API_KEY);
const PORT   = process.env.PORT || 3001;
const DOMAIN = process.env.TRACKING_DOMAIN || `https://localhost:${PORT}`;

/* ── CORS: permite peticiones desde cualquier origen ── */
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.options("*", cors());
app.use(express.json({ limit: "10mb" }));

/* ── Almacenamiento en memoria ── */
const db = {
  sends:  [],   // { id, campaignId, contactId, step, messageId, to, sentAt }
  opens:  [],   // { id, campaignId, contactId, step, openedAt, ip }
  events: [],   // { id, type, campaignId, contactId, step, meta, createdAt }
  queue:  [],   // { id, campaignId, contactId, email, step, sendAfter, status }
  contacts: [], // { id, email, status }
};

const uid = () => crypto.randomBytes(8).toString("hex");
const now = () => new Date().toISOString();

/* ── Pixel GIF 1×1 transparente ── */
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/* ── HTML del email ── */
function buildHtml(subject, body, pixelUrl, unsubUrl, btnLabel, btnUrl) {
  /* Convertir saltos de línea dobles en párrafos separados */
  const paragraphs = (body||"").split(/\n\n+/).map(p=>p.replace(/\n/g,"<br/>")).filter(Boolean);
  const bodyHtml = paragraphs.map(p=>`<p style="margin:0 0 16px;line-height:1.8;font-size:15px;color:#333">${p}</p>`).join("");
  /* Botón opcional */
  const btnHtml = (btnLabel && btnUrl)
    ? `<div style="margin:28px 0"><a href="${btnUrl}" style="display:inline-block;padding:13px 32px;background:#5b3fff;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;font-family:sans-serif">${btnLabel}</a></div>`
    : "";
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:600px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden">
    <div style="background:#5b3fff;padding:32px;text-align:center">
      <h1 style="margin:0;color:#fff;font-size:24px;font-weight:700">${subject}</h1>
    </div>
    <div style="padding:32px 36px">
      ${bodyHtml}
      ${btnHtml}
    </div>
    <div style="background:#f8f8f8;padding:20px 36px;border-top:1px solid #eee;text-align:center">
      <p style="margin:0;font-size:11px;color:#999">
        <a href="${unsubUrl}" style="color:#aaa;text-decoration:underline">Cancelar suscripción</a>
      </p>
    </div>
  </div>
  <img src="${pixelUrl}" width="1" height="1" style="display:block;opacity:0;border:0" alt=""/>
</body>
</html>`;
}
}

/* ═══════════════════════════════════════════════════
   ENDPOINTS
═══════════════════════════════════════════════════ */

/* ── GET /api/test — verificar que el backend funciona ── */
app.get("/api/test", (req, res) => {
  const hasKey    = !!(process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.startsWith("re_"));
  const hasEmail  = !!(process.env.SENDER_EMAIL   && process.env.SENDER_EMAIL.includes("@"));
  res.json({
    ok:   true,
    status: "MailFlow backend activo ✓",
    resend_configured:        hasKey,
    sender_email_configured:  hasEmail,
    sender_email:  process.env.SENDER_EMAIL  || "(no configurado — agrega SENDER_EMAIL en Railway)",
    sender_name:   process.env.SENDER_NAME   || "(no configurado — agrega SENDER_NAME en Railway)",
    tracking_domain: DOMAIN,
    timestamp: now(),
  });
});

/* ── POST /api/send — enviar email ── */
app.post("/api/send", async (req, res) => {
  const { to, subject, html, bodyHtml, bodyText, campaignId, contactId, step = 1 } = req.body;

  /* Resolver remitente */
  const fromEmail = (req.body.from && req.body.from.includes("@"))
    ? req.body.from
    : process.env.SENDER_EMAIL;
  const fromName  = req.body.fromName || process.env.SENDER_NAME || "MailFlow";

  /* Validaciones */
  if (!to || !to.includes("@"))
    return res.status(400).json({ ok: false, error: "Email destinatario inválido." });
  if (!subject)
    return res.status(400).json({ ok: false, error: "Falta el asunto del email." });
  if (!fromEmail)
    return res.status(400).json({ ok: false, error: "No hay email remitente. Agrega SENDER_EMAIL en Railway → Variables." });
  if (!process.env.RESEND_API_KEY)
    return res.status(400).json({ ok: false, error: "RESEND_API_KEY no configurada en Railway → Variables." });

  /* Construir HTML */
  const pixelUrl = `${DOMAIN}/pixel/${campaignId||"c0"}/${contactId||"u0"}/${step}.png`;
  const unsubUrl = `${DOMAIN}/unsub/${contactId||"u0"}`;
  const finalHtml = html || bodyHtml || buildHtml(
    subject,
    bodyText || "",
    pixelUrl,
    unsubUrl,
    req.body.btnLabel || "",
    req.body.btnUrl   || ""
  );

  try {
    const { data, error } = await resend.emails.send({
      from:    `${fromName} <${fromEmail}>`,
      to:      [to],
      subject,
      html:    finalHtml,
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "X-Campaign-Id":    String(campaignId || ""),
        "X-Contact-Id":     String(contactId  || ""),
      },
    });

    if (error) {
      console.error("[RESEND ERROR]", error);
      return res.json({ ok: false, error: error.message || JSON.stringify(error) });
    }

    /* Guardar en memoria */
    db.sends.push({ id: uid(), campaignId, contactId, step, messageId: data.id, to, sentAt: now() });
    db.events.push({ id: uid(), type: "send", campaignId, contactId, step, meta: { messageId: data.id }, createdAt: now() });

    console.log(`[SEND ✓] ${to} | "${subject}" | msg ${data.id}`);
    return res.json({ ok: true, id: data.id });

  } catch (err) {
    console.error("[SEND ERROR]", err.message);
    return res.status(500).json({ ok: false, error: err.message || "Error interno del servidor." });
  }
});

/* ── GET /pixel/:cId/:uid/:step.png — rastreo de apertura ── */
app.get("/pixel/:cId/:uid/:step", (req, res) => {
  res.set({ "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache" });
  res.send(PIXEL);

  /* Registrar apertura en segundo plano */
  const { cId, uid: contactId, step } = req.params;
  const stepNum = parseInt(step.replace(".png",""), 10) || 1;
  const alreadyOpen = db.opens.find(o => o.campaignId===cId && o.contactId===contactId && o.step===stepNum);

  if (!alreadyOpen) {
    db.opens.push({ id: uid(), campaignId: cId, contactId, step: stepNum, openedAt: now(), ip: req.ip });
    db.events.push({ id: uid(), type: "open", campaignId: cId, contactId, step: stepNum, createdAt: now() });
    console.log(`[OPEN] Campaign:${cId} Contact:${contactId} Step:${stepNum}`);

    /* Encolar siguiente email si aplica (notificación) */
    db.queue.push({
      id: uid(), campaignId: cId, contactId, step: stepNum + 1,
      sendAfter: new Date(Date.now() + 86400000).toISOString(),
      status: "pending", createdAt: now()
    });
  }
});

/* ── GET /unsub/:contactId — cancelar suscripción ── */
app.get("/unsub/:contactId", (req, res) => {
  const { contactId } = req.params;
  db.events.push({ id: uid(), type: "unsubscribe", contactId, createdAt: now() });
  console.log(`[UNSUB] ${contactId}`);
  res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;color:#222">
    <h2 style="color:#5b3fff">Suscripción cancelada</h2>
    <p>Ya no recibirás más correos de nuestra parte.</p>
  </body></html>`);
});

/* ── POST /webhooks/resend — rebotes y quejas automáticas ── */
app.post("/webhooks/resend", (req, res) => {
  res.json({ received: true });
  const { type, data } = req.body || {};
  if (!type) return;

  const toEmail = (data && data.to && data.to[0]) || "";
  console.log(`[WEBHOOK] ${type} → ${toEmail}`);

  if (type === "email.bounced") {
    db.events.push({ id: uid(), type: "bounce", meta: { email: toEmail, reason: "Hard bounce" }, createdAt: now() });
    /* Marcar en memoria */
    const c = db.contacts.find(x => x.email === toEmail);
    if (c) c.status = "bounced";
    else db.contacts.push({ id: uid(), email: toEmail, status: "bounced" });
  }
  if (type === "email.complained") {
    db.events.push({ id: uid(), type: "unsubscribe", meta: { email: toEmail }, createdAt: now() });
  }
  if (type === "email.clicked") {
    db.events.push({ id: uid(), type: "click", meta: { email: toEmail, url: data?.click?.link }, createdAt: now() });
  }
});

/* ── GET /api/events — últimos eventos ── */
app.get("/api/events", (req, res) => {
  res.json([...db.events].reverse().slice(0, 100));
});

/* ── GET /api/queue — cola de automatización ── */
app.get("/api/queue", (req, res) => {
  res.json(db.queue.filter(q => q.status === "pending"));
});

/* ── GET /api/stats — resumen ── */
app.get("/api/stats", (req, res) => {
  res.json({
    totalSent:   db.sends.length,
    totalOpens:  db.opens.length,
    totalEvents: db.events.length,
    queueSize:   db.queue.filter(q=>q.status==="pending").length,
  });
});

/* ── Arrancar servidor ── */
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║  MailFlow Backend — Puerto ${PORT}      ║
║                                      ║
║  GET  /api/test                      ║
║  POST /api/send                      ║
║  GET  /pixel/:cId/:uid/:step.png     ║
║  GET  /unsub/:contactId              ║
║  POST /webhooks/resend               ║
║  GET  /api/events                    ║
╚══════════════════════════════════════╝
  `);
});
