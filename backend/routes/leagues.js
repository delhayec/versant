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
 * Administration par le mot de passe admin en attendant les rôles (L43).
 */

const crypto = require('crypto');
const { newInviteCode } = require('./accounts');

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
 * @param {Object} deps
 * @param {Object} deps.store
 * @param {Function} deps.requireAuth
 * @param {Function} deps.checkAdmin
 * @param {Function} [deps.onJoin] - (cléÉdition, athleteId) après une confirmation
 */
function registerLeagueRoutes(app, { store, requireAuth, checkAdmin, onJoin }) {
  /** Création d'une ligue par le super-admin. */
  app.post('/api/admin/leagues', async (req, res) => {
    if (!checkAdmin(req, res)) return;
    try {
      const name = String(req.body?.name || '').trim();
      if (!name || name.length > 80) return res.status(400).json({ error: 'Nom de ligue requis (80 caractères au plus)' });
      const id = req.body?.id ? String(req.body.id) : newLeagueId();
      if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Identifiant de ligue invalide' });
      if (await store.getLeague(id)) return res.status(409).json({ error: 'Cette ligue existe déjà' });
      const league = { id, name, inviteCode: newInviteCode(), createdAt: new Date().toISOString() };
      await store.saveLeague(league);
      console.log(`🏔️ Ligue créée : ${name} (${id})`);
      res.status(201).json({ league });
    } catch (error) {
      console.error('Erreur création de ligue:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /**
   * Lancement d'une édition par l'admin de la ligue. Les seuils historiques
   * de versant-2026 ne s'appliquent pas : règle 0 D+ dès le round 1, jauge
   * désactivée sauf demande.
   */
  app.post('/api/admin/leagues/:leagueId/editions', async (req, res) => {
    if (!checkAdmin(req, res)) return;
    try {
      const { leagueId } = req.params;
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
        elevationGaugeStartRound: null
      };
      for (const key of ['roundDurationDays', 'eliminationsPerRound', 'finalistsCount', 'zeroElevationRuleFromRound']) {
        if (body[key] === undefined) continue;
        if (!isPositiveInteger(body[key])) return res.status(400).json({ error: `${key} : entier positif attendu` });
        config[key] = body[key];
      }
      if (body.elevationGaugeStartRound !== undefined) {
        if (body.elevationGaugeStartRound !== null && !isPositiveInteger(body.elevationGaugeStartRound)) {
          return res.status(400).json({ error: 'elevationGaugeStartRound : entier positif ou null attendu' });
        }
        config.elevationGaugeStartRound = body.elevationGaugeStartRound;
      }
      const edition = await store.createEdition(leagueId, editionId, {
        activities: { from: body.startDate, to: null },
        config,
        createdAt: new Date().toISOString()
      });
      console.log(`📅 Édition lancée : ${leagueId}/${editionId}, du ${body.startDate} au ${body.endDate}`);
      res.status(201).json({ edition: { ...edition, startDate: body.startDate, endDate: body.endDate }, config });
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
