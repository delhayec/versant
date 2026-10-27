/**
 * ============================================
 * VERSANT - LIGUES ET ÉDITIONS (L42c)
 * ============================================
 * Décisions du 21/10 : seul le super-admin crée une ligue ; l'admin de la
 * ligue lance l'édition suivante (en avance s'il le veut, à la date de début
 * de son choix) ; chaque membre confirme sa participation, et une
 * confirmation tardive fait attendre la saison suivante (règle actuelle :
 * registered_at = date de confirmation).
 *
 * POST /api/admin/leagues                              { name, id? }
 * POST /api/admin/leagues/:leagueId/editions           { editionId, startDate, endDate, … }
 * GET  /api/leagues/:leagueId/editions                 éditions de MA ligue, et ma participation
 * POST /api/leagues/:leagueId/editions/:editionId/confirm
 *
 * Création de ligue et désignation de ses admins : super-admin (ou mot de
 * passe de secours). Lancement d'édition : admin de la ligue (L43).
 *
 * PUT  /api/admin/leagues/:leagueId/admins            { athleteIds } (super-admin)
 * GET  /api/admin/leagues                              toutes les ligues (super-admin, L51)
 *
 * L59 : le super-admin crée la ligue et envoie son lien admin ; l'admin règle
 * le reste.
 * POST /api/admin/leagues/:leagueId/admin-code         nouveau lien admin (super-admin)
 * PUT  /api/admin/leagues/:leagueId/editions/:editionId { startDate, endDate, … }
 *      dates et réglages, tant que l'édition n'a pas commencé (admin de la ligue)
 */

const crypto = require('crypto');
const { newInviteCode, newAdminCode } = require('./accounts');

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Identifiant technique d'une nouvelle ligue : 12 caractères, sans signification. */
function newLeagueId() {
  let id = '';
  for (let i = 0; i < 12; i++) id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return id;
}

const isPositiveInteger = v => Number.isInteger(v) && v > 0;

/**
 * Réglages facultatifs d'une édition (lancement et modification, L59) :
 * écrits dans config. Renvoie le message d'erreur, ou null.
 */
function applyEditionSettings(body, config) {
  for (const key of ['roundDurationDays', 'eliminationsPerRound', 'finalistsCount', 'zeroElevationRuleFromRound']) {
    if (body[key] === undefined) continue;
    if (!isPositiveInteger(body[key])) return `${key} : entier positif attendu`;
    config[key] = body[key];
  }
  if (body.elevationGaugeStartRound !== undefined) {
    if (body.elevationGaugeStartRound !== null && !isPositiveInteger(body.elevationGaugeStartRound)) {
      return 'elevationGaugeStartRound : entier positif ou null attendu';
    }
    config.elevationGaugeStartRound = body.elevationGaugeStartRound;
  }
  return null;
}

/**
 * @param {Object} deps
 * @param {Object} deps.store
 * @param {Function} deps.requireAuth
 * @param {Function} deps.checkAdmin - super-admin ou mot de passe de secours
 * @param {Function} deps.isLeagueAdmin - (req, leagueId) → Promise<booléen> (L43)
 * @param {Function} deps.readAccounts - () → Promise<athletes.json>
 * @param {Function} [deps.onJoin] - (cléÉdition, athleteId) après une confirmation
 */
function registerLeagueRoutes(app, { store, requireAuth, checkAdmin, isLeagueAdmin, readAccounts, onJoin }) {
  /** Admins d'une ligue (L43) : désignés par le super-admin parmi les comptes existants. */
  app.put('/api/admin/leagues/:leagueId/admins', async (req, res) => {
    if (!checkAdmin(req, res)) return;
    try {
      const { leagueId } = req.params;
      const league = ID_PATTERN.test(leagueId) ? await store.getLeague(leagueId) : null;
      if (!league) return res.status(404).json({ error: 'Ligue introuvable' });
      const ids = req.body?.athleteIds;
      if (!Array.isArray(ids)) return res.status(400).json({ error: 'athleteIds (tableau) requis' });
      const accounts = await readAccounts();
      const unknown = ids.filter(id => !accounts.some(a => String(a.id) === String(id)));
      if (unknown.length) return res.status(400).json({ error: `Comptes inconnus : ${unknown.join(', ')}` });
      league.admins = [...new Set(ids.map(String))];
      await store.saveLeague(league);
      console.log(`🛡️ Admins de la ligue ${leagueId} : ${league.admins.join(', ') || '(aucun)'}`);
      res.json({ success: true, admins: league.admins });
    } catch (error) {
      console.error('Erreur admins de ligue:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /**
   * Toutes les ligues, pour le super-admin (L51) : éditions et nombre de
   * participants, édition en cours, membres (participants d'au moins une
   * édition, parmi lesquels on désigne les admins), admins ; et les comptes
   * qui n'ont rejoint aucune ligue.
   */
  app.get('/api/admin/leagues', async (req, res) => {
    if (!checkAdmin(req, res)) return;
    try {
      const accounts = await readAccounts();
      const nameOf = id => accounts.find(a => String(a.id) === String(id))?.name || String(id);
      const today = new Date().toLocaleDateString('sv-SE'); // AAAA-MM-JJ, heure de Paris (TZ du serveur)
      const inSomeLeague = new Set();
      const leagues = [];
      for (const league of await store.listLeagues()) {
        const editions = [];
        const members = new Map();
        for (const edition of await store.listLeagueEditions(league.id)) {
          const participants = await store.listParticipants(edition.key);
          for (const p of participants) {
            members.set(String(p.id), p.name || nameOf(p.id));
            inSomeLeague.add(String(p.id));
          }
          editions.push({ editionId: edition.editionId, startDate: edition.startDate, endDate: edition.endDate, participants: participants.length });
        }
        // Inscrits en attente de la première édition (L59) : déjà membres
        for (const w of league.waiting || []) {
          members.set(String(w.id), nameOf(w.id));
          inSomeLeague.add(String(w.id));
        }
        const started = editions.filter(e => !e.startDate || e.startDate <= today);
        leagues.push({
          id: league.id,
          name: league.name,
          createdAt: league.createdAt || null,
          adminCode: league.adminCode || null,
          waiting: (league.waiting || []).length,
          editions,
          currentEditionId: (started[started.length - 1] || editions[0])?.editionId || null,
          admins: (league.admins || []).map(id => ({ id: String(id), name: nameOf(id) })),
          members: [...members].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
        });
      }
      const withoutLeague = accounts
        .filter(a => !inSomeLeague.has(String(a.id)))
        .map(a => ({ id: String(a.id), name: a.name, email: a.email || null, registeredAt: a.registered_at || null }));
      res.json({ leagues: leagues.sort((a, b) => a.name.localeCompare(b.name)), withoutLeague });
    } catch (error) {
      console.error('Erreur liste des ligues:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /** Création d'une ligue par le super-admin. */
  app.post('/api/admin/leagues', async (req, res) => {
    if (!checkAdmin(req, res)) return;
    try {
      const name = String(req.body?.name || '').trim();
      if (!name || name.length > 80) return res.status(400).json({ error: 'Nom de ligue requis (80 caractères au plus)' });
      const id = req.body?.id ? String(req.body.id) : newLeagueId();
      if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Identifiant de ligue invalide' });
      if (await store.getLeague(id)) return res.status(409).json({ error: 'Cette ligue existe déjà' });
      // Lien admin (L59) : à envoyer au futur admin, qui règle ensuite la ligue
      const league = { id, name, inviteCode: newInviteCode(), adminCode: newAdminCode(), createdAt: new Date().toISOString() };
      await store.saveLeague(league);
      console.log(`🏔️ Ligue créée : ${name} (${id})`);
      res.status(201).json({ league });
    } catch (error) {
      console.error('Erreur création de ligue:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /** Nouveau lien admin (L59) : l'ancien, s'il n'a pas servi, ne marche plus. */
  app.post('/api/admin/leagues/:leagueId/admin-code', async (req, res) => {
    if (!checkAdmin(req, res)) return;
    try {
      const { leagueId } = req.params;
      if (!ID_PATTERN.test(leagueId) || !(await store.getLeague(leagueId))) return res.status(404).json({ error: 'Ligue introuvable' });
      const league = await store.modifyLeague(leagueId, current => ({ ...current, adminCode: newAdminCode() }));
      console.log(`🛡️ Nouveau lien admin pour la ligue ${leagueId}`);
      res.json({ success: true, adminCode: league.adminCode });
    } catch (error) {
      console.error('Erreur lien admin:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /**
   * Dates et réglages d'une édition (L59), par l'admin de la ligue, tant
   * qu'elle n'a pas commencé : ensuite, les changer décalerait des rounds
   * déjà joués. Le nouveau début est au plus tôt demain, pour que les inscrits
   * d'aujourd'hui jouent dès le premier round.
   */
  app.put('/api/admin/leagues/:leagueId/editions/:editionId', async (req, res) => {
    try {
      const { leagueId, editionId } = req.params;
      if (!ID_PATTERN.test(leagueId) || !(await store.getLeague(leagueId))) return res.status(404).json({ error: 'Ligue introuvable' });
      if (!(await isLeagueAdmin(req, leagueId))) return res.status(401).json({ error: 'Réservé aux admins de cette ligue' });
      const edition = (await store.listLeagueEditions(leagueId)).find(e => e.editionId === editionId);
      if (!edition) return res.status(404).json({ error: 'Édition introuvable' });
      if (edition.legacyId) return res.status(409).json({ error: 'Cette édition ne se modifie pas ici' });
      const today = new Date().toLocaleDateString('sv-SE'); // AAAA-MM-JJ, heure de Paris (TZ du serveur)
      if (!edition.startDate || edition.startDate <= today) {
        return res.status(409).json({ error: 'Cette édition a déjà commencé : ses dates et réglages ne changent plus' });
      }

      const body = req.body || {};
      const startDate = body.startDate ?? edition.startDate;
      const endDate = body.endDate ?? edition.endDate;
      if (!DATE_PATTERN.test(String(startDate)) || !DATE_PATTERN.test(String(endDate)) || !(endDate > startDate)) {
        return res.status(400).json({ error: 'Dates au format AAAA-MM-JJ, fin après le début' });
      }
      if (startDate <= today) return res.status(400).json({ error: 'Le début doit être au plus tôt demain' });
      const changes = { yearStartDate: startDate, yearEndDate: endDate };
      const settingsError = applyEditionSettings(body, changes);
      if (settingsError) return res.status(400).json({ error: settingsError });

      await store.updateEditionInfo(edition.key, info => ({
        ...info,
        activities: { ...(info.activities || {}), from: startDate },
        config: { ...(info.config || {}), ...changes },
        updatedAt: new Date().toISOString()
      }));
      console.log(`📅 Édition modifiée : ${leagueId}/${editionId}, du ${startDate} au ${endDate}`);
      res.json({ success: true, edition: { ...edition, startDate, endDate } });
    } catch (error) {
      console.error('Erreur modification d\'édition:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /**
   * Lancement d'une édition par l'admin de la ligue. Les seuils historiques
   * de versant-2026 ne s'appliquent pas : règle 0 D+ dès le round 1, jauge
   * désactivée sauf demande.
   */
  app.post('/api/admin/leagues/:leagueId/editions', async (req, res) => {
    try {
      const { leagueId } = req.params;
      if (!(await isLeagueAdmin(req, leagueId))) return res.status(401).json({ error: 'Réservé aux admins de cette ligue' });
      const body = req.body || {};
      const editionId = String(body.editionId || '');
      if (!ID_PATTERN.test(leagueId) || !(await store.getLeague(leagueId))) return res.status(404).json({ error: 'Ligue introuvable' });
      if (!ID_PATTERN.test(editionId)) return res.status(400).json({ error: 'Identifiant d\'édition invalide (ex. 2027)' });
      if (!DATE_PATTERN.test(String(body.startDate)) || !DATE_PATTERN.test(String(body.endDate)) || !(body.endDate > body.startDate)) {
        return res.status(400).json({ error: 'Dates requises au format AAAA-MM-JJ, fin après le début' });
      }
      const config = {
        yearStartDate: body.startDate,
        yearEndDate: body.endDate,
        zeroElevationRuleFromRound: 1,
        elevationGaugeStartRound: null,
        // Mécanique du rescapé retirée (L44) : jamais pour une nouvelle édition
        rescapeLastSeason: 0
      };
      const settingsError = applyEditionSettings(body, config);
      if (settingsError) return res.status(400).json({ error: settingsError });
      const edition = await store.createEdition(leagueId, editionId, {
        activities: { from: body.startDate, to: null },
        config,
        createdAt: new Date().toISOString()
      });
      console.log(`📅 Édition lancée : ${leagueId}/${editionId}, du ${body.startDate} au ${body.endDate}`);

      // Inscrits en attente (L59) : ils entrent dans cette première édition.
      // Arrivés avant qu'elle existe, ils jouent dès le début : si l'admin a
      // choisi un début déjà passé, leur arrivée est ramenée juste avant.
      const league = await store.getLeague(leagueId);
      const waiting = league.waiting || [];
      if (waiting.length) {
        const [y, m, d] = body.startDate.split('-').map(Number);
        const beforeStart = new Date(new Date(y, m - 1, d).getTime() - 60 * 1000).toISOString();
        for (const w of waiting) {
          const joinedAt = w.joined_at && w.joined_at < beforeStart ? w.joined_at : beforeStart;
          await store.addParticipant(edition.key, w.id, joinedAt);
          if (onJoin) onJoin(edition.key, w.id);
        }
        await store.modifyLeague(leagueId, current => {
          const moved = new Set(waiting.map(w => String(w.id)));
          current.waiting = (current.waiting || []).filter(w => !moved.has(String(w.id)));
          if (!current.waiting.length) delete current.waiting;
          return current;
        });
        console.log(`   ${waiting.length} inscrit(s) en attente ajouté(s) à l'édition`);
      }
      res.status(201).json({ edition: { ...edition, startDate: body.startDate, endDate: body.endDate }, config, participantsAdded: waiting.length });
    } catch (error) {
      if (/existe déjà/.test(error.message)) return res.status(409).json({ error: error.message });
      if (/organisation « editions »/.test(error.message)) return res.status(409).json({ error: error.message });
      console.error('Erreur lancement d\'édition:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /** Membre de la ligue (au plus une ligue par joueur). */
  async function requireMember(req, res) {
    const { leagueId } = req.params;
    if (!ID_PATTERN.test(leagueId) || !(await store.getLeague(leagueId))) {
      res.status(404).json({ error: 'Ligue introuvable' });
      return false;
    }
    if (!(await store.leaguesOf(req.athleteId)).includes(leagueId)) {
      res.status(403).json({ error: 'Réservé aux membres de cette ligue' });
      return false;
    }
    return true;
  }

  /** Éditions de ma ligue, avec ma participation. */
  app.get('/api/leagues/:leagueId/editions', requireAuth, async (req, res) => {
    try {
      if (!(await requireMember(req, res))) return;
      const editions = await store.listLeagueEditions(req.params.leagueId);
      const result = [];
      for (const edition of editions) {
        const participants = await store.listParticipants(edition.key);
        result.push({ ...edition, participating: participants.some(p => String(p.id) === String(req.athleteId)) });
      }
      res.json({ editions: result });
    } catch (error) {
      console.error('Erreur éditions:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /** Confirmation de participation à une édition. */
  app.post('/api/leagues/:leagueId/editions/:editionId/confirm', requireAuth, async (req, res) => {
    try {
      if (!(await requireMember(req, res))) return;
      const { leagueId, editionId } = req.params;
      const edition = (await store.listLeagueEditions(leagueId)).find(e => e.editionId === editionId);
      if (!edition) return res.status(404).json({ error: 'Édition introuvable' });
      const participants = await store.listParticipants(edition.key);
      if (participants.some(p => String(p.id) === String(req.athleteId))) {
        return res.json({ success: true, alreadyConfirmed: true, edition });
      }
      await store.addParticipant(edition.key, req.athleteId, new Date().toISOString());
      console.log(`✅ ${req.athleteId} confirme ${leagueId}/${editionId}`);
      if (onJoin) onJoin(edition.key, req.athleteId);
      res.json({ success: true, edition });
    } catch (error) {
      console.error('Erreur confirmation:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
}

module.exports = { registerLeagueRoutes, newLeagueId };
