/**
 * ============================================
 * VERSANT - ENVOI D'E-MAILS (L57)
 * ============================================
 * Envoi par SMTP (Brevo en production), réglé dans le .env :
 *   SMTP_HOST, SMTP_PORT (587 : STARTTLS), SMTP_USER, SMTP_PASS,
 *   MAIL_FROM  « Versant-app <noreply@versant-app.fr> »
 * SMTP_INSECURE=1 coupe TLS : réservé aux tests avec un faux serveur local.
 *
 * Sans SMTP_HOST, l'envoi échoue proprement (mailEnabled() → false) : les
 * routes qui en dépendent répondent 503 au lieu de planter.
 */

// Chargé à la demande : si la dépendance manque (npm install oublié au
// déploiement), seul l'envoi d'e-mails est coupé, pas le serveur entier.
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (error) {
  console.error('nodemailer absent (npm install dans backend/) : envoi d\'e-mails désactivé');
}

let transport = null;

function mailEnabled() {
  return !!(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT) || 587;
    const insecure = process.env.SMTP_INSECURE === '1';
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      requireTLS: !insecure && port !== 465,
      ignoreTLS: insecure,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000
    });
  }
  return transport;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Habillage commun : un titre, des paragraphes, et au choix un code en gros
 * caractères ou un bouton. Le texte brut est toujours fourni (anti-spam).
 * @param {Object} content - { title, lines: [string], code?, button?: { label, url }, footer? }
 */
function layout({ title, lines = [], code, button, footer }) {
  const text = [
    title, '',
    ...lines,
    ...(code ? ['', code, ''] : []),
    ...(button ? ['', `${button.label} : ${button.url}`, ''] : []),
    ...(footer ? ['', footer] : []),
    '', '— Versant · versant-app.fr'
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;color:#1a1a24;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#0a0a0f;padding:20px 28px;color:#ffffff;font-size:20px;font-weight:bold;">Versant</td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 16px;font-size:20px;">${escapeHtml(title)}</h1>
          ${lines.map(l => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${escapeHtml(l)}</p>`).join('\n          ')}
          ${code ? `<p style="margin:24px 0;text-align:center;font-family:'Courier New',monospace;font-size:34px;letter-spacing:8px;font-weight:bold;color:#f97316;">${escapeHtml(code)}</p>` : ''}
          ${button ? `<p style="margin:24px 0;text-align:center;"><a href="${escapeHtml(button.url)}" style="display:inline-block;background:#f97316;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 28px;border-radius:8px;">${escapeHtml(button.label)}</a></p>
          <p style="margin:0 0 12px;font-size:12px;color:#6b6b80;word-break:break-all;">Si le bouton ne marche pas, copie ce lien : ${escapeHtml(button.url)}</p>` : ''}
          ${footer ? `<p style="margin:16px 0 0;font-size:13px;color:#6b6b80;">${escapeHtml(footer)}</p>` : ''}
        </td></tr>
        <tr><td style="padding:16px 28px;background:#fafafa;font-size:12px;color:#9a9aab;">Versant · <a href="https://versant-app.fr" style="color:#9a9aab;">versant-app.fr</a></td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { text, html };
}

/**
 * Envoie un e-mail. Lève une erreur si l'envoi échoue ou n'est pas configuré.
 * @returns {Promise<Object>} réponse du serveur SMTP (messageId…)
 */
async function sendMail({ to, subject, ...content }) {
  if (!mailEnabled()) throw new Error('Envoi d\'e-mails non configuré (SMTP_HOST, SMTP_USER, SMTP_PASS)');
  const { text, html } = layout(content);
  return getTransport().sendMail({
    from: process.env.MAIL_FROM || 'Versant <noreply@versant-app.fr>',
    to,
    subject,
    text,
    html
  });
}

module.exports = { mailEnabled, sendMail, layout };
