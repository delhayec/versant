/**
 * ============================================
 * VERSANT - E-MAILS DU COMPTE (L58, L59)
 * ============================================
 * POST /api/auth/email-code       { email }            code à 6 chiffres (inscription)
 * POST /api/auth/forgot-password  { email }            lien de réinitialisation
 * POST /api/auth/reset-password   { token, password }  nouveau mot de passe
 *
 * Codes d'inscription : en mémoire (perdus au redémarrage : il suffit d'en
 * redemander un), valables 15 minutes, 5 essais. Liens de réinitialisation :
 * empreinte SHA-256 du jeton dans athletes.json (reset_token, reset_expires),
 * valables 1 heure, à usage unique.
 */

const crypto = require('crypto');
const { mailEnabled, sendMail } = require('../mailer');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const RESEND_DELAY_MS = 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const normalizeEmail = email => String(email || '').trim().toLowerCase();

/** Adresse du joueur : derrière nginx, dans X-Real-IP / X-Forwarded-For. */
function clientAddress(req) {
  return req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
}

/** Compteur par clé sur une fenêtre glissante simple ; vrai si la limite est dépassée. */
function createLimiter(windowMs, max) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    if (hits.size > 10000) hits.clear();
    let entry = hits.get(key);
    if (!entry || now - entry.since > windowMs) {
      entry = { count: 0, since: now };
      hits.set(key, entry);
    }
    return ++entry.count > max;
  };
}

/**
 * @param {Object} deps
 * @param {Function} deps.readAccounts - () → Promise<athletes.json>
 * @param {Function} deps.modifyAccounts - (fn(comptes) → comptes) → Promise
 * @param {Function} deps.setPassword - (compte, motDePasse, empreinteDuLien) → Promise<booléen> :
 *   écrit les deux hash et efface le lien, si le compte a toujours ce lien
 * @param {Function} deps.createSession - (athleteId) → Promise<jeton>
 * @param {Function} deps.dropSessions - (athleteId) → Promise, ferme ses sessions
 * @returns {{ checkEmailCode: Function, consumeEmailCode: Function }}
 */
function registerMailAuthRoutes(app, { readAccounts, modifyAccounts, setPassword, createSession, dropSessions }) {
  const publicUrl = () => String(process.env.PUBLIC_URL || 'https://versant-app.fr').replace(/\/+$/, '');
  const ipLimit = createLimiter(60 * 60 * 1000, 20);       // 20 envois par heure et par adresse
  const emailLimit = createLimiter(60 * 60 * 1000, 5);     // 5 envois par heure et par e-mail

  // ----- Code de validation à l'inscription -----
  const codes = new Map(); // e-mail → { hash, expires, attempts, sentAt }

  app.post('/api/auth/email-code', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      if (!EMAIL_PATTERN.test(email)) return res.status(400).json({ error: 'Format d\'e-mail invalide' });
      if (!mailEnabled()) return res.status(503).json({ error: 'L\'envoi d\'e-mails est indisponible pour le moment' });

      const accounts = await readAccounts();
      if (accounts.some(a => normalizeEmail(a.email) === email)) {
        return res.status(409).json({ error: 'Cet e-mail a déjà un compte : connecte-toi, ou utilise « Mot de passe oublié »' });
      }

      const previous = codes.get(email);
      if (previous && Date.now() - previous.sentAt < RESEND_DELAY_MS) {
        return res.status(429).json({ error: 'Un code vient d\'être envoyé : attends une minute avant d\'en redemander un' });
      }
      if (ipLimit(clientAddress(req)) || emailLimit(email)) {
        return res.status(429).json({ error: 'Trop de demandes : réessaie plus tard' });
      }

      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      if (codes.size > 10000) codes.clear();
      codes.set(email, { hash: sha256(code), expires: Date.now() + CODE_TTL_MS, attempts: 0, sentAt: Date.now() });

      await sendMail({
        to: email,
        subject: `${code} : ton code Versant`,
        title: 'Valide ton adresse e-mail',
        lines: ['Voici ton code pour terminer ton inscription sur Versant :'],
        code,
        footer: 'Il est valable 15 minutes. Si tu n\'as rien demandé, ignore cet e-mail.'
      });
      console.log(`Code d'inscription envoyé à ${email}`);
      res.json({ success: true });
    } catch (error) {
      console.error('Erreur envoi du code:', error.message);
      codes.delete(normalizeEmail(req.body?.email));
      res.status(502).json({ error: 'L\'e-mail n\'a pas pu être envoyé : réessaie dans un instant' });
    }
  });

  /** Vérifie le code d'un e-mail (compte un essai). → null si bon, sinon le message d'erreur. */
  function checkEmailCode(email, code) {
    const key = normalizeEmail(email);
    const entry = codes.get(key);
    if (!entry || entry.expires < Date.now()) {
      codes.delete(key);
      return 'Code expiré : demande un nouveau code';
    }
    if (++entry.attempts > CODE_MAX_ATTEMPTS) {
      codes.delete(key);
      return 'Trop d\'essais : demande un nouveau code';
    }
    const given = Buffer.from(sha256(String(code || '').replace(/\D/g, '')));
    if (!crypto.timingSafeEqual(given, Buffer.from(entry.hash))) return 'Code de validation incorrect';
    return null;
  }

  /** Le code a servi (compte créé) : il ne vaut plus rien. */
  function consumeEmailCode(email) {
    codes.delete(normalizeEmail(email));
  }

  // ----- Mot de passe oublié -----
  const SAME_ANSWER = { success: true, message: 'Si un compte existe avec cet e-mail, un lien vient de lui être envoyé.' };

  app.post('/api/auth/forgot-password', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      if (!EMAIL_PATTERN.test(email)) return res.status(400).json({ error: 'Format d\'e-mail invalide' });
      if (!mailEnabled()) return res.status(503).json({ error: 'L\'envoi d\'e-mails est indisponible pour le moment' });
      if (ipLimit(clientAddress(req)) || emailLimit(email)) {
        return res.status(429).json({ error: 'Trop de demandes : réessaie plus tard' });
      }

      // Même réponse que le compte existe ou non : on ne révèle pas qui est inscrit
      const account = (await readAccounts()).find(a => normalizeEmail(a.email) === email);
      if (!account) return res.json(SAME_ANSWER);

      const token = crypto.randomBytes(32).toString('hex');
      await modifyAccounts(accounts => {
        const current = accounts.find(a => String(a.id) === String(account.id));
        if (current) {
          current.reset_token = sha256(token);
          current.reset_expires = new Date(Date.now() + RESET_TTL_MS).toISOString();
        }
        return accounts;
      });

      await sendMail({
        to: account.email,
        subject: 'Versant : réinitialise ton mot de passe',
        title: 'Mot de passe oublié ?',
        lines: [`Bonjour ${account.name || ''},`.replace(' ,', ','), 'Clique sur le bouton pour choisir un nouveau mot de passe :'],
        button: { label: 'Choisir un nouveau mot de passe', url: `${publicUrl()}/login.html#reset=${token}` },
        footer: 'Ce lien est valable 1 heure et ne sert qu\'une fois. Si tu n\'as rien demandé, ignore cet e-mail : ton mot de passe ne change pas.'
      });
      console.log(`Lien de réinitialisation envoyé à ${account.name} (${account.id})`);
      res.json(SAME_ANSWER);
    } catch (error) {
      console.error('Erreur mot de passe oublié:', error.message);
      res.status(502).json({ error: 'L\'e-mail n\'a pas pu être envoyé : réessaie dans un instant' });
    }
  });

  app.post('/api/auth/reset-password', async (req, res) => {
    try {
      const token = String(req.body?.token || '');
      const password = String(req.body?.password || '');
      if (!/^[0-9a-f]{64}$/.test(token)) return res.status(400).json({ error: 'Lien invalide' });
      if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });

      const hash = sha256(token);
      const account = (await readAccounts()).find(a => a.reset_token === hash);
      if (!account || !account.reset_expires || new Date(account.reset_expires) < new Date()) {
        return res.status(400).json({ error: 'Ce lien a expiré ou a déjà servi : refais une demande' });
      }

      // Faux si le lien a servi entre-temps (deux clics simultanés)
      if (!(await setPassword(account, password, hash))) {
        return res.status(400).json({ error: 'Ce lien a expiré ou a déjà servi : refais une demande' });
      }
      await dropSessions(account.id);
      const session = await createSession(account.id);
      console.log(`Mot de passe réinitialisé par e-mail : ${account.name} (${account.id})`);
      res.json({ success: true, token: session, athlete: { id: account.id, name: account.name } });
    } catch (error) {
      console.error('Erreur réinitialisation:', error.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  return { checkEmailCode, consumeEmailCode };
}

module.exports = { registerMailAuthRoutes };
