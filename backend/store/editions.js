/**
 * ============================================
 * VERSANT - STOCKAGE : ADAPTATEUR « EDITIONS »
 * ============================================
 * Nouvelle organisation des données (cf. audit §6.3) :
 *
 *   activities/<userId>.json     activités d'un utilisateur, une seule fois quel
 *                                que soit le nombre de ligues : [{ seq, activity }]
 *   activities/_seq.json         { next } : compteur global d'ingestion
 *   leagues/<ligue>/league.json  { id, name }
 *   leagues/<ligue>/editions/<édition>/
 *     edition.json               { id, legacyId, activities: { from, to }, formerParticipants }
 *     exclusions.json            exclusions décidées par l'admin de CETTE édition
 *     frozen_results.json, …     fichiers de l'édition (gel, jokers, bonus…)
 *
 * Les appelants travaillent sur la « vue » d'une édition, comme sur l'ancien
 * fichier leagues/<id>_activities.json : les activités de ses participants,
 * dans l'ordre d'ingestion (seq), avec ses exclusions. writeActivities reçoit
 * une vue complète et répartit les changements par utilisateur.
 *
 * Fidélité : la vue reconstruite doit être identique, octet pour octet, à
 * l'ancien fichier. D'où le seq (l'ordre compte pour le moteur : égalités,
 * sommes de flottants) et la position des champs d'exclusion, qui sont
 * mémorisés tels qu'ils apparaissaient dans l'objet.
 */

const fs = require('fs').promises;
const path = require('path');
const { DATA_DIR } = require('../data-dir');
const { acquireLock, releaseLock, safeReadJSON, safeWriteJSON } = require('../json-io');

const EXCLUSION_KEYS = ['excluded', 'excluded_at', 'excluded_reason'];
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const ownerOf = activity => String(activity.athlete_id ?? activity.athlete?.id);

/** Sépare une activité en base (sans exclusion) et champs d'exclusion avec leur position. */
function splitExclusion(activity) {
  const keys = Object.keys(activity);
  const fields = [];
  const base = {};
  keys.forEach((key, index) => {
    if (EXCLUSION_KEYS.includes(key)) fields.push([key, activity[key], index]);
    else base[key] = activity[key];
  });
  return { base, fields };
}

/** Réinsère les champs d'exclusion à leur position d'origine. */
function applyExclusion(base, fields) {
  if (!fields || fields.length === 0) return base;
  const entries = Object.entries(base);
  for (const [key, value, index] of [...fields].sort((a, b) => a[2] - b[2])) {
    entries.splice(Math.min(index, entries.length), 0, [key, value]);
  }
  return Object.fromEntries(entries);
}

function inWindow(activity, window) {
  if (!window) return true;
  const date = String(activity.start_date || '');
  if (window.from && date < window.from) return false;
  if (window.to && date > window.to) return false;
  return true;
}

function createEditionsStore({ dataDir = DATA_DIR } = {}) {
  const activitiesDir = path.join(dataDir, 'activities');
  const leaguesDir = path.join(dataDir, 'leagues');
  const userFile = userId => {
    if (!ID_PATTERN.test(userId)) throw new Error(`identifiant d'utilisateur invalide : ${userId}`);
    return path.join(activitiesDir, `${userId}.json`);
  };
  const seqFile = path.join(activitiesDir, '_seq.json');

  /** Éditions déclarées sur le disque (lues à chaque appel : quelques petits fichiers). */
  async function loadEditions() {
    const editions = [];
    const leagues = await fs.readdir(leaguesDir, { withFileTypes: true }).catch(() => []);
    for (const league of leagues.filter(d => d.isDirectory())) {
      const leagueDir = path.join(leaguesDir, league.name);
      const leagueInfo = await safeReadJSON(path.join(leagueDir, 'league.json'), null);
      if (!leagueInfo) continue;
      const editionDirs = await fs.readdir(path.join(leagueDir, 'editions'), { withFileTypes: true }).catch(() => []);
      for (const edition of editionDirs.filter(d => d.isDirectory())) {
        const dir = path.join(leagueDir, 'editions', edition.name);
        const info = await safeReadJSON(path.join(dir, 'edition.json'), null);
        if (!info) continue;
        editions.push({ leagueId: leagueInfo.id, editionId: info.id, legacyId: info.legacyId || null, dir, info });
      }
    }
    return editions;
  }

  async function findEdition(id) {
    const key = String(id);
    const editions = await loadEditions();
    return editions.find(e => e.legacyId === key || `${e.leagueId}/${e.editionId}` === key) || null;
  }

  async function requireEdition(id) {
    const edition = await findEdition(id);
    if (!edition) throw new Error(`édition inconnue : ${id}`);
    return edition;
  }

  /**
   * Participants dont les activités forment la vue de l'édition. Jusqu'à L42,
   * l'appartenance reste portée par athletes.json (league_id = identifiant
   * historique), plus les anciens participants notés à la migration.
   */
  async function participantIds(edition) {
    const athletes = await safeReadJSON(path.join(dataDir, 'athletes.json'), []);
    const ids = new Set(athletes.filter(a => a.league_id === edition.legacyId).map(a => String(a.id)));
    for (const id of edition.info.formerParticipants || []) ids.add(String(id));
    return [...ids];
  }

  const lockKey = edition => path.join(edition.dir, '#activities');

  // Un contexte par édition, gardé en mémoire : son planning est modifiable (admin)
  const contexts = new Map();
  function buildContext(edition) {
    const { LEGACY_CONTEXT, createEditionContext } = require('../edition-context');
    const { DEFAULT_EDITION_DIR } = require('../data-dir');
    // L'édition par défaut garde le contexte par défaut (même config, même planning)
    if (path.resolve(edition.dir) === path.resolve(DEFAULT_EDITION_DIR)) return LEGACY_CONTEXT;
    const { CHALLENGE_CONFIG } = require('../shared-config');
    const id = edition.legacyId || `${edition.leagueId}/${edition.editionId}`;
    return createEditionContext({
      leagueId: id,
      editionId: edition.editionId,
      dataDir: edition.dir,
      config: { ...CHALLENGE_CONFIG, ...(edition.info.config || {}), leagueId: id }
    });
  }

  async function buildView(edition) {
    const exclusions = await safeReadJSON(path.join(edition.dir, 'exclusions.json'), {});
    const entries = [];
    for (const userId of await participantIds(edition)) {
      const stored = await safeReadJSON(userFile(userId), []);
      for (const entry of stored) {
        if (inWindow(entry.activity, edition.info.activities)) entries.push(entry);
      }
    }
    entries.sort((a, b) => a.seq - b.seq);
    return {
      view: entries.map(e => applyExclusion(e.activity, exclusions[String(e.activity.id)])),
      seqById: new Map(entries.map(e => [String(e.activity.id), e.seq]))
    };
  }

  return {
    layout: 'editions',

    async listEditions() {
      return (await loadEditions()).map(({ leagueId, editionId, legacyId }) => ({ leagueId, editionId, legacyId }));
    },

    async resolveEdition(id) {
      const edition = await findEdition(id);
      return edition ? { leagueId: edition.leagueId, editionId: edition.editionId, legacyId: edition.legacyId } : null;
    },

    async editionContext(id) {
      const edition = await findEdition(id);
      if (!edition) return null;
      if (!contexts.has(edition.dir)) contexts.set(edition.dir, buildContext(edition));
      return contexts.get(edition.dir);
    },

    async readActivities(id) {
      const edition = await findEdition(id);
      if (!edition) return [];
      await acquireLock(lockKey(edition));
      try {
        return (await buildView(edition)).view;
      } finally {
        releaseLock(lockKey(edition));
      }
    },

    /**
     * Enregistre la vue complète d'une édition. Les écritures du serveur ne font
     * que remplacer une activité à sa place, en ajouter à la fin ou en retirer :
     * une activité déjà connue garde son seq, une nouvelle en reçoit un.
     */
    async writeActivities(id, activities) {
      const edition = await requireEdition(id);
      await acquireLock(lockKey(edition));
      try {
        const { seqById } = await buildView(edition);
        const counter = await safeReadJSON(seqFile, { next: 1 });
        let next = counter.next;

        // Contrôle : l'ordre de la vue doit suivre les seq existants
        let lastSeq = -Infinity;
        for (const activity of activities) {
          const seq = seqById.get(String(activity.id));
          if (seq === undefined) continue;
          if (seq < lastSeq) throw new Error(`ordre des activités modifié (${activity.id}) : écriture refusée`);
          lastSeq = seq;
        }

        const byUser = new Map();
        const exclusions = {};
        const kept = new Set();
        for (const activity of activities) {
          const key = String(activity.id);
          const { base, fields } = splitExclusion(activity);
          if (fields.length > 0) exclusions[key] = fields;
          const seq = seqById.has(key) ? seqById.get(key) : next++;
          const owner = ownerOf(activity);
          if (!byUser.has(owner)) byUser.set(owner, []);
          byUser.get(owner).push({ seq, activity: base });
          kept.add(key);
        }

        // Utilisateurs touchés : ceux de la vue écrite et ceux de la vue précédente
        const participants = await participantIds(edition);
        for (const userId of new Set([...participants, ...byUser.keys()])) {
          const stored = await safeReadJSON(userFile(userId), []);
          // Hors fenêtre de l'édition : appartient à d'autres éditions, conservé tel quel
          const outside = stored.filter(e => !inWindow(e.activity, edition.info.activities) && !kept.has(String(e.activity.id)));
          const updated = [...outside, ...(byUser.get(userId) || [])].sort((a, b) => a.seq - b.seq);
          if (JSON.stringify(updated) !== JSON.stringify(stored)) await safeWriteJSON(userFile(userId), updated);
        }

        await safeWriteJSON(path.join(edition.dir, 'exclusions.json'), exclusions);
        if (next !== counter.next) await safeWriteJSON(seqFile, { next });
      } finally {
        releaseLock(lockKey(edition));
      }
    },

    async activitiesLastModified(id) {
      const edition = await findEdition(id);
      if (!edition) return null;
      const files = [path.join(edition.dir, 'exclusions.json'), ...(await participantIds(edition)).map(userFile)];
      let latest = null;
      for (const file of files) {
        const stats = await fs.stat(file).catch(() => null);
        if (stats && (!latest || stats.mtime > latest)) latest = stats.mtime;
      }
      return latest;
    },

    async exportActivities(id) {
      await requireEdition(id);
      return JSON.stringify(await this.readActivities(id), null, 2);
    }
  };
}

module.exports = { createEditionsStore, splitExclusion, applyExclusion, ownerOf };
