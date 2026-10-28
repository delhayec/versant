/**
 * ============================================
 * VERSANT - APPELS À L'API STRAVA ET QUOTA (L60)
 * ============================================
 * Tous les appels du serveur à Strava passent par request() : un seul endroit
 * compte le quota, qui vaut pour l'application entière (toutes ligues).
 *
 * Strava limite par fenêtre de 15 minutes (qui repart à :00, :15, :30, :45)
 * et par jour (qui repart à minuit UTC). Chaque réponse donne les limites et
 * la consommation dans ses en-têtes :
 *   X-RateLimit-Limit / X-RateLimit-Usage            tous les appels
 *   X-ReadRateLimit-Limit / X-ReadRateLimit-Usage    lectures (GET), plus basses
 * au format « 15 minutes,jour ». On garde la plus serrée des deux pour un GET.
 *
 * Priorités :
 *   - 'user'       : un joueur attend la réponse (inscription) ;
 *   - 'webhook'    : une activité à récupérer ;
 *   - 'background' : synchros et rattrapages, qui peuvent attendre.
 * Les tâches de fond laissent 25 % du quota aux deux autres. Quand une
 * fenêtre de 15 minutes est pleine, elles attendent la suivante ; quand c'est
 * la journée, elles s'arrêtent (RateLimitError) et reprendront plus tard.
 * Un 429 de Strava bloque tout jusqu'à la fin de la fenêtre concernée.
 */

const axios = require('axios');

const BASE_URL = () => process.env.STRAVA_API_BASE || 'https://www.strava.com';
const QUARTER_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BACKGROUND_SHARE = 0.75;     // part du quota ouverte aux tâches de fond
const MAX_BACKGROUND_WAIT_MS = 16 * 60 * 1000;

class RateLimitError extends Error {
  constructor(retryAt, scope) {
    super(`Limite d'appels Strava atteinte (${scope === 'day' ? 'journée' : '15 minutes'}) : reprise après ${new Date(retryAt).toISOString()}`);
    this.name = 'RateLimitError';
    this.rateLimited = true;
    this.retryAt = retryAt;
    this.scope = scope;
  }
}

const quarterStart = now => Math.floor(now / QUARTER_MS) * QUARTER_MS;
const dayStart = now => Math.floor(now / DAY_MS) * DAY_MS;

// Valeurs par défaut documentées par Strava, remplacées par les en-têtes dès la première réponse
const state = {
  limits: { all: [200, 2000], read: [100, 1000] },
  usage: { all: [0, 0], read: [0, 0] },
  quarter: quarterStart(Date.now()),
  day: dayStart(Date.now()),
  blockedUntil: 0,
  blockedScope: null,
  lastHeadersAt: null,
  calls: { total: 0, byPriority: {}, rateLimited: 0, deferred: 0 }
};

/** Remet les compteurs à zéro quand une fenêtre est passée. */
function roll(now = Date.now()) {
  const q = quarterStart(now);
  const d = dayStart(now);
  if (d !== state.day) {
    state.day = d;
    state.usage.all[1] = 0;
    state.usage.read[1] = 0;
  }
  if (q !== state.quarter) {
    state.quarter = q;
    state.usage.all[0] = 0;
    state.usage.read[0] = 0;
  }
  if (state.blockedUntil && now >= state.blockedUntil) {
    state.blockedUntil = 0;
    state.blockedScope = null;
  }
}

const parsePair = value => {
  const parts = String(value || '').split(',').map(n => parseInt(n, 10));
  return parts.length === 2 && parts.every(Number.isFinite) ? parts : null;
};

/** Lit les en-têtes de quota d'une réponse (succès ou erreur). */
function readHeaders(headers) {
  if (!headers) return;
  const get = name => headers[name] ?? headers[name.toLowerCase()];
  const pairs = {
    allLimit: parsePair(get('x-ratelimit-limit')),
    allUsage: parsePair(get('x-ratelimit-usage')),
    readLimit: parsePair(get('x-readratelimit-limit')),
    readUsage: parsePair(get('x-readratelimit-usage'))
  };
  if (pairs.allLimit) state.limits.all = pairs.allLimit;
  if (pairs.readLimit) state.limits.read = pairs.readLimit;
  // La réponse de Strava fait foi ; entre deux réponses, on compte nous-mêmes
  if (pairs.allUsage) state.usage.all = pairs.allUsage;
  if (pairs.readUsage) state.usage.read = pairs.readUsage;
  if (pairs.allUsage || pairs.readUsage) state.lastHeadersAt = new Date().toISOString();
}

/** Compteurs qui s'appliquent à un appel : tous, et lectures pour un GET. */
function buckets(method) {
  return String(method).toUpperCase() === 'GET' ? ['all', 'read'] : ['all'];
}

/**
 * Peut-on appeler maintenant ? → null si oui, sinon { waitUntil, scope }.
 */
function check(method, priority, now = Date.now()) {
  roll(now);
  if (state.blockedUntil > now) return { waitUntil: state.blockedUntil, scope: state.blockedScope };
  const share = priority === 'background' ? BACKGROUND_SHARE : 1;
  for (const bucket of buckets(method)) {
    const [limit15, limitDay] = state.limits[bucket];
    const [used15, usedDay] = state.usage[bucket];
    // On garde un appel de marge : le compteur de Strava peut avoir un appel d'avance
    if (usedDay >= Math.floor(limitDay * share) - 1) return { waitUntil: state.day + DAY_MS, scope: 'day' };
    if (used15 >= Math.floor(limit15 * share) - 1) return { waitUntil: state.quarter + QUARTER_MS, scope: 'quarter' };
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Appel à Strava, compté dans le quota.
 * @param {Object} config - configuration axios ; url relative à STRAVA_API_BASE
 * @param {Object} [options]
 * @param {'user'|'webhook'|'background'} [options.priority='background']
 * @returns {Promise<Object>} réponse axios
 * @throws {RateLimitError} quota épuisé (ou 429), avec retryAt
 */
async function request(config, { priority = 'background' } = {}) {
  const method = config.method || 'GET';
  for (;;) {
    const blocked = check(method, priority);
    if (!blocked) break;
    // Une tâche de fond attend la fenêtre de 15 minutes suivante ; le reste
    // (et la limite du jour) échoue tout de suite, l'appelant reprendra plus tard.
    const wait = blocked.waitUntil - Date.now();
    if (priority === 'background' && blocked.scope === 'quarter' && wait <= MAX_BACKGROUND_WAIT_MS) {
      state.calls.deferred++;
      console.log(`Quota Strava : pause de ${Math.ceil(wait / 1000)} s (fenêtre de 15 minutes pleine)`);
      await sleep(wait + 1000);
      continue;
    }
    throw new RateLimitError(blocked.waitUntil, blocked.scope);
  }

  for (const bucket of buckets(method)) {
    state.usage[bucket][0]++;
    state.usage[bucket][1]++;
  }
  state.calls.total++;
  state.calls.byPriority[priority] = (state.calls.byPriority[priority] || 0) + 1;

  try {
    const response = await axios({ ...config, url: `${BASE_URL()}${config.url}` });
    readHeaders(response.headers);
    return response;
  } catch (error) {
    readHeaders(error.response?.headers);
    if (error.response?.status === 429) {
      state.calls.rateLimited++;
      // Quelle limite est dépassée ? Celle du jour si son compteur est plein, sinon les 15 minutes
      const now = Date.now();
      roll(now);
      const dayFull = buckets(method).some(b => state.usage[b][1] >= state.limits[b][1]);
      state.blockedScope = dayFull ? 'day' : 'quarter';
      state.blockedUntil = dayFull ? state.day + DAY_MS : state.quarter + QUARTER_MS;
      console.warn(`Strava a répondu 429 : appels suspendus jusqu'à ${new Date(state.blockedUntil).toISOString()}`);
      throw new RateLimitError(state.blockedUntil, state.blockedScope);
    }
    throw error;
  }
}

/** État du quota, pour le tableau de bord admin. */
function status() {
  roll();
  return {
    limits: { all: [...state.limits.all], read: [...state.limits.read] },
    usage: { all: [...state.usage.all], read: [...state.usage.read] },
    blockedUntil: state.blockedUntil ? new Date(state.blockedUntil).toISOString() : null,
    blockedScope: state.blockedScope,
    lastHeadersAt: state.lastHeadersAt,
    callsSinceStart: { ...state.calls, byPriority: { ...state.calls.byPriority } }
  };
}

/** Tests : remet l'état à zéro. */
function _reset() {
  state.limits = { all: [200, 2000], read: [100, 1000] };
  state.usage = { all: [0, 0], read: [0, 0] };
  state.quarter = quarterStart(Date.now());
  state.day = dayStart(Date.now());
  state.blockedUntil = 0;
  state.blockedScope = null;
  state.lastHeadersAt = null;
  state.calls = { total: 0, byPriority: {}, rateLimited: 0, deferred: 0 };
}

module.exports = { request, status, RateLimitError, _reset, _check: check };
