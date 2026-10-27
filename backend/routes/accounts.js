/**
 * ============================================
 * VERSANT - COMPTE ET ADHÉSION À UNE LIGUE (L42)
 * ============================================
 * Décisions du 21/10 : une seule ligue par joueur ; on la rejoint avec son
 * code d'invitation (distinct de l'identifiant de la ligue, régénérable).
 *
 * GET  /api/me (alias /api/auth/me, attendu par login.html)
 * GET  /api/leagues/invite/:code                   nom de la ligue (publique, avant l'inscription)
 * POST /api/leagues/join                           { code }
 * POST /api/leagues/claim-admin                    { code } lien admin (L59)
 * GET  /api/admin/leagues/:leagueId                ligue + code (créé s'il manque)
 * POST /api/admin/leagues/:leagueId/invite-code    nouveau code (l'ancien ne marche plus)
 *
 * Administration : admin de la ligue ou super-admin (rôles, L43), ou mot de
 * passe admin de secours.
 *
 * Ligue sans édition (L59) : le code marche déjà ; les joueurs attendent dans
 * league.json (waiting) et entrent dans la première édition à son lancement.
 * Lien admin (L59) : créé avec la ligue par le super-admin, il fait de son
 * utilisateur l'admin de la ligue ; il ne sert qu'une fois.
 */

const crypto = require('crypto');

// Sans caractères ambigus (0/O, 1/I/L) ; saisi sans casse ni tiret
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function newInviteCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const normalizeCode = code => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Code du lien admin (L59) : 16 caractères, impossible à deviner. */
function newAdminCode() {
  let code = '';
  for (let i = 0; i < 16; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code.match(/.{4}/g).join('-');
}

/**
 * @param {Object} deps
 * @param {Object} deps.store - couche de stockage
 * @param {Function} deps.requireAuth - middleware de session
 * @param {Function} deps.isLeagueAdmin - (req, leagueId) → Promise<booléen> (L43)
 * @param {Function} deps.readAccounts - () → Promise<athletes.json>
 * @param {Function} [deps.onJoin] - (cléÉdition, athleteId) après une adhésion (rattrapage des activités)
 * @param {Function} [deps.isSuperAdmin] - (req) → booléen : super-admin ou mot de passe de secours (L59)
 */
function registerAccountRoutes(app, { store, requireAuth, isLeagueAdmin, readAccounts, onJoin, isSuperAdmin = () => false }) {
  async function requireLeagueAdmin(req, res, leagueId) {
    if (await isLeagueAdmin(req, leagueId)) return true;
    res.status(401).json({ error: 'Réservé aux admins de cette ligue' });
    return false;
  }

  /**
   * Ligue d'un compte (au plus une) ; son édition en cours, c'est-à-dire la
   * plus récente déjà commencée parmi les siennes (sinon la première à venir) ;
   * l'édition suivante qu'il a confirmée sans qu'elle ait commencé (L51) ; et
   * les éditions suivantes qu'il n'a pas encore confirmées (L42c).
   */
  async function membership(athleteId) {
    const [leagueId] = await store.leaguesOf(athleteId);
    if (!leagueId) return { league: null, edition: null, nextEdition: null, editionsToConfirm: [] };
    const league = await store.getLeague(leagueId);
    const editions = await store.listLeagueEditions(leagueId);
    // Ligue en préparation (L59) : inscrit, en attente de la première édition
    if (!editions.length) {
      return {
        league: league ? { id: league.id, name: league.name } : { id: leagueId, name: leagueId },
        edition: null, nextEdition: null, editionsToConfirm: [], waiting: true
      };
    }
    const mine = [];
    for (const edition of editions) {
      const participants = await store.listParticipants(edition.key);
      if (participants.some(p => String(p.id) === String(athleteId))) mine.push(edition);
    }
    const today = new Date().toLocaleDateString('sv-SE'); // AAAA-MM-JJ, heure de Paris (TZ du serveur)
    const started = mine.filter(e => !e.startDate || e.startDate <= today);
    const current = started[started.length - 1] || mine[0] || null;
    const latest = mine[mine.length - 1] || null;
    const latestIndex = latest ? editions.findIndex(e => e.key === latest.key) : -1;
    return {
      league: league ? { id: league.id, name: league.name } : { id: leagueId, name: leagueId },
      edition: current,
      nextEdition: latest && latest !== current ? latest : null,
      editionsToConfirm: editions.slice(latestIndex + 1)
    };
  }

  async function me(req, res) {
    try {
      const accounts = await readAccounts();
      const account = accounts.find(a => String(a.id) === String(req.athleteId));
      if (!account) return res.status(404).json({ error: 'Compte introuvable' });
      const info = await membership(req.athleteId);
      // Ligues qu'il administre (L59) : la sienne, ou une autre s'il a reçu
      // un lien admin alors qu'il jouait déjà ailleurs
      const adminLeagues = [];
      for (const league of await store.listLeagues()) {
        if (!(league.admins || []).map(String).includes(String(account.id))) continue;
        const editions = await store.listLeagueEditions(league.id);
        const today = new Date().toLocaleDateString('sv-SE');
        const started = editions.filter(e => !e.startDate || e.startDate <= today);
        adminLeagues.push({ id: league.id, name: league.name, editionId: (started[started.length - 1] || editions[0])?.editionId || null });
      }
      res.json({
        athlete: { id: account.id, name: account.name, email: account.email },
        ...info,
        adminLeagues,
        // Rôles (L43) : super-admin (SUPER_ADMIN_EMAILS), admin d'une ligue (league.json)
        roles: {
          superAdmin: !!req.isSuperAdmin,
          leagueAdmin: !!req.isSuperAdmin || adminLeagues.length > 0
        }
      });
    } catch (error) {
      console.error('Erreur /api/me:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
  app.get('/api/me', requireAuth, me);
  app.get('/api/auth/me', requireAuth, me);

  /**
   * Vérification d'un code avant l'inscription (L55) : publique, ne renvoie
   * que le nom de la ligue. Essais limités par adresse (30 par 10 minutes)
   * pour qu'on ne puisse pas deviner les codes en masse. Derrière nginx,
   * l'adresse du joueur est dans X-Real-IP / X-Forwarded-For.
   */
  const codeChecks = new Map();
  const CHECK_WINDOW_MS = 10 * 60 * 1000;
  const CHECK_MAX = 30;
  app.get('/api/leagues/invite/:code', async (req, res) => {
    try {
      const client = req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
      const now = Date.now();
      if (codeChecks.size > 10000) codeChecks.clear();
      let entry = codeChecks.get(client);
      if (!entry || now - entry.since > CHECK_WINDOW_MS) {
        entry = { count: 0, since: now };
        codeChecks.set(client, entry);
      }
      if (++entry.count > CHECK_MAX) {
        return res.status(429).json({ error: 'Trop d\'essais : réessaie dans quelques minutes' });
      }

      const code = normalizeCode(req.params.code);
      const league = code.length === 8
        ? (await store.listLeagues()).find(l => l.inviteCode && normalizeCode(l.inviteCode) === code)
        : null;
      if (!league) return res.status(404).json({ error: 'Code d\'invitation inconnu' });
      // Sans édition (L59) : on peut déjà la rejoindre, en attendant la première
      const editions = await store.listLeagueEditions(league.id);
      res.json({ league: { name: league.name }, ...(editions.length ? {} : { waiting: true }) });
    } catch (error) {
      console.error('Erreur vérification du code:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  app.post('/api/leagues/join', requireAuth, async (req, res) => {
    try {
      const code = normalizeCode(req.body?.code);
      if (!code) return res.status(400).json({ error: 'Code d\'invitation manquant' });

      const league = (await store.listLeagues()).find(l => l.inviteCode && normalizeCode(l.inviteCode) === code);
      if (!league) return res.status(404).json({ error: 'Code d\'invitation inconnu' });

      const current = await store.leaguesOf(req.athleteId);
      if (current.includes(league.id)) {
        return res.json({ success: true, alreadyMember: true, league: { id: league.id, name: league.name } });
      }
      if (current.length > 0) {
        return res.status(409).json({ error: 'Tu fais déjà partie d\'une ligue : on ne peut en rejoindre qu\'une' });
      }

      const editions = await store.listLeagueEditions(league.id);
      const edition = editions[editions.length - 1];
      if (!edition) {
        // Ligue en préparation (L59) : en attente, inscrit à la première édition à son lancement
        await store.modifyLeague(league.id, current => {
          current.waiting = current.waiting || [];
          if (!current.waiting.some(w => String(w.id) === String(req.athleteId))) {
            current.waiting.push({ id: String(req.athleteId), joined_at: new Date().toISOString() });
          }
          return current;
        });
        console.log(`🤝 ${req.athleteId} rejoint la ligue ${league.id} (en attente de la première édition)`);
        return res.json({ success: true, waiting: true, league: { id: league.id, name: league.name } });
      }

      await store.addParticipant(edition.key, req.athleteId, new Date().toISOString());
      console.log(`🤝 ${req.athleteId} rejoint la ligue ${league.id} (édition ${edition.editionId})`);
      if (onJoin) onJoin(edition.key, req.athleteId);

      res.json({ success: true, league: { id: league.id, name: league.name }, edition });
    } catch (error) {
      console.error('Erreur adhésion:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /**
   * Devenir admin d'une ligue avec son lien admin (L59). Le lien ne sert
   * qu'une fois : le super-admin en recrée un au besoin.
   */
  app.post('/api/leagues/claim-admin', requireAuth, async (req, res) => {
    try {
      const code = normalizeCode(req.body?.code);
      const league = code.length === 16
        ? (await store.listLeagues()).find(l => l.adminCode && normalizeCode(l.adminCode) === code)
        : null;
      if (!league) return res.status(404).json({ error: 'Lien admin inconnu ou déjà utilisé : demande-en un nouveau' });
      await store.modifyLeague(league.id, current => {
        current.admins = [...new Set([...(current.admins || []).map(String), String(req.athleteId)])];
        delete current.adminCode;
        return current;
      });
      console.log(`🛡️ ${req.athleteId} devient admin de la ligue ${league.id} (lien admin)`);
      res.json({ success: true, league: { id: league.id, name: league.name } });
    } catch (error) {
      console.error('Erreur lien admin:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /**
   * Ligue pour l'admin, avec son code d'invitation (créé à la première
   * demande), les inscrits en attente de la première édition, et les réglages
   * de chaque édition (L59). Le lien admin n'est montré qu'au super-admin.
   */
  app.get('/api/admin/leagues/:leagueId', async (req, res) => {
    try {
      if (!ID_PATTERN.test(req.params.leagueId)) return res.status(404).json({ error: 'Ligue introuvable' });
      if (!(await requireLeagueAdmin(req, res, req.params.leagueId))) return;
      const league = await store.getLeague(req.params.leagueId);
      if (!league) return res.status(404).json({ error: 'Ligue introuvable' });
      if (!league.inviteCode) {
        league.inviteCode = newInviteCode();
        await store.saveLeague(league);
      }
      const accounts = await readAccounts();
      const nameOf = id => accounts.find(a => String(a.id) === String(id))?.name || String(id);
      const editions = [];
      for (const edition of await store.listLeagueEditions(league.id)) {
        const config = (await store.editionContext(edition.key))?.config || {};
        editions.push({
          ...edition,
          settings: {
            roundDurationDays: config.roundDurationDays,
            eliminationsPerRound: config.eliminationsPerRound,
            finalistsCount: config.finalistsCount
          }
        });
      }
      const { adminCode, ...visible } = league;
      res.json({
        league: {
          ...visible,
          ...(isSuperAdmin(req) && adminCode ? { adminCode } : {}),
          waiting: (league.waiting || []).map(w => ({ ...w, name: nameOf(w.id) }))
        },
        editions
      });
    } catch (error) {
      console.error('Erreur ligue admin:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /** Nouveau code d'invitation : l'ancien cesse de fonctionner. */
  app.post('/api/admin/leagues/:leagueId/invite-code', async (req, res) => {
    try {
      if (!ID_PATTERN.test(req.params.leagueId)) return res.status(404).json({ error: 'Ligue introuvable' });
      if (!(await requireLeagueAdmin(req, res, req.params.leagueId))) return;
      const league = await store.getLeague(req.params.leagueId);
      if (!league) return res.status(404).json({ error: 'Ligue introuvable' });
      league.inviteCode = newInviteCode();
      await store.saveLeague(league);
      console.log(`🔑 Nouveau code d'invitation pour la ligue ${league.id}`);
      res.json({ success: true, inviteCode: league.inviteCode });
    } catch (error) {
      console.error('Erreur code d\'invitation:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
}

module.exports = { registerAccountRoutes, newInviteCode, newAdminCode, normalizeCode };
