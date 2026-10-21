/**
 * ============================================
 * VERSANT - ROUTES PAR ÉDITION (L40 lecture, L41 écriture)
 * ============================================
 * /api/leagues/:leagueId/editions/:editionId/…
 *
 * Accès : participant de l'édition connecté (jeton de session), ou admin
 * (mot de passe admin, en attendant les rôles de L43). Les routes du joueur
 * (ses jokers, ses bonus) exigent sa session ; la cible d'un joker ou d'un
 * bonus doit être participante de la même édition.
 *
 * Chaque route délègue à la route historique équivalente, exécutée dans le
 * contexte de l'édition (withEdition) : mêmes réponses, aucune recopie des
 * traitements. Les routes historiques ne changent pas (le front actuel les
 * utilise encore, jusqu'à L50).
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// [chemin sous l'édition, route historique] ; {id} = identifiant de l'édition
// dans les routes historiques, {n} = paramètre :n
const READ_ROUTES = [
  ['/config', '/api/config'],
  ['/participants', '/api/athletes/{id}'],
  ['/activities', '/api/activities/{id}'],
  ['/activities-status', '/api/activities-status/{id}'],
  ['/weather-coverage', '/api/weather-coverage/{id}'],
  ['/frozen-results', '/api/frozen-results'],
  ['/frozen-results/round/:n', '/api/frozen-results/round/{n}'],
  ['/frozen-results/check/:n', '/api/frozen-results/check/{n}'],
  ['/round-configs', '/api/round-configs'],
  ['/special-rules', '/api/special-rules'],
  ['/season-planning', '/api/season-planning'],
  ['/season-bonuses/:n', '/api/season-bonuses/{n}'],
  ['/teams/round/:n', '/api/teams/round/{n}'],
  ['/jokers', '/api/jokers/all'],
  ['/jokers/round/:n', '/api/jokers/round/{n}'],
  ['/bonuses', '/api/bonuses/all'],
  ['/bonuses/active', '/api/bonuses/active']
];

// Routes du joueur (L41) : [méthode, chemin sous l'édition, route historique, cible vérifiée]
const PLAYER_ROUTES = [
  ['get', '/jokers/my', '/api/jokers/my', false],
  ['post', '/jokers/use', '/api/jokers/use', true],
  ['get', '/bonuses/my', '/api/bonuses/my', false],
  ['get', '/bonuses/choices', '/api/bonuses/choices', false],
  ['post', '/bonuses/assign', '/api/bonuses/assign', false],
  ['post', '/bonuses/use', '/api/bonuses/use', true]
];

// Administration de l'édition par l'admin de SA ligue (L43) :
// [méthode, chemin sous l'édition, route historique] ; {id} = édition, {x} = paramètre :x.
// Les routes d'instance (webhooks, tokens, diagnostic, comptes, remises à zéro
// globales) restent réservées au super-admin, sur leurs routes /api/admin/….
const ADMIN_ROUTES = [
  ['post', '/admin/round-configs/:n', '/api/admin/round-configs/{n}'],
  ['delete', '/admin/round-configs/:n', '/api/admin/round-configs/{n}'],
  ['get', '/admin/season-plan', '/api/admin/season-plan'],
  ['get', '/admin/season-planning', '/api/admin/season-planning'],
  ['post', '/admin/season-planning/:n', '/api/admin/season-planning/{n}'],
  ['post', '/admin/season-bonuses/:n', '/api/admin/season-bonuses/{n}'],
  ['get', '/admin/athletes', '/api/admin/athletes/{id}'],
  ['get', '/admin/activities/download', '/api/admin/activities/{id}/download'],
  ['post', '/admin/activities/:activityId/exclude', '/api/admin/activities/{id}/{activityId}/exclude'],
  ['post', '/admin/freeze-round/:n', '/api/admin/freeze-round/{n}'],
  ['post', '/admin/unfreeze-round/:n', '/api/admin/unfreeze-round/{n}'],
  ['post', '/admin/auto-freeze', '/api/admin/auto-freeze'],
  ['post', '/admin/freeze-elim-challenge/:n', '/api/admin/freeze-elim-challenge/{n}'],
  ['post', '/admin/unfreeze-elim-challenge/:n', '/api/admin/unfreeze-elim-challenge/{n}'],
  ['get', '/admin/jokers', '/api/admin/jokers/{id}'],
  ['put', '/admin/jokers/:athleteId', '/api/admin/jokers/{athleteId}'],
  ['post', '/admin/jokers/reset', '/api/admin/jokers/reset/{id}'],
  ['post', '/admin/jokers/resolve/:usageId', '/api/admin/jokers/resolve/{usageId}'],
  ['get', '/admin/bonuses', '/api/admin/bonuses'],
  ['post', '/admin/bonuses/auto-apply/:n', '/api/admin/bonuses/auto-apply/{n}'],
  ['post', '/admin/bonuses/generate-choices', '/api/bonuses/generate-choices'],
  ['post', '/admin/bonuses/apply-effect', '/api/bonuses/apply-effect'],
  ['post', '/admin/sync', '/api/sync/{id}'],
  ['post', '/admin/standings/refresh', '/api/admin/standings/refresh'],
  ['post', '/admin/standings/compute', '/api/admin/standings/compute'],
  ['get', '/admin/ranking/export', '/api/admin/ranking/{id}/export']
];

const BASE = '/api/leagues/:leagueId/editions/:editionId';

/**
 * @param {import('express').Express} app
 * @param {Object} deps
 * @param {Object} deps.store - couche de stockage (store/index.js)
 * @param {Function} deps.validateSession - jeton → id d'athlète ou null
 * @param {Function} deps.isAdminRequest - req → true si mot de passe admin valide
 * @param {Function} deps.isParticipant - (athleteId, edition) → Promise<boolean>
 * @param {Function} deps.withEdition - (contexte, fn) → exécute fn dans le contexte
 * @param {Function} deps.isLeagueAdmin - (req, leagueId) → Promise<booléen> (L43)
 */
function registerEditionRoutes(app, { store, validateSession, isAdminRequest, isParticipant, withEdition, isLeagueAdmin }) {
  /** Identifiants, édition, droit d'accès ; renseigne req.edition et req.editionContext. */
  async function editionAccess(req, res, next) {
    try {
      const { leagueId, editionId } = req.params;
      if (!ID_PATTERN.test(leagueId) || !ID_PATTERN.test(editionId)) {
        return res.status(404).json({ error: 'Édition introuvable' });
      }
      const key = `${leagueId}/${editionId}`;
      const edition = await store.resolveEdition(key);
      if (!edition) return res.status(404).json({ error: 'Édition introuvable' });

      // Session du joueur d'abord ; le mot de passe admin ne sert que de repli
      const token = req.headers.authorization?.replace('Bearer ', '');
      const athleteId = token ? await validateSession(token) : null;
      const admin = isAdminRequest(req);
      if (athleteId) {
        if (!admin && !(await isParticipant(athleteId, edition))) {
          return res.status(403).json({ error: 'Accès réservé aux participants de cette édition' });
        }
        req.athleteId = athleteId;
      } else if (!admin) {
        return res.status(401).json({ error: 'Non authentifié' });
      }

      req.edition = edition;
      req.editionContext = await store.editionContext(key);
      next();
    } catch (error) {
      console.error('Erreur accès édition:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  /** Transmet la requête à la route historique, dans le contexte de l'édition. */
  function delegate(legacy) {
    return (req, res, next) => {
      const id = req.edition.legacyId || `${req.edition.leagueId}/${req.edition.editionId}`;
      const target = legacy
        .replace('{id}', encodeURIComponent(id))
        .replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(req.params[name] ?? ''));
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      req.url = target + query;
      withEdition(req.editionContext, () => app.handle(req, res, next));
    };
  }

  /** Routes du joueur : sa propre session, même si un mot de passe admin est présent. */
  function requirePlayer(req, res, next) {
    if (!req.athleteId) return res.status(401).json({ error: 'Session de joueur requise' });
    next();
  }

  /** Cible d'un joker ou d'un bonus : participante de la même édition. */
  async function requireTargetInEdition(req, res, next) {
    try {
      const targetId = req.body?.target_athlete_id;
      if (targetId != null && targetId !== '' && !(await isParticipant(targetId, req.edition))) {
        return res.status(400).json({ error: 'La cible doit participer à cette édition' });
      }
      next();
    } catch (error) {
      console.error('Erreur vérification de cible:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  /**
   * Admin de la ligue de l'édition (L43). L'accès est accordé côté serveur
   * (req.adminGranted, lu par checkAdmin) ; l'identifiant de ligue ou
   * d'édition éventuellement fourni par la requête est remplacé par celui de
   * l'édition : impossible de viser une autre ligue.
   */
  async function adminAccess(req, res, next) {
    try {
      const { leagueId, editionId } = req.params;
      if (!ID_PATTERN.test(leagueId) || !ID_PATTERN.test(editionId)) return res.status(404).json({ error: 'Édition introuvable' });
      const edition = await store.resolveEdition(`${leagueId}/${editionId}`);
      if (!edition) return res.status(404).json({ error: 'Édition introuvable' });
      if (!(await isLeagueAdmin(req, edition.leagueId))) return res.status(401).json({ error: 'Réservé aux admins de cette ligue' });
      const key = edition.legacyId || `${edition.leagueId}/${edition.editionId}`;
      if (req.body && typeof req.body === 'object') {
        if ('leagueId' in req.body) req.body.leagueId = key;
        if ('edition' in req.body) req.body.edition = key;
      }
      if (req.url.includes('?')) {
        const query = new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1));
        query.delete('leagueId');
        query.delete('edition');
        req.url = req.url.slice(0, req.url.indexOf('?')) + (query.toString() ? `?${query}` : '');
      }
      req.adminGranted = true;
      req.edition = edition;
      req.editionContext = await store.editionContext(key);
      next();
    } catch (error) {
      console.error("Erreur accès admin d'édition:", error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  for (const [route, legacy] of READ_ROUTES) {
    app.get(BASE + route, editionAccess, delegate(legacy));
  }
  for (const [method, route, legacy] of ADMIN_ROUTES) {
    app[method](BASE + route, adminAccess, delegate(legacy));
  }
  for (const [method, route, legacy, checksTarget] of PLAYER_ROUTES) {
    const guards = checksTarget ? [requirePlayer, requireTargetInEdition] : [requirePlayer];
    app[method](BASE + route, editionAccess, ...guards, delegate(legacy));
  }
}

module.exports = { registerEditionRoutes, READ_ROUTES, PLAYER_ROUTES, ADMIN_ROUTES };
