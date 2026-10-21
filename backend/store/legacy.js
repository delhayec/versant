/**
 * ============================================
 * VERSANT - STOCKAGE : ADAPTATEUR « LEGACY »
 * ============================================
 * L'organisation actuelle des données : une seule édition (versant / 2026,
 * identifiant historique « versant-2026 »), ses fichiers dans backend/data/
 * (ou VERSANT_DATA_DIR) et les activités de la ligue dans
 * leagues/<id>_activities.json.
 *
 * Chaque opération fait exactement ce que faisait le code appelant avant L30 :
 * mêmes fichiers, mêmes verrous, même format.
 */

const fs = require('fs').promises;
const { safeReadJSON, safeWriteJSON } = require('../json-io');
const { LEGACY_CONTEXT, currentEdition } = require('../edition-context');

const path = require('path');
const { DATA_DIR, DEFAULT_EDITION } = require('../data-dir');

const LEGACY_EDITION = Object.freeze({
  leagueId: DEFAULT_EDITION.leagueId,
  editionId: DEFAULT_EDITION.editionId,
  legacyId: LEGACY_CONTEXT.leagueId,
  context: LEGACY_CONTEXT
});

function createLegacyStore() {
  const activitiesFile = leagueId => currentEdition().paths.activities(leagueId);

  return {
    layout: 'legacy',

    /** Éditions connues. */
    async listEditions() {
      return [LEGACY_EDITION];
    },

    /** Édition désignée par son identifiant historique ou « ligue/édition » ; null sinon. */
    async resolveEdition(id) {
      const key = String(id);
      const match = key === LEGACY_EDITION.legacyId || key === `${LEGACY_EDITION.leagueId}/${LEGACY_EDITION.editionId}`;
      return match ? LEGACY_EDITION : null;
    },

    /** Contexte d'édition (fichiers, config, planning) : ici, toujours le contexte par défaut. */
    async editionContext(id) {
      return (await this.resolveEdition(id)) ? LEGACY_CONTEXT : null;
    },

    /**
     * Participants d'une édition : les fiches d'athletes.json de la ligue
     * (identifiant historique), actives ou non, telles quelles.
     */
    async listParticipants(id) {
      const athletes = await safeReadJSON(path.join(DATA_DIR, 'athletes.json'), []);
      return athletes.filter(a => a.league_id === id);
    },

    /** Activités vues par une ligue (identifiant de ligue des routes actuelles), dans l'ordre stocké. */
    async readActivities(leagueId) {
      return safeReadJSON(activitiesFile(leagueId), []);
    },

    /** Enregistre la vue complète des activités d'une ligue. */
    async writeActivities(leagueId, activities) {
      await safeWriteJSON(activitiesFile(leagueId), activities);
    },

    /** Date de dernière modification des activités d'une ligue (null si inconnue). */
    async activitiesLastModified(leagueId) {
      const stats = await fs.stat(activitiesFile(leagueId)).catch(() => null);
      return stats?.mtime || null;
    },

    /** Activités d'une ligue telles qu'enregistrées (texte JSON), pour l'export admin. */
    async exportActivities(leagueId) {
      return fs.readFile(activitiesFile(leagueId), 'utf8');
    }
  };
}

module.exports = { createLegacyStore, LEGACY_EDITION };
