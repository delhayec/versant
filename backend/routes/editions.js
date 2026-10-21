/**
 * ============================================
 * VERSANT - ROUTES PAR ÉDITION (L40, lecture)
 * ============================================
 * /api/leagues/:leagueId/editions/:editionId/…
 *
 * Accès : participant de l'édition connecté (jeton de session), ou admin
 * (mot de passe admin, en attendant les rôles de L43).
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

const BASE = '/api/leagues/:leagueId/editions/:editionId';

/**
 * @param {import('express').Express} app
 * @param {Object} deps
 * @param {Object} deps.store - couche de stockage (store/index.js)
 * @param {Function} deps.validateSession - jeton → id d'athlète ou null
 * @param {Function} deps.isAdminRequest - req → true si mot de passe admin valide
 * @param {Function} deps.isParticipant - (athleteId, edition) → Promise<boolean>
 * @param {Function} deps.withEdition - (contexte, fn) → exécute fn dans le contexte
 */
function registerEditionRoutes(app, { store, validateSession, isAdminRequest, isParticipant, withEdition }) {
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

      if (!isAdminRequest(req)) {
        const token = req.headers.authorization?.replace('Bearer ', '');
        const athleteId = await validateSession(token);
        if (!athleteId) return res.status(401).json({ error: 'Non authentifié' });
        if (!(await isParticipant(athleteId, edition))) {
          return res.status(403).json({ error: 'Accès réservé aux participants de cette édition' });
        }
        req.athleteId = athleteId;
      }

      req.edition = edition;
      req.editionContext = await store.editionContext(key);
      next();
    } catch (error) {
      console.error('Erreur accès édition:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  for (const [route, legacy] of READ_ROUTES) {
    app.get(BASE + route, editionAccess, (req, res, next) => {
      const id = req.edition.legacyId || `${req.edition.leagueId}/${req.edition.editionId}`;
      const target = legacy
        .replace('{id}', encodeURIComponent(id))
        .replace('{n}', encodeURIComponent(req.params.n ?? ''));
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      req.url = target + query;
      withEdition(req.editionContext, () => app.handle(req, res, next));
    });
  }
}

module.exports = { registerEditionRoutes, READ_ROUTES };
