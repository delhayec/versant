/**
 * ============================================
 * VERSANT - COMPTE ET ADHÉSION À UNE LIGUE (L42)
 * ============================================
 * Décisions du 21/10 : une seule ligue par joueur ; on la rejoint avec son
 * code d'invitation (distinct de l'identifiant de la ligue, régénérable).
 *
 * GET  /api/me (alias /api/auth/me, attendu par login.html)
 * POST /api/leagues/join                           { code }
 * GET  /api/admin/leagues/:leagueId                ligue + code (créé s'il manque)
 * POST /api/admin/leagues/:leagueId/invite-code    nouveau code (l'ancien ne marche plus)
 *
 * Administration : admin de la ligue ou super-admin (rôles, L43), ou mot de
 * passe admin de secours.
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

/**
 * @param {Object} deps
 * @param {Object} deps.store - couche de stockage
 * @param {Function} deps.requireAuth - middleware de session
 * @param {Function} deps.isLeagueAdmin - (req, leagueId) → Promise<booléen> (L43)
 * @param {Function} deps.readAccounts - () → Promise<athletes.json>
 * @param {Function} [deps.onJoin] - (cléÉdition, athleteId) après une adhésion (rattrapage des activités)
 */
function registerAccountRoutes(app, { store, requireAuth, isLeagueAdmin, readAccounts, onJoin }) {
  async function requireLeagueAdmin(req, res, leagueId) {
    if (await isLeagueAdmin(req, leagueId)) return true;
    res.status(401).json({ error: 'Réservé aux admins de cette ligue' });
    return false;
  }

  /**
   * Ligue d'un compte (au plus une), sa dernière édition jouée, et les
   * éditions suivantes qu'il n'a pas encore confirmées (L42c).
   */
  async function membership(athleteId) {
    const [leagueId] = await store.leaguesOf(athleteId);
    if (!leagueId) return { league: null, edition: null, editionsToConfirm: [] };
    const league = await store.getLeague(leagueId);
    const editions = await store.listLeagueEditions(leagueId);
    const mine = [];
    for (const edition of editions) {
      const participants = await store.listParticipants(edition.key);
      if (participants.some(p => String(p.id) === String(athleteId))) mine.push(edition);
    }
    const current = mine[mine.length - 1] || null;
    const currentIndex = current ? editions.findIndex(e => e.key === current.key) : -1;
    return {
      league: league ? { id: league.id, name: league.name } : { id: leagueId, name: leagueId },
      edition: current,
      editionsToConfirm: editions.slice(currentIndex + 1)
    };
  }

  async function me(req, res) {
    try {
      const accounts = await readAccounts();
      const account = accounts.find(a => String(a.id) === String(req.athleteId));
      if (!account) return res.status(404).json({ error: 'Compte introuvable' });
      const info = await membership(req.athleteId);
      const league = info.league ? await store.getLeague(info.league.id) : null;
      res.json({
        athlete: { id: account.id, name: account.name, email: account.email },
        ...info,
        // Rôles (L43) : super-admin (SUPER_ADMIN_EMAILS), admin de sa ligue (league.json)
        roles: {
          superAdmin: !!req.isSuperAdmin,
          leagueAdmin: !!req.isSuperAdmin || (league?.admins || []).map(String).includes(String(account.id))
        }
      });
    } catch (error) {
      console.error('Erreur /api/me:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
  app.get('/api/me', requireAuth, me);
  app.get('/api/auth/me', requireAuth, me);

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
      if (!edition) return res.status(409).json({ error: 'Cette ligue n\'a pas encore d\'édition' });

      await store.addParticipant(edition.key, req.athleteId, new Date().toISOString());
      console.log(`🤝 ${req.athleteId} rejoint la ligue ${league.id} (édition ${edition.editionId})`);
      if (onJoin) onJoin(edition.key, req.athleteId);

      res.json({ success: true, league: { id: league.id, name: league.name }, edition });
    } catch (error) {
      console.error('Erreur adhésion:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /** Ligue pour l'admin, avec son code d'invitation (créé à la première demande). */
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
      res.json({ league, editions: await store.listLeagueEditions(league.id) });
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

module.exports = { registerAccountRoutes, newInviteCode, normalizeCode };
