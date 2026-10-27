/**
 * ============================================
 * VERSANT - SERVEUR BACKEND v2.6
 * ============================================
 * FIXES:
 * - Import jokers-routes pour gestion admin des jokers
 * - Règle d'élimination corrigée (2 derniers OU ≥2 à 0 D+)
 * - Routes frozen-results complètes
 */
require('dotenv').config();

// Fuseau horaire déterministe : tout le calcul de dates du backend (bornes de
// round via getRoundDates, déclenchement de l'auto-freeze, saison) doit être en
// heure de Paris, quel que soit le fuseau de l'hôte. Sans ça, sur un serveur en
// UTC, une journée se termine à 01h Paris et la nouvelle saison ne repartait que
// le lendemain matin. Overridable via TZ dans .env si besoin.
process.env.TZ = process.env.TZ || 'Europe/Paris';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// VERSANT_DISABLE_JOBS=1 : ni tâches planifiées, ni rattrapage du gel au
// démarrage. Sert à faire tourner une copie du serveur sur un jeu de données de
// test (bac à sable du harnais de non-régression). À ne pas définir en prod.
const JOBS_DISABLED = process.env.VERSANT_DISABLE_JOBS === '1';
const cron = JOBS_DISABLED ? { schedule: () => null } : require('node-cron');

// Import configuration partagée (source unique de vérité)
const { VALID_SPORTS, isValidSport, JOKER_IDS, INITIAL_JOKER_STOCK, isTeamSeason, isRainyActivity } = require('./shared-config');

// Import du module jokers
const { createJokersRoutes } = require('./jokers-routes');

// Import du module bonus éphémères
const { createBonusesRoutes } = require('./bonuses-routes');

// Import du module frozen results
const frozenResults = require('./frozen-results.js');

// Module météo (règle spéciale "la pluie qui mouille")
const weather = require('./weather');


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Toute écriture réussie sur l'API peut changer le classement annuel : il est
// recalculé côté serveur, en différé (cf. scheduleStandingsRefresh). Sauf les
// routes sans effet sur le jeu ; les webhooks Strava sont traités à part (file).
const STANDINGS_NEUTRAL_WRITES = [
  '/api/auth/', '/api/webhook/', '/api/admin/login', '/api/admin/webhooks',
  '/api/admin/strava', '/api/admin/tokens', '/api/admin/reset-password'
];
// Appels internes du moteur serveur pour une édition autre que celle par
// défaut (L33) : en-tête X-Versant-Edition, authentifié par un jeton tiré au
// démarrage et connu du seul processus. La requête est alors traitée dans le
// contexte de cette édition par les routes historiques.
const INTERNAL_TOKEN = crypto.randomBytes(32).toString('hex');

// Session d'un super-admin (L43) : reconnue une fois pour toute la requête,
// checkAdmin reste synchrone
app.use('/api', async (req, res, next) => {
  try {
    if (req.headers.authorization && SUPER_ADMIN_EMAILS.length > 0) {
      const account = await sessionAccount(req);
      if (account) {
        req.sessionAccount = account;
        req.isSuperAdmin = isSuperAdminAccount(account);
      }
    }
    next();
  } catch (error) {
    next(error);
  }
});
app.use('/api', async (req, res, next) => {
  const editionKey = req.headers['x-versant-edition'];
  if (!editionKey) return next();
  if (req.headers['x-versant-internal'] !== INTERNAL_TOKEN) return res.status(401).json({ error: 'Non autorisé' });
  try {
    const context = await store.editionContext(String(editionKey));
    if (!context) return res.status(404).json({ error: 'Édition introuvable' });
    withEdition(context, next);
  } catch (error) {
    next(error);
  }
});

app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !STANDINGS_NEUTRAL_WRITES.some(prefix => req.originalUrl.startsWith(prefix))) {
    res.on('finish', () => {
      if (res.statusCode < 400) scheduleStandingsRefresh(`${req.method} ${req.originalUrl.split('?')[0]}`);
    });
  }
  next();
});
// Les modules ES importés depuis app.js (config.js, standings-engine.js, …) n'ont
// pas de query string de cache-busting : seul le point d'entrée en a une. On force
// donc la revalidation sur le JS/CSS. `no-cache` n'interdit pas le cache, il exige
// juste de revalider → ETag → 304 quand rien n'a changé, donc aucun surcoût, mais
// plus de joueur appliquant une règle de classement périmée après un déploiement.
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders: (res, filePath) => {
    // HTML aussi : une app iOS « sur l'écran d'accueil » pouvait resservir une
    // page d'accueil en cache heuristique (pas d'en-tête = cache à la discrétion du navigateur).
    if (/\.(js|css|mjs|html)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Configuration Strava (unique)
const STRAVA_CONFIG = {
  clientId: process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET
};

// Racine des appels à l'API Strava. STRAVA_API_BASE permet de pointer un faux
// Strava dans le bac à sable du harnais. À ne pas définir en prod.
const STRAVA_BASE_URL = process.env.STRAVA_API_BASE || 'https://www.strava.com';

// Pas de valeur par défaut : sans ADMIN_PASSWORD, les routes admin refusent tout.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const STRAVA_VERIFY_TOKEN = process.env.STRAVA_VERIFY_TOKEN || 'VERSANT2026';

// Identifiant de notre abonnement aux webhooks Strava (visible dans l'admin,
// « Statut Strava »). Défini : tout événement d'un autre abonnement est ignoré.
// Absent : contrôle inactif, les autres vérifications du webhook s'appliquent.
const STRAVA_SUBSCRIPTION_ID = process.env.STRAVA_SUBSCRIPTION_ID
  ? String(process.env.STRAVA_SUBSCRIPTION_ID).trim()
  : null;

const { DATA_DIR, STORE_LAYOUT, DEFAULT_EDITION } = require('./data-dir');
const LEAGUES_DIR = path.join(DATA_DIR, 'leagues');
const ATHLETES_FILE = path.join(DATA_DIR, 'athletes.json');
// Fichiers propres à une édition (jokers, figés, activités…) : cf. edition-context.js
const { currentEdition, withEdition, LEGACY_CONTEXT } = require('./edition-context');
const { registerEditionRoutes } = require('./routes/editions');
const { registerAccountRoutes } = require('./routes/accounts');
const { registerLeagueRoutes } = require('./routes/leagues');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const FAILED_WEBHOOKS_FILE = path.join(DATA_DIR, 'failed_webhooks.json');
const WEBHOOK_LOG_FILE = path.join(DATA_DIR, 'webhook_log.json');

// ============================================
// UTILITAIRES
// ============================================
function normalizeId(id) {
  if (id === null || id === undefined) return null;
  return String(id).trim();
}

// Mots de passe des joueurs : deux formats pendant la transition.
// - password_hash : SHA-256 sans sel, l'ancien format. Le code d'avant ne
//   connaît que lui : il reste écrit tant qu'un retour arrière est possible.
// - password_scrypt : scrypt salé, « scrypt$N$r$p$sel$hash » (base64).
// Tant que password_hash existe, c'est lui qui fait foi : un retour au code
// d'avant a pu le changer (réinitialisation) sans mettre à jour password_scrypt.
// Une fois password_hash supprimé des comptes migrés (cf. diagnostic admin),
// seul password_scrypt est vérifié.
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 64;

function scrypt(password, salt, keylen, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, params, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPasswordScrypt(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyScrypt(password, record) {
  const [scheme, N, r, p, saltB64, hashB64] = String(record).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length === 0) return false;
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, expected);
}

/** Vérifie le mot de passe d'un compte, quel que soit le format de son hash. */
async function verifyPassword(password, account) {
  if (account.password_hash) {
    const actual = Buffer.from(hashPassword(password), 'hex');
    const expected = Buffer.from(String(account.password_hash), 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  if (account.password_scrypt) return verifyScrypt(password, account.password_scrypt);
  return false;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Verrous et lecture / écriture JSON : cf. json-io.js
const { safeReadJSON, safeWriteJSON, safeModifyJSON } = require('./json-io');
// Éditions et activités : couche de stockage (cf. store/index.js)
const store = require('./store').getStore();

/**
 * Normalise les données de jokers_usage.json
 * Gère le format objet {athletes, usage, config} ET le format tableau []
 * Retourne toujours un tableau plat d'utilisations
 */
function normalizeJokerUsage(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray(data.usage)) return data.usage;
  return [];
}

/**
 * Lit jokers_usage.json et retourne un tableau normalisé
 */
async function readJokerUsage() {
  const raw = await safeReadJSON(currentEdition().paths.jokers, []);
  return normalizeJokerUsage(raw);
}

/**
 * Lit jokers_usage.json ET complète avec les jokers des frozen results
 * Source de vérité unifiée pour le stock de jokers
 */
async function readJokerUsageWithFrozen() {
  const jokerUsage = await readJokerUsage();

  try {
    const frozenData = await frozenResults.getAllFrozenResults();
    if (frozenData?.rounds) {
      for (const [roundKey, roundData] of Object.entries(frozenData.rounds)) {
        const jokersUsed = roundData.jokersUsed || [];
        for (const joker of jokersUsed) {
          // Vérifier si cette utilisation existe déjà (par athlete + joker + round)
          const alreadyExists = jokerUsage.some(j =>
            String(j.athlete_id) === String(joker.athleteId) &&
            j.joker_id === joker.jokerId &&
            j.round_number === parseInt(roundKey)
          );
          if (alreadyExists) continue;

          jokerUsage.push({
            id: `frozen-${roundKey}-${joker.athleteId}-${joker.jokerId}`,
            athlete_id: String(joker.athleteId),
            athlete_name: joker.athleteName || 'Inconnu',
            joker_id: joker.jokerId,
            target_athlete_id: joker.targetId ? String(joker.targetId) : null,
            target_athlete_name: joker.targetName || null,
            round_number: parseInt(roundKey),
            used_at: roundData.frozenAt || new Date().toISOString(),
            status: 'active',
            resolved: true,
            source: 'frozen_results'
          });
        }
      }
    }
  } catch (e) {
    // frozenResults peut ne pas être encore chargé au démarrage
  }

  return jokerUsage;
}


// ============================================
// LOGGING
// ============================================
async function logWebhook(event, status, details = {}) {
  try {
    const logs = await safeReadJSON(WEBHOOK_LOG_FILE, []);
    logs.unshift({
      timestamp: new Date().toISOString(),
      object_type: event.object_type,
      aspect_type: event.aspect_type,
      owner_id: event.owner_id,
      object_id: event.object_id,
      status,
      details
    });
    if (logs.length > 500) logs.length = 500;
    await safeWriteJSON(WEBHOOK_LOG_FILE, logs);
  } catch (e) {
    console.error('Log error:', e.message);
  }
}

// ============================================
// INITIALISATION
// ============================================
async function initializeServer() {
  // Organisation editions : les données doivent avoir été migrées, sinon le
  // serveur démarrerait sur des dossiers vides
  if (STORE_LAYOUT === 'editions' && !(await store.resolveEdition(DEFAULT_EDITION.legacyId))) {
    throw new Error(`VERSANT_STORE_LAYOUT=editions mais édition ${DEFAULT_EDITION.leagueId}/${DEFAULT_EDITION.editionId} introuvable : lancer d'abord backend/scripts/migrate-editions.js aller`);
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(LEAGUES_DIR, { recursive: true });

  const files = [ATHLETES_FILE, currentEdition().paths.jokers, SESSIONS_FILE, FAILED_WEBHOOKS_FILE, WEBHOOK_LOG_FILE];
  for (const file of files) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, JSON.stringify([], null, 2));
    }
  }

  // Initialiser special_rules.json en tant qu'objet (pas tableau)
  try {
    await fs.access(currentEdition().paths.specialRules);
  } catch {
    await fs.writeFile(currentEdition().paths.specialRules, JSON.stringify({}, null, 2));
  }

  // Migration: corriger le format de jokers_usage.json si nécessaire
  try {
    const raw = JSON.parse(await fs.readFile(currentEdition().paths.jokers, 'utf8'));
    if (!Array.isArray(raw)) {
      const normalized = normalizeJokerUsage(raw);
      await fs.writeFile(currentEdition().paths.jokers, JSON.stringify(normalized, null, 2));
      console.log(`🔧 Migration jokers_usage.json: format objet → tableau (${normalized.length} entrées)`);
    }
  } catch (e) {
    console.warn('⚠️ Impossible de migrer jokers_usage.json:', e.message);
  }

  console.log('✅ Serveur initialisé');
}

// ============================================
// SESSIONS
// ============================================
async function createSession(athleteId) {
  const token = generateToken();
  const sessions = await safeReadJSON(SESSIONS_FILE, []);
  sessions.push({
    token,
    athlete_id: normalizeId(athleteId),
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  });
  await safeWriteJSON(SESSIONS_FILE, sessions);
  return token;
}

async function validateSession(token) {
  if (!token) return null;
  const sessions = await safeReadJSON(SESSIONS_FILE, []);
  const session = sessions.find(s => s.token === token);
  if (!session || new Date(session.expires_at) < new Date()) return null;
  return session.athlete_id;
}

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const athleteId = await validateSession(token);
  if (!athleteId) return res.status(401).json({ error: 'Non authentifié' });
  req.athleteId = athleteId;
  next();
}

// ============================================
// RÔLES (L43)
// ============================================
// - super-admin : compte dont l'e-mail figure dans SUPER_ADMIN_EMAILS (.env) ;
//   tous les droits d'administration, sur toutes les ligues et l'instance ;
// - admin de ligue : compte listé dans league.json (admins) ; droits limités à
//   sa ligue, par les routes /api/leagues/:ligue/editions/:édition/admin/… ;
// - mot de passe admin : accès de secours, équivalent au super-admin.
const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

function isAdminPassword(req) {
  return !!ADMIN_PASSWORD && req.headers['x-admin-password'] === ADMIN_PASSWORD;
}

function isSuperAdminAccount(account) {
  return !!account?.email && SUPER_ADMIN_EMAILS.includes(String(account.email).toLowerCase());
}

/** Compte de la session (jeton Bearer), ou null. */
async function sessionAccount(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  const athleteId = await validateSession(token);
  if (!athleteId) return null;
  const accounts = await safeReadJSON(ATHLETES_FILE, []);
  return accounts.find(a => normalizeId(a.id) === normalizeId(athleteId)) || null;
}

/** Admin de la ligue : super-admin, mot de passe de secours, ou compte listé dans league.json. */
async function isLeagueAdmin(req, leagueId) {
  if (isAdminPassword(req) || req.isSuperAdmin) return true;
  const account = req.sessionAccount || await sessionAccount(req);
  if (!account) return false;
  const league = await store.getLeague(leagueId);
  return !!league && (league.admins || []).map(String).includes(String(account.id));
}

/**
 * Droits d'administration de l'instance : mot de passe de secours,
 * super-admin connecté, ou accès accordé par une route d'admin de ligue
 * (req.adminGranted, posé côté serveur uniquement, cf. routes/editions.js).
 */
function checkAdmin(req, res) {
  if (isAdminPassword(req) || req.isSuperAdmin || req.adminGranted) return true;
  res.status(401).json({ error: 'Non autorisé' });
  return false;
}

// Admin: Télécharger jokers_usage.json (format tableau, importable directement).
// Déclaré AVANT le router jokers : sa route /admin/jokers/:leagueId capturerait
// sinon « download » comme identifiant de ligue.
app.get('/api/admin/jokers/download', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = await fs.readFile(currentEdition().paths.jokers, 'utf8');
    res.setHeader('Content-Disposition', 'attachment; filename=jokers_usage.json');
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  } catch {
    res.status(404).json({ error: 'Fichier non trouvé' });
  }
});

// Monter le router jokers
const jokersRouter = createJokersRoutes({
  ATHLETES_FILE,
  checkAdmin,
  requireAuth
});
app.use('/api', jokersRouter);

// Initialiser les routes bonus éphémères
createBonusesRoutes(app, requireAuth, checkAdmin);

// Compte et adhésion à une ligue (L42) : /api/me, /api/leagues/join, code d'invitation
registerAccountRoutes(app, {
  store,
  requireAuth,
  isLeagueAdmin,
  readAccounts: () => safeReadJSON(ATHLETES_FILE, []),
  // Rattrapage des activités du nouvel arrivant, dans le contexte de son édition
  onJoin: backfillAfterJoin
});

// Ligues et éditions (L42c) : création, lancement d'édition, confirmations
registerLeagueRoutes(app, {
  store, requireAuth, checkAdmin, isLeagueAdmin,
  readAccounts: () => safeReadJSON(ATHLETES_FILE, []),
  onJoin: backfillAfterJoin
});

/** Rattrapage des activités d'un compte qui arrive dans une édition, dans son contexte. */
async function backfillAfterJoin(editionKey, athleteId) {
  try {
    const context = await store.editionContext(editionKey);
    const accounts = await safeReadJSON(ATHLETES_FILE, []);
    const name = accounts.find(a => normalizeId(a.id) === normalizeId(athleteId))?.name || athleteId;
    await withEdition(context, () => backfillNewParticipant(editionKey, normalizeId(athleteId), name));
  } catch (e) {
    console.error('⚠️ Rattrapage après adhésion échoué:', e.message);
  }
}

// Routes par édition (L40) : /api/leagues/:ligue/editions/:édition/…, réservées
// aux participants connectés (ou à l'admin) ; elles délèguent aux routes ci-dessus.
registerEditionRoutes(app, {
  store,
  validateSession,
  isAdminRequest: req => !!ADMIN_PASSWORD && req.headers['x-admin-password'] === ADMIN_PASSWORD,
  // Participants de l'édition (store.listParticipants : athletes.json pour versant/2026)
  isParticipant: async (athleteId, edition) => {
    const participants = await store.listParticipants(edition.legacyId || `${edition.leagueId}/${edition.editionId}`);
    return participants.some(a => normalizeId(a.id) === normalizeId(athleteId));
  },
  withEdition,
  isLeagueAdmin
});

// ============================================
// CONFIG ROUTE (publique)
// ============================================
app.get('/api/config', (req, res) => {
  res.json({
    challenge: currentEdition().config,
    validSports: VALID_SPORTS,
    jokerIds: JOKER_IDS,
    initialJokerStock: INITIAL_JOKER_STOCK
  });
});

// Client ID Strava (public, pas un secret)
app.get('/api/strava-client-id', (req, res) => {
  res.json({ clientId: STRAVA_CONFIG.clientId });
});

// ============================================
// SPECIAL RULES ROUTES
// ============================================

// GET public - retourne les overrides de règles spéciales {roundNumber: ruleId}
app.get('/api/special-rules', async (req, res) => {
  try {
    const rules = await safeReadJSON(currentEdition().paths.specialRules, {});
    res.json(rules);
  } catch (error) {
    res.json({});
  }
});


// ============================================
// ROUND CONFIGS (configurations par round)
// ============================================
const roundConfigsModule = require('./round-configs');

// GET /api/round-configs - Lecture publique
app.get('/api/round-configs', async (req, res) => {
  try {
    const configs = await roundConfigsModule.loadRoundConfigs();
    res.json(configs);
  } catch (error) {
    console.error('Erreur round-configs GET:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Numéro de round global contenant un instant donné.
 * Même ancrage que getRoundDates (minuit LOCAL au jour de départ du challenge),
 * sinon on décale d'une heure en été et une activité peut changer de round.
 */
function getRoundNumberForDate(timestamp) {
  return sharedConfig.getRoundNumberForDate(timestamp, currentEdition().config);
}

// GET /api/weather-coverage/:leagueId - Couverture météo par round
// Permet à l'admin de savoir, AVANT de figer un round sous la règle
// "pluie qui mouille", combien d'activités n'ont pas de météo exploitable
// (typiquement : pas de coordonnées GPS).
app.get('/api/weather-coverage/:leagueId', async (req, res) => {
  try {
    const activitiesLeague = req.params.leagueId;
    const activities = await store.readActivities(activitiesLeague);

    const byRound = {};
    for (const a of activities) {
      if (a.excluded) continue;
      if (!isValidSport(a.sport_type || a.type)) continue;

      // Même rattachement que le calcul des rounds : heure de FIN de l'activité
      const endTime = new Date(a.start_date).getTime() + (a.elapsed_time || 0) * 1000;
      const round = getRoundNumberForDate(endTime);
      if (!round) continue;

      const slot = byRound[round] || (byRound[round] = { total: 0, ok: 0, noGeo: 0, error: 0, missing: 0, rainy: 0 });
      slot.total++;
      const status = a.weather?.status;
      if (status === 'ok') {
        slot.ok++;
        if (isRainyActivity(a)) slot.rainy++;
      } else if (status === 'no_geo') slot.noGeo++;
      else if (status === 'error') slot.error++;
      else slot.missing++;
    }

    res.json(byRound);
  } catch (error) {
    console.error('Erreur weather-coverage:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/admin/round-configs/:roundNumber - Sauvegarder
app.post('/api/admin/round-configs/:roundNumber', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const roundNumber = parseInt(req.params.roundNumber);
    if (isNaN(roundNumber) || roundNumber < 1) {
      return res.status(400).json({ error: 'Numéro de round invalide' });
    }
    const { nbEliminations, type, specialRule } = req.body;
    const config = await roundConfigsModule.saveRoundConfig(roundNumber, {
      nbEliminations, type, specialRule
    });
    res.json({ success: true, config });
  } catch (error) {
    console.error('Erreur round-configs POST:', error);
    // Erreur de validation (règle spéciale inconnue) : renvoyer le motif,
    // sinon l'admin ne voit qu'un "Erreur serveur" opaque.
    if (/inconnue/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/admin/round-configs/:roundNumber - Supprimer
app.delete('/api/admin/round-configs/:roundNumber', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const roundNumber = parseInt(req.params.roundNumber);
    if (isNaN(roundNumber) || roundNumber < 1) {
      return res.status(400).json({ error: 'Numéro de round invalide' });
    }
    await roundConfigsModule.deleteRoundConfig(roundNumber);
    res.json({ success: true, roundNumber });
  } catch (error) {
    console.error('Erreur round-configs DELETE:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/admin/season-plan - Plan de la saison en cours (visualisateur admin)
// Calculé par le moteur de gel : rounds figés tels quels, suivants projetés.
app.get('/api/admin/season-plan', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const leagueId = req.query.leagueId || currentEdition().leagueId;
    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const leagueAthletes = (await store.listParticipants(leagueId)).filter(a => a.active);
    const plan = await frozenResults.getSeasonPlan(leagueAthletes, currentEdition().config);
    res.json(plan);
  } catch (error) {
    console.error('Erreur season-plan:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PLANNING DES SAISONS (standard / équipes / points doublés / deadline)
// ============================================
const sharedConfig = require('./shared-config');
const { planDeadlineRounds } = require('./deadline-planner');

async function getLeagueAthletes() {
  const athletes = await safeReadJSON(ATHLETES_FILE, []);
  return (await store.listParticipants(currentEdition().leagueId)).filter(a => a.active);
}

/** Replanifie la saison Deadline en cours (sans effet sinon). Jamais bloquant. */
async function replanDeadline(reason) {
  try {
    return await frozenResults.replanDeadlineSeason(await getLeagueAthletes(), currentEdition().config);
  } catch (e) {
    console.warn(`⚠️ Replanification Deadline (${reason}):`, e.message);
    return null;
  }
}

// GET public - type des saisons, deadlines et durées des rounds, lus par le
// frontend au chargement (les dates des rounds en dépendent)
app.get('/api/season-planning', (req, res) => {
  res.json({
    types: currentEdition().planning.seasonTypes,
    deadlines: currentEdition().planning.seasonDeadlines,
    teamSettings: currentEdition().planning.seasonTeamSettings,
    roundDurations: currentEdition().planning.roundDurations
  });
});

// GET admin - planning enrichi du statut de chaque saison
app.get('/api/admin/season-planning', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = await frozenResults.loadFrozenResultsRaw();
    const athletes = await getLeagueAthletes();
    const plan = await frozenResults.getSeasonPlan(athletes, currentEdition().config);
    const frozenSeasons = new Set(Object.values(data?.rounds || {})
      .filter(r => r?.frozen).map(r => Number(r.seasonNumber)));
    const lastSeason = Math.max(12, plan.seasonNumber + 4, ...Object.keys(currentEdition().planning.seasonTypes).map(Number));

    const seasons = [];
    for (let s = 1; s <= lastSeason; s++) {
      const status = data?.eliminatedChallengeRankings?.[String(s)] ? 'closed'
        : s === plan.seasonNumber ? 'current'
        : s < plan.seasonNumber ? 'closed'
        : 'upcoming';
      const type = currentEdition().planning.seasonTypes[s] || 'standard';
      const deadline = sharedConfig.getSeasonDeadline(s);
      const entry = {
        seasonNumber: s, type, deadline, status,
        hasFrozenRounds: frozenSeasons.has(s),
        startRound: s === plan.seasonNumber ? plan.startRound
          : s === plan.seasonNumber + 1 ? plan.endRound + 1 : null
      };

      // Saison Deadline : plan réel (saison en cours, cf. visualisateur) ou aperçu
      // pour la saison suivante, estimé avec tous les joueurs actifs et la fin
      // projetée de la saison en cours.
      const seasonType = sharedConfig.SEASON_TYPES[type];
      if (seasonType?.hasDeadline && deadline && s === plan.seasonNumber + 1) {
        const startDate = sharedConfig.getRoundDates(entry.startRound, currentEdition().config).start;
        const preview = planDeadlineRounds({
          actives: athletes.length, startDate, deadline,
          finalists: currentEdition().config.finalistsCount,
          durationRange: seasonType.durationRange,
          eliminationsRange: seasonType.eliminationsRange
        });
        entry.preview = { startDate, rounds: preview.rounds, warning: preview.warning };
      }
      seasons.push(entry);
    }
    res.json({
      seasons,
      types: Object.values(sharedConfig.SEASON_TYPES).map(t => ({ id: t.id, name: t.name, hasDeadline: !!t.hasDeadline }))
    });
  } catch (error) {
    console.error('Erreur season-planning:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST admin - changer le type (et la deadline) d'une saison pas encore figée
app.post('/api/admin/season-planning/:seasonNumber', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const seasonNumber = parseInt(req.params.seasonNumber, 10);
    const { type, deadline } = req.body || {};
    if (isNaN(seasonNumber) || seasonNumber < 1) {
      return res.status(400).json({ error: 'Numéro de saison invalide' });
    }
    const seasonType = sharedConfig.SEASON_TYPES[type];
    if (!seasonType) {
      return res.status(400).json({ error: `Type de saison inconnu: ${type}` });
    }
    if (seasonType.hasDeadline) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(deadline || ''))) {
        return res.status(400).json({ error: 'Date de fin (deadline) requise au format AAAA-MM-JJ' });
      }
      const [y, m, d] = deadline.split('-').map(Number);
      if (new Date(y, m - 1, d, 23, 59, 59) < new Date()) {
        return res.status(400).json({ error: 'La deadline est déjà passée' });
      }
    }

    // Une saison dont un round est figé ne peut plus changer de type : ses
    // résultats ont été calculés avec l'ancien mode de jeu. Seule la deadline
    // d'une saison Deadline en cours reste ajustable.
    const data = await frozenResults.loadFrozenResultsRaw();
    const hasFrozen = Object.values(data?.rounds || {})
      .some(r => r?.frozen && Number(r.seasonNumber) === seasonNumber);
    const deadlineOnlyChange = seasonType.hasDeadline && currentEdition().planning.seasonTypes[seasonNumber] === type;
    if (hasFrozen && !deadlineOnlyChange) {
      return res.status(409).json({ error: `La saison ${seasonNumber} a déjà des rounds figés, son type ne peut plus changer` });
    }

    const raw = await safeReadJSON(currentEdition().paths.seasonPlanning, {});
    const stored = raw.types || raw.deadlines ? raw : { types: raw };
    stored.types = stored.types || {};
    stored.deadlines = stored.deadlines || {};
    stored.types[String(seasonNumber)] = type;
    if (seasonType.hasDeadline) stored.deadlines[String(seasonNumber)] = deadline;
    else delete stored.deadlines[String(seasonNumber)];
    await safeWriteJSON(currentEdition().paths.seasonPlanning, stored);

    sharedConfig.applySeasonPlanningOverrides({ types: { [seasonNumber]: type } });
    if (seasonType.hasDeadline) currentEdition().planning.seasonDeadlines[seasonNumber] = deadline;
    else delete currentEdition().planning.seasonDeadlines[seasonNumber];
    _teamsCache.clear();

    // Saison en cours : appliquer tout de suite (sinon au premier gel de la saison)
    const replan = await replanDeadline('planning admin');

    console.log(`🗓️ Saison ${seasonNumber} → ${type}${seasonType.hasDeadline ? ` (deadline ${deadline})` : ''}`);
    res.json({ success: true, seasonNumber, type, deadline: seasonType.hasDeadline ? deadline : null, replan });
  } catch (error) {
    console.error('Erreur season-planning POST:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SEASON BONUSES ARCHIVE (dans frozen_results)
// ============================================

// GET public - retourne les bonus archivés pour une saison
app.get('/api/season-bonuses/:seasonNumber', async (req, res) => {
  try {
    const frozen = await frozenResults.getAllFrozenResults();
    const seasonNumber = parseInt(req.params.seasonNumber);
    const bonuses = frozen.seasonBonuses?.[String(seasonNumber)] || [];
    res.json(bonuses);
  } catch (error) {
    res.json([]);
  }
});

// POST admin - archiver les bonus d'une saison dans frozen_results
app.post('/api/admin/season-bonuses/:seasonNumber', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const seasonNumber = parseInt(req.params.seasonNumber);
    const { bonuses } = req.body;
    if (!bonuses || !Array.isArray(bonuses)) {
      return res.status(400).json({ error: 'bonuses (array) requis' });
    }

    const frozen = await frozenResults.getAllFrozenResults();
    if (!frozen.seasonBonuses) frozen.seasonBonuses = {};
    frozen.seasonBonuses[String(seasonNumber)] = bonuses;
    frozen.lastUpdated = new Date().toISOString();

    const FROZEN_FILE_PATH = currentEdition().paths.frozen;
    await fs.writeFile(FROZEN_FILE_PATH, JSON.stringify(frozen, null, 2));

    res.json({ success: true, count: bonuses.length });
  } catch (error) {
    console.error('Erreur season-bonuses:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// AUTH ROUTES
// ============================================
app.post('/api/auth/strava/exchange', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code manquant' });

    const response = await axios.post(`${STRAVA_BASE_URL}/oauth/token`, {
      client_id: STRAVA_CONFIG.clientId,
      client_secret: STRAVA_CONFIG.clientSecret,
      code,
      grant_type: 'authorization_code'
    });

    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Erreur Strava' });
  }
});

/**
 * Après une connexion réussie : ajoute le hash scrypt d'un compte qui n'en a
 * pas encore, ou le remplace s'il est périmé. Un échec n'empêche pas la
 * connexion : la migration sera retentée à la suivante.
 */
async function ensureScryptHash(account, password) {
  try {
    if (account.password_scrypt && await verifyScrypt(password, account.password_scrypt)) return;
    const record = await hashPasswordScrypt(password);
    await safeModifyJSON(ATHLETES_FILE, athletes => {
      // Fichier illisible : surtout ne pas réécrire une liste vide.
      if (!Array.isArray(athletes)) throw new Error('athletes.json illisible');
      const current = athletes.find(a => a.email?.toLowerCase() === account.email.toLowerCase());
      // Mot de passe changé entre-temps : on ne touche à rien.
      if (current && current.password_hash === account.password_hash) current.password_scrypt = record;
      return athletes;
    }, null);
  } catch (error) {
    console.warn(`⚠️ Migration du mot de passe de ${account.name} : ${error.message}`);
  }
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Données manquantes' });

    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const athlete = athletes.find(a => a.email?.toLowerCase() === email.toLowerCase());

    if (!athlete || !(await verifyPassword(password, athlete))) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    await ensureScryptHash(athlete, password);

    const token = await createSession(athlete.id);
    res.json({ success: true, token, athlete: { id: athlete.id, name: athlete.name, email: athlete.email, league_id: athlete.league_id } });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    const sessions = await safeReadJSON(SESSIONS_FILE, []);
    await safeWriteJSON(SESSIONS_FILE, sessions.filter(s => s.token !== token));
  }
  res.json({ success: true });
});

// Route admin pour réinitialiser le mot de passe d'un joueur
app.post('/api/admin/reset-password', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    const { athleteId, newPassword } = req.body;

    if (!athleteId || !newPassword) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }

    // Calculé avant la lecture du fichier (cf. inscription)
    const passwordScrypt = await hashPasswordScrypt(newPassword);

    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const idx = athletes.findIndex(a => normalizeId(a.id) === normalizeId(athleteId));

    if (idx === -1) {
      return res.status(404).json({ error: 'Athlète non trouvé' });
    }

    // Hasher le nouveau mot de passe (les deux formats, cf. hashPassword)
    athletes[idx].password_hash = hashPassword(newPassword);
    athletes[idx].password_scrypt = passwordScrypt;

    // Supprimer les tokens de reset éventuels
    delete athletes[idx].reset_token;
    delete athletes[idx].reset_expires;

    await safeWriteJSON(ATHLETES_FILE, athletes);

    console.log(`🔑 Mot de passe réinitialisé pour: ${athletes[idx].name} (ID: ${athleteId})`);

    res.json({
      success: true,
      message: `Mot de passe de ${athletes[idx].name} réinitialisé avec succès`
    });
  } catch (error) {
    console.error('Erreur reset-password:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ============================================
// ATHLETES ROUTES
// ============================================

/**
 * Saison en cours et son premier round, déduits des rounds figés.
 * Même heuristique que le frontend (config.js::getSeasonNumber) : si le
 * challenge éliminés de la dernière saison figée existe, cette saison est
 * terminée et on est dans la suivante.
 */
async function getCurrentSeasonContext() {
  try {
    const data = await frozenResults.loadFrozenResultsRaw();
    const rounds = Object.values(data?.rounds || {}).filter(r => r?.frozen);
    if (rounds.length === 0) return { seasonNumber: 1, startRound: 1 };

    const last = rounds.reduce((a, b) => (Number(b.roundNumber) > Number(a.roundNumber) ? b : a));
    const lastSeason = Number(last.seasonNumber) || 1;
    const lastSeasonDone = !!data?.eliminatedChallengeRankings?.[String(lastSeason)];
    const seasonNumber = lastSeasonDone ? lastSeason + 1 : lastSeason;

    const roundsOfSeason = rounds
      .filter(r => Number(r.seasonNumber) === seasonNumber)
      .map(r => Number(r.roundNumber))
      .filter(n => !isNaN(n));
    const startRound = roundsOfSeason.length
      ? Math.min(...roundsOfSeason)
      : Number(last.roundNumber) + 1;

    return { seasonNumber, startRound };
  } catch (e) {
    console.warn('⚠️ getCurrentSeasonContext:', e.message);
    return { seasonNumber: 1, startRound: 1 };
  }
}

/**
 * Backfill de l'historique d'un nouvel arrivant, en tâche de fond : le cron ne
 * balaie qu'une fenêtre glissante de 7 jours, il resterait sinon à 0 D+. On
 * remonte au début de la saison en cours — il n'entre normalement qu'à la
 * suivante, mais cela couvre le cas d'une entrée anticipée (active_from_round).
 * Dates en AAAA-MM-JJ LOCAL : getRoundDates ancre à minuit local
 * (Europe/Paris), toISOString() reculerait d'un jour.
 */
async function backfillNewParticipant(leagueId, athleteId, name) {
  const { startRound } = await getCurrentSeasonContext();
  const toLocalDay = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString().split('T')[0];
  const backfillStart = toLocalDay(frozenResults.getRoundDates(startRound, currentEdition().config).start);
  const backfillEnd = toLocalDay(new Date());
  syncLeague(leagueId, backfillStart, backfillEnd, { athleteIds: [athleteId] })
    .then(r => console.log(`📥 Backfill ${name}: ${r.totalNew} activité(s) depuis ${backfillStart}`))
    .catch(e => console.error(`⚠️ Backfill ${name} échoué:`, e.message));
}

app.post('/api/athletes/register', async (req, res) => {
  try {
    const { athlete_id, name, email, password, strava_data, access_token, refresh_token, expires_at, league_id } = req.body;

    // league_id est facultatif depuis L42 : un compte peut exister sans ligue
    // et en rejoindre une ensuite avec son code (POST /api/leagues/join)
    if (!athlete_id || !name || !password || !email) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court' });
    }

    // L56 : le jeton envoyé par le navigateur doit appartenir à l'athlète
    // annoncé. Sans cette vérification, on pouvait créer un compte au nom de
    // n'importe quel identifiant Strava (visible sur son profil public).
    let stravaAthlete;
    try {
      const response = await axios.get(`${STRAVA_BASE_URL}/api/v3/athlete`, {
        headers: { Authorization: `Bearer ${access_token}` },
        timeout: 10000
      });
      stravaAthlete = response.data;
    } catch (error) {
      if (error.response?.status === 401) {
        return res.status(401).json({ error: 'Connexion Strava expirée : reconnecte-toi à Strava' });
      }
      console.error('Inscription : vérification Strava impossible:', error.message);
      return res.status(502).json({ error: 'Strava ne répond pas : réessaie dans un instant' });
    }
    if (!stravaAthlete?.id || normalizeId(stravaAthlete.id) !== normalizeId(athlete_id)) {
      console.warn(`⛔ Inscription refusée : le jeton Strava n'appartient pas à ${athlete_id}`);
      return res.status(403).json({ error: 'Ce compte Strava ne correspond pas' });
    }

    // Calculé avant la lecture du fichier : scrypt prend quelques dizaines de
    // millisecondes, on n'élargit pas l'intervalle entre lecture et écriture.
    const passwordScrypt = await hashPasswordScrypt(password);

    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const normalizedId = normalizeId(athlete_id);

    if (athletes.find(a => a.email?.toLowerCase() === email.toLowerCase())) {
      return res.status(400).json({ error: 'Email déjà utilisé' });
    }

    if (athletes.find(a => normalizeId(a.id) === normalizedId && a.league_id === league_id)) {
      return res.status(400).json({ error: 'Déjà inscrit' });
    }
    // Un seul compte par athlète Strava
    if (!league_id && athletes.find(a => normalizeId(a.id) === normalizedId)) {
      return res.status(400).json({ error: 'Compte déjà existant' });
    }

    athletes.push({
      id: normalizedId,
      name,
      email,
      password_hash: hashPassword(password),
      password_scrypt: passwordScrypt,
      league_id: league_id || null,
      strava_profile: strava_data,
      registered_at: new Date().toISOString(),
      tokens: { access_token, refresh_token, expires_at },
      active: true
    });

    await safeWriteJSON(ATHLETES_FILE, athletes);
    const token = await createSession(normalizedId);
    console.log(`✅ Athlète inscrit: ${name}`);

    // Règle globale : on n'écrit PAS active_from_round. Son absence signifie
    // « entre à la saison suivante » (cf. isAthleteInRound dans frozen-results).
    const { seasonNumber } = await getCurrentSeasonContext();

    if (league_id) await backfillNewParticipant(league_id, normalizedId, name);

    res.json({
      success: true,
      athlete_id: normalizedId,
      token,
      active_from_season: seasonNumber + 1
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur inscription' });
  }
});

app.get('/api/athletes/:leagueId', async (req, res) => {
  try {
    const athletes = await store.listParticipants(req.params.leagueId);
    // Route publique : pas d'e-mail (la page admin a sa propre route)
    const leagueAthletes = athletes
      .filter(a => a.active)
      .map(a => ({
        id: a.id,
        name: a.name,
        registered_at: a.registered_at,
        // Nécessaire au frontend pour appliquer la règle d'entrée en jeu
        active_from_round: a.active_from_round ?? null
      }));
    res.json(leagueAthletes);
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// JOKERS ROUTES - JOUEUR
// ============================================
// Routes joueur ici (server.js) — utilise safeReadJSON/safeWriteJSON
// Routes admin avancées dans jokers-routes.js (stock, reset par ligue, resolve)

// Récupérer TOUS les jokers utilisés (pour le tableau principal)
app.get('/api/jokers/all', async (req, res) => {
  try {
    const jokerUsage = await readJokerUsageWithFrozen();
    res.json(jokerUsage);
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer les jokers d'un round spécifique
app.get('/api/jokers/round/:roundNumber', async (req, res) => {
  try {
    const jokerUsage = await readJokerUsageWithFrozen();
    const roundJokers = jokerUsage.filter(j => j.round_number === parseInt(req.params.roundNumber) && j.status === 'active');
    res.json(roundJokers);
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer mes jokers (authentifié)
app.get('/api/jokers/my', requireAuth, async (req, res) => {
  try {
    const jokerUsage = await readJokerUsageWithFrozen();
    const myUsage = jokerUsage.filter(j => normalizeId(j.athlete_id) === normalizeId(req.athleteId));

    // Calculer le stock restant
    const stock = {};
    // Les admin_refund ajoutent +1 au stock (même formule que l'admin)
    JOKER_IDS.forEach(jokerId => {
      const entries = myUsage.filter(j => j.joker_id === jokerId);
      const refunds = entries.filter(j => j.status === 'admin_refund').length;
      const usedCount = entries.length - refunds;
      stock[jokerId] = Math.max(0, Math.min(5, INITIAL_JOKER_STOCK - usedCount + refunds));
    });

    res.json({ stock, used: myUsage });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Utiliser un joker
app.post('/api/jokers/use', requireAuth, async (req, res) => {
  try {
    const { joker_id, target_athlete_id, round_number, selected_day, activate_now } = req.body;
    // Bloquer les jokers "activate_now" (usage immédiat) si le round ciblé est no_bonus.
    // La règle no_bonus (configurée dans round_configs.json via le visualisateur admin)
    // désactive TOUT effet de joker/bonus sur ce round.
    if (activate_now === true && round_number != null) {
      try {
        const cfg = await roundConfigsModule.getRoundConfig(round_number);
        if (cfg?.specialRule === 'no_bonus') {
          return res.status(403).json({
            error: `Round ${round_number} : jokers désactivés (règle "sans bonus / D+ pur")`,
            round: round_number,
            reason: 'no_bonus_round'
          });
        }
      } catch (e) {
        console.warn('Impossible de vérifier round no_bonus pour joker:', e.message);
      }
    }

    if (!joker_id || round_number === undefined) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const athlete = athletes.find(a => normalizeId(a.id) === normalizeId(req.athleteId));

    // RÈGLE SAISON ÉQUIPES : le joker bouclier est interdit (la pire équipe est
    // éliminée en bloc, et permettre à un joueur de "sauver" sa place dans
    // l'équipe éliminée serait un avantage disproportionné).
    // Voleur, sabotage et multiplicateur restent autorisés (ciblent un joueur
    // spécifique, l'effet impacte l'équipe via la somme).
    try {
      const frozenData = await frozenResults.getAllFrozenResults();
      const targetRoundEntry = frozenData?.rounds?.[String(round_number)];
      let roundSeason = targetRoundEntry?.seasonNumber;

      // Si pas figé, déduire depuis le round figé précédent
      if (roundSeason == null) {
        for (let r = round_number - 1; r >= 1; r--) {
          const prev = frozenData?.rounds?.[String(r)];
          if (prev?.seasonNumber != null) {
            // Si saison terminée (1 actif restant, finale équipe, ou finale forcée
            // par le configurateur admin), on est dans la saison suivante
            const survivors = (prev.activeParticipants?.length || 0) - (prev.eliminations?.length || 0);
            const wasTeamFinal = prev.teamFinalRound === true;
            const wasConfigForcedFinale = prev.configForcedFinale === true;
            roundSeason = (survivors <= 1 || wasTeamFinal || wasConfigForcedFinale)
              ? Number(prev.seasonNumber) + 1
              : Number(prev.seasonNumber);
            break;
          }
        }
      }

      const { isTeamSeason } = require('./shared-config');
      if (roundSeason != null && isTeamSeason(roundSeason) && joker_id === 'bouclier') {
        return res.status(403).json({
          error: 'Le bouclier est désactivé en saison Équipes (toute l\'équipe est éliminée ou survit ensemble).'
        });
      }
    } catch (e) {
      console.warn('⚠️ Impossible de vérifier la saison team:', e.message);
    }

    // Vérifier si l'athlète est éliminé DANS LA SAISON COURANTE
    // (pas le droit d'utiliser un joker s'il est éliminé pour le round qu'il vise).
    // BUG fix: avant, on parcourait TOUS les rounds figés de toutes les saisons,
    // ce qui bloquait à tort un joueur éliminé en saison N qui revenait en saison N+1.
    try {
      const frozenData = await frozenResults.getAllFrozenResults();
      if (frozenData?.rounds) {
        const athleteId = normalizeId(req.athleteId);

        // Déterminer la saison du round visé.
        // On la lit en priorité sur le round figé correspondant ;
        // sinon on retombe sur un calcul (au cas où le round n'est pas encore figé).
        // Round pas encore figé : saison du dernier round figé, +1 si cette saison
        // est close (challenge des éliminés figé). La formule théorique à nombre
        // de rounds fixe rattachait le R52 (S9) à la S7 et bloquait les éliminés de S7.
        let targetSeason = null;
        const targetRoundEntry = frozenData.rounds[String(round_number)];
        if (targetRoundEntry?.seasonNumber != null) {
          targetSeason = Number(targetRoundEntry.seasonNumber);
        } else {
          const previous = Object.entries(frozenData.rounds)
            .filter(([k, r]) => r?.frozen && r.seasonNumber != null && Number(k) < Number(round_number))
            .sort((x, y) => Number(y[0]) - Number(x[0]))[0];
          if (previous) {
            const s = Number(previous[1].seasonNumber);
            targetSeason = frozenData.eliminatedChallengeRankings?.[String(s)] ? s + 1 : s;
          }
        }

        // Ne tester l'élimination QUE sur les rounds de la saison cible.
        // Si on ne sait pas dans quelle saison on est (cas dégénéré), on ne bloque pas.
        if (targetSeason != null) {
          for (const roundKey of Object.keys(frozenData.rounds)) {
            const round = frozenData.rounds[roundKey];
            if (!round) continue;
            if (Number(round.seasonNumber) !== targetSeason) continue;
            // On ne bloque que si l'élimination s'est produite AVANT (ou pendant)
            // le round visé : être éliminé au round 18 ne doit pas bloquer
            // une action sur le round 17 par exemple.
            if (Number(roundKey) > Number(round_number)) continue;
            if (round?.eliminations?.some(e => normalizeId(e.id) === athleteId)) {
              return res.status(403).json({ error: 'Les joueurs éliminés ne peuvent pas utiliser de jokers' });
            }
          }
        }
      }
    } catch (e) {
      console.warn('⚠️ Impossible de vérifier le statut éliminé:', e.message);
    }

    // Pré-calculer les rounds figés où cet athlète a utilisé ce joker
    // (dédoublonnés plus bas contre jokers_usage.json, comme readJokerUsageWithFrozen)
    const frozenUsageRounds = [];
    try {
      const frozenData = await frozenResults.getAllFrozenResults();
      if (frozenData?.rounds) {
        for (const [roundKey, roundData] of Object.entries(frozenData.rounds)) {
          const jokersUsed = roundData.jokersUsed || [];
          jokersUsed
            .filter(j => String(j.athleteId) === normalizeId(req.athleteId) && j.jokerId === joker_id)
            .forEach(() => frozenUsageRounds.push(parseInt(roundKey)));
        }
      }
    } catch (e) {}

    // Lecture-vérification-écriture atomique (pas de race condition)
    let resultUsage = null;
    let error = null;

    await safeModifyJSON(currentEdition().paths.jokers, (rawData) => {
      const jokerUsage = normalizeJokerUsage(rawData);
      const myUsage = jokerUsage.filter(j => normalizeId(j.athlete_id) === normalizeId(req.athleteId));
      const fileEntries = myUsage.filter(j => j.joker_id === joker_id);
      const refunds = fileEntries.filter(j => j.status === 'admin_refund').length;
      const frozenUsageCount = frozenUsageRounds.filter(
        r => !fileEntries.some(j => j.round_number === r)
      ).length;
      const totalUsedCount = (fileEntries.length - refunds) + frozenUsageCount;

      // Les admin_refund ajoutent +1 au stock (même formule que l'admin)
      if (Math.min(5, INITIAL_JOKER_STOCK - totalUsedCount + refunds) <= 0) {
        error = 'Plus de joker disponible';
        return jokerUsage; // Pas de modification
      }

      const usage = {
        id: `${req.athleteId}-${joker_id}-${Date.now()}`,
        athlete_id: normalizeId(req.athleteId),
        athlete_name: athlete?.name || 'Unknown',
        joker_id,
        target_athlete_id: target_athlete_id ? normalizeId(target_athlete_id) : null,
        target_athlete_name: null,
        selected_day: selected_day || null,
        activate_now: activate_now || false,
        round_number,
        used_at: new Date().toISOString(),
        status: 'active'
      };

      if (target_athlete_id) {
        const target = athletes.find(a => normalizeId(a.id) === normalizeId(target_athlete_id));
        usage.target_athlete_name = target?.name || 'Unknown';
      }

      jokerUsage.push(usage);
      resultUsage = usage;
      return jokerUsage;
    });

    if (error) {
      return res.status(400).json({ error });
    }

    console.log(`🃏 Joker ${joker_id} utilisé par ${athlete?.name} pour round ${round_number}`);
    res.json({ success: true, usage: resultUsage });
  } catch (error) {
    console.error('Erreur joker:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Admin: Reset tous les jokers
app.post('/api/admin/jokers/reset-all', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    await safeWriteJSON(currentEdition().paths.jokers, []);
    console.log('🃏 Tous les jokers réinitialisés');
    res.json({ success: true, message: 'Tous les jokers ont été réinitialisés' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Admin: Voir tous les jokers
app.get('/api/admin/jokers', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    const jokerUsage = await readJokerUsage();
    res.json({ count: jokerUsage.length, jokers: jokerUsage });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// ACTIVITIES ROUTES
// ============================================
app.get('/api/activities/:leagueId', async (req, res) => {
  try {
    const activitiesLeague = req.params.leagueId;
    const activities = await store.readActivities(activitiesLeague);
    res.json(activities);
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/activities-status/:leagueId', async (req, res) => {
  try {
    const activitiesMtime = await store.activitiesLastModified(req.params.leagueId);
    const activities = await store.readActivities(req.params.leagueId);

    let lastActivity = null;
    if (activities.length > 0) {
      const sorted = [...activities].sort((a, b) => new Date(b.synced_at || b.start_date) - new Date(a.synced_at || a.start_date));
      lastActivity = { id: sorted[0].id, name: sorted[0].name, athlete_name: sorted[0].athlete_name, synced_at: sorted[0].synced_at };
    }

    // Signature des résultats figés : ne bouge qu'au gel / dégel d'un round ou du
    // challenge éliminés (pas à l'écriture du snapshot du classement, qui touche
    // le même fichier). Le navigateur se recharge quand elle change.
    const frozen = await frozenResults.loadFrozenResultsRaw().catch(() => null);
    const frozenRounds = Object.entries(frozen?.rounds || {}).filter(([, r]) => r?.frozen);
    const lastFrozen = frozenRounds.sort((a, b) => Number(b[0]) - Number(a[0]))[0];
    const frozenSignature = [
      frozenRounds.length,
      lastFrozen?.[0] || 0,
      lastFrozen?.[1]?.frozenAt || '',
      Object.keys(frozen?.eliminatedChallengeRankings || {}).sort().join(',')
    ].join('|');

    res.json({ count: activities.length, lastModified: activitiesMtime?.toISOString() || null, lastActivity, frozenSignature });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// STRAVA TOKEN REFRESH
// ============================================
async function refreshStravaToken(athlete) {
  const refreshToken = athlete.tokens?.refresh_token;
  if (!refreshToken) return { success: false, reason: 'no_refresh_token' };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`   🔄 ${athlete.name}: refresh (${attempt}/3)...`);

      const response = await axios.post(`${STRAVA_BASE_URL}/oauth/token`, {
        client_id: STRAVA_CONFIG.clientId,
        client_secret: STRAVA_CONFIG.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }, { timeout: 10000 });

      console.log(`   ✅ ${athlete.name}: token rafraîchi`);
      return {
        success: true,
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token,
        expires_at: response.data.expires_at
      };
    } catch (error) {
      console.log(`   ⚠️ ${athlete.name}: tentative ${attempt} échouée`);
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  return { success: false, reason: 'refresh_failed' };
}

/**
 * Enregistre des tokens Strava rafraîchis sans réécrire le reste du fichier :
 * lecture, modification et écriture sous verrou, sur la version à jour.
 * Réécrire un tableau lu AVANT les appels à Strava effaçait les comptes créés
 * ou modifiés entre-temps (inscription, réinitialisation de mot de passe…).
 * @param {Map<string, Object>} updates - identifiant normalisé → tokens
 */
async function saveAthleteTokens(updates) {
  if (updates.size === 0) return;
  await safeModifyJSON(ATHLETES_FILE, accounts => {
    if (!Array.isArray(accounts)) throw new Error('athletes.json illisible');
    for (const account of accounts) {
      const tokens = updates.get(normalizeId(account.id));
      if (tokens) account.tokens = tokens;
    }
    return accounts;
  }, null);
}

async function refreshAllTokens() {
  console.log('🔄 Refresh préventif des tokens...');

  const athletes = await safeReadJSON(ATHLETES_FILE, []);
  const now = Date.now() / 1000;
  let refreshed = 0;
  const tokenUpdates = new Map();

  for (let i = 0; i < athletes.length; i++) {
    const athlete = athletes[i];
    if (!athlete.tokens?.refresh_token) continue;

    if (athlete.tokens.expires_at && athlete.tokens.expires_at < now + 7200) {
      const result = await refreshStravaToken(athlete);
      if (result.success) {
        athletes[i].tokens = {
          access_token: result.access_token,
          refresh_token: result.refresh_token,
          expires_at: result.expires_at
        };
        tokenUpdates.set(normalizeId(athlete.id), athletes[i].tokens);
        refreshed++;
      }
      await sleep(500); // Pause entre chaque refresh
    }
  }

  if (refreshed > 0) {
    await saveAthleteTokens(tokenUpdates);
    console.log(`   ✅ ${refreshed} tokens rafraîchis`);
  }
}

// ============================================
// ENRICHISSEMENT MÉTÉO
// ============================================
/**
 * Renseigne le champ `weather` des activités d'une ligue (règle "pluie qui mouille").
 *
 * Appelé après chaque sync et après chaque webhook, pour que la vue live du
 * classement dispose de la donnée sans que le frontend ait à taper une API météo.
 * Les activités déjà verrouillées (météo consolidée) sont ignorées : voir
 * weather.js pour la politique de verrouillage.
 *
 * Best-effort : une panne d'Open-Meteo ne doit jamais faire échouer un sync.
 * Budget de temps borné : sous rate limit Open-Meteo (429 → 60 s d'attente par
 * appel), l'enrichissement pouvait durer des heures et retarder d'autant le gel
 * de 00h15, qui l'attend. Ce qui dépasse est repris au passage suivant.
 *
 * Seules les activités des rounds « pluie qui mouille » (round_configs.json)
 * sont traitées : la météo ne sert qu'à cette règle. Sans round de ce type,
 * aucun appel à Open-Meteo.
 */
const WEATHER_BUDGET_MS = 3 * 60 * 1000;

async function getRainRuleRounds() {
  const configs = await roundConfigsModule.loadRoundConfigs();
  return new Set(Object.entries(configs || {})
    .filter(([, cfg]) => cfg?.specialRule === 'pluie_qui_mouille')
    .map(([round]) => Number(round)));
}

async function enrichLeagueWeather(leagueId, options = {}) {
  const activitiesLeague = leagueId;
  try {
    const rainRounds = await getRainRuleRounds();
    if (rainRounds.size === 0) return null;
    // Même rattachement que le calcul des rounds : heure de FIN de l'activité
    const inRainRound = a => rainRounds.has(getRoundNumberForDate(
      new Date(a.start_date).getTime() + (a.elapsed_time || 0) * 1000));

    const started = Date.now();
    const activities = await store.readActivities(activitiesLeague);
    const stats = await weather.enrichActivities(activities, { budgetMs: WEATHER_BUDGET_MS, filter: inRainRound, ...options });

    if (stats.changed) {
      await store.writeActivities(activitiesLeague, activities);
      console.log(
        `   🌦️ Météo: ${stats.processed} activité(s) traitée(s) — ` +
        `${stats.ok} ok, ${stats.rainy} avec pluie, ${stats.noGeo} sans GPS, ${stats.errors} erreur(s)` +
        `${stats.skipped ? `, ${stats.skipped} reportée(s) (budget atteint)` : ''} en ${Math.round((Date.now() - started) / 1000)} s`
      );
    }
    return stats;
  } catch (error) {
    console.error(`⚠️ Enrichissement météo ${leagueId} échoué:`, error.message);
    return null;
  }
}

// ============================================
// SYNC MANUAL - AVEC MISE À JOUR DES ACTIVITÉS
// ============================================
async function syncLeague(leagueId, startDate, endDate, options = {}) {
  // athleteIds : restreint le sync à ces athlètes (backfill d'un nouvel inscrit).
  const { updateExisting = true, athleteIds = null } = options;

  console.log(`🔄 Sync ${leagueId}: ${startDate} → ${endDate} (update=${updateExisting})`);

  const athletes = await safeReadJSON(ATHLETES_FILE, []);
  let leagueAthletes = (await store.listParticipants(leagueId)).filter(a => a.active);

  if (athleteIds) {
    const wanted = new Set(athleteIds.map(normalizeId));
    leagueAthletes = leagueAthletes.filter(a => wanted.has(normalizeId(a.id)));
    console.log(`   🎯 Restreint à ${leagueAthletes.length} athlète(s)`);
  }

  const activitiesLeague = leagueId;
  let activities = await store.readActivities(activitiesLeague);

  let totalNew = 0;
  let totalUpdated = 0;
  const errors = [];
  const tokenUpdates = new Map();

  for (let i = 0; i < leagueAthletes.length; i++) {
    const athlete = leagueAthletes[i];
    const athleteId = normalizeId(athlete.id);

    try {
      console.log(`   📥 ${athlete.name}...`);

      let accessToken = athlete.tokens?.access_token;
      if (!accessToken) {
        errors.push({ athlete: athlete.name, error: 'no_token' });
        continue;
      }

      // Refresh si nécessaire
      const now = Date.now() / 1000;
      if (athlete.tokens.expires_at && athlete.tokens.expires_at < now + 300) {
        const result = await refreshStravaToken(athlete);
        if (!result.success) {
          errors.push({ athlete: athlete.name, error: 'refresh_failed' });
          continue;
        }
        accessToken = result.access_token;
        // Écrire dans le tableau COMPLET par identité, pas par l'index de la
        // liste filtrée : les deux ne coïncident que si tous les athlètes du
        // fichier sont actifs et dans cette ligue. Sinon on écrasait les tokens
        // d'un autre joueur.
        const realIndex = athletes.findIndex(a => normalizeId(a.id) === athleteId);
        if (realIndex >= 0) {
          athletes[realIndex].tokens = { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: result.expires_at };
          tokenUpdates.set(athleteId, athletes[realIndex].tokens);
        }
      }

      const afterTs = Math.floor(new Date(startDate).getTime() / 1000);
      const beforeTs = Math.floor(new Date(endDate).getTime() / 1000) + 86400;

      const response = await axios.get(`${STRAVA_BASE_URL}/api/v3/athlete/activities`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { after: afterTs, before: beforeTs, per_page: 200 },
        timeout: 20000
      });

      // Utilise VALID_SPORTS importé de shared-config
      let newCount = 0;
      let updatedCount = 0;

      for (const act of response.data) {
        if (!VALID_SPORTS.includes(act.sport_type) && !VALID_SPORTS.includes(act.type)) continue;

        const existingIndex = activities.findIndex(a => a.id === act.id);

        if (existingIndex >= 0) {
          // L'activité existe déjà - vérifier si elle a changé
          if (updateExisting) {
            const existing = activities[existingIndex];
            const hasChanged =
              existing.total_elevation_gain !== act.total_elevation_gain ||
              existing.distance !== act.distance ||
              existing.moving_time !== act.moving_time ||
              existing.name !== act.name;

            if (hasChanged) {
              console.log(`      🔄 MAJ: ${act.name} (D+ ${existing.total_elevation_gain}→${act.total_elevation_gain}m)`);

              // Préserver certains champs locaux (excluded, etc.)
              const localFields = {
                excluded: existing.excluded,
                excluded_reason: existing.excluded_reason,
                excluded_at: existing.excluded_at,
                source: existing.source,
                synced_at: existing.synced_at
              };

              activities[existingIndex] = {
                ...act,
                athlete: { id: athleteId, resource_state: 1 },
                athlete_id: athleteId,
                athlete_name: athlete.name,
                ...localFields,
                updated_at: new Date().toISOString(),
                update_source: 'sync'
              };

              updatedCount++;
              totalUpdated++;
            }
          }
          continue;
        }

        // Nouvelle activité
        activities.push({
          ...act,
          athlete: { id: athleteId, resource_state: 1 },
          athlete_id: athleteId,
          athlete_name: athlete.name,
          synced_at: new Date().toISOString(),
          source: 'sync'
        });
        newCount++;
        totalNew++;
      }

      console.log(`      ✓ ${newCount} nouvelles, ${updatedCount} mises à jour`);
      await sleep(300); // Pause entre chaque athlète

    } catch (error) {
      errors.push({ athlete: athlete.name, error: error.message });
    }
  }

  await saveAthleteTokens(tokenUpdates);
  await store.writeActivities(activitiesLeague, activities);

  console.log(`   ✅ Total: ${totalNew} nouvelles, ${totalUpdated} mises à jour`);

  // Météo des activités nouvelles ou pas encore consolidées
  await enrichLeagueWeather(leagueId);

  scheduleStandingsRefresh(`synchro ${leagueId}`);
  return { success: true, totalNew, totalUpdated, errors };
}

app.post('/api/sync/:leagueId', async (req, res) => {
  // Réservé à l'admin : une synchro interroge Strava pour chaque athlète et
  // consomme le quota d'appels de l'application.
  if (!checkAdmin(req, res)) return;
  try {
    const start = req.body.startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const end = req.body.endDate || new Date().toISOString().split('T')[0];
    // athleteIds (optionnel) : ne resynchroniser que ces athlètes. Permet de
    // rattraper un nouvel inscrit sans toucher aux activités des autres.
    // updateExisting: false pour n'AJOUTER que les activités manquantes.
    const result = await syncLeague(req.params.leagueId, start, end, {
      athleteIds: Array.isArray(req.body.athleteIds) ? req.body.athleteIds : null,
      updateExisting: req.body.updateExisting !== false
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Erreur sync' });
  }
});

// ============================================
// ÉDITIONS EN COURS (L33)
// ============================================
const EDITION_GRACE_DAYS = 14; // après la fin : dernier gel, challenge des éliminés

/**
 * Éditions traitées par les tâches planifiées : l'édition par défaut, toujours
 * (comme avant L33), et les autres une fois commencées, jusqu'à 14 jours après
 * leur fin.
 */
async function activeEditions(now = new Date()) {
  const today = now.toISOString().split('T')[0];
  const editions = [];
  for (const league of await store.listLeagues()) {
    for (const edition of await store.listLeagueEditions(league.id)) {
      const graceEnd = edition.endDate
        ? new Date(new Date(`${edition.endDate}T00:00:00Z`).getTime() + EDITION_GRACE_DAYS * 86400000).toISOString().split('T')[0]
        : null;
      const isDefault = edition.key === DEFAULT_EDITION.legacyId;
      const started = !edition.startDate || edition.startDate <= today;
      const notOver = !graceEnd || today <= graceEnd;
      if (isDefault || (started && notOver)) editions.push(edition);
    }
  }
  return editions;
}

/** Exécute fn pour chaque édition en cours, dans son contexte ; une erreur n'arrête pas les autres. */
async function forEachActiveEdition(label, fn) {
  for (const edition of await activeEditions()) {
    try {
      const context = await store.editionContext(edition.key);
      if (!context) continue;
      await withEdition(context, () => fn(edition));
    } catch (error) {
      console.error(`❌ [${edition.key}] ${label} :`, error.message);
    }
  }
}

async function autoSyncAllLeagues() {
  console.log('🔄 Sync automatique...');
  await refreshAllTokens();

  const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const end = new Date().toISOString().split('T')[0];

  // Une synchro par édition en cours. Un joueur inscrit à deux éditions qui se
  // chevauchent (lancement anticipé) est interrogé deux fois : à regrouper par
  // compte avec la gestion du quota d'API (L60).
  await forEachActiveEdition('synchro', edition => syncLeague(edition.key, start, end));

  console.log('✅ Sync automatique terminée');
}

// ============================================
// WEBHOOK STRAVA - AMÉLIORÉ
// ============================================
const webhookQueue = [];
let processingQueue = false;

app.get('/api/webhook/strava', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  console.log(`🔔 Validation webhook: mode=${mode}`);

  if (mode === 'subscribe' && token === STRAVA_VERIFY_TOKEN) {
    console.log('✅ Webhook validé');
    res.json({ 'hub.challenge': challenge });
  } else {
    res.status(403).send('Forbidden');
  }
});

app.post('/api/webhook/strava', (req, res) => {
  const event = req.body;
  console.log(`🔔 Webhook: ${event.object_type}:${event.aspect_type} owner=${event.owner_id} obj=${event.object_id}`);

  // Répondre immédiatement
  res.status(200).send('OK');

  // Ajouter à la queue avec timestamp
  webhookQueue.push({ ...event, received_at: Date.now() });

  // Traiter la queue
  if (!processingQueue) {
    processWebhookQueue();
  }
});

async function processWebhookQueue() {
  if (processingQueue) return;
  processingQueue = true;

  while (webhookQueue.length > 0) {
    const event = webhookQueue.shift();

    try {
      await processOneWebhook(event);
    } catch (error) {
      console.error(`❌ Webhook error: ${error.message}`);
      await logWebhook(event, 'error', { error: error.message });
    }

    // IMPORTANT: Pause de 2 secondes entre chaque webhook
    await sleep(2000);
  }

  processingQueue = false;
}

/**
 * L'activité existe-t-elle encore sur Strava ? Interrogé avec le token de son
 * propriétaire, rafraîchi si besoin.
 * @returns {Promise<'exists'|'gone'|'unknown'>} 'gone' = Strava répond 404 ;
 *   'unknown' = pas de token, rafraîchissement impossible, autre erreur.
 */
async function checkActivityOnStrava(athletes, athleteIndex, objectId) {
  const athlete = athletes[athleteIndex];
  let accessToken = athlete.tokens?.access_token;
  if (!accessToken) return 'unknown';

  const now = Date.now() / 1000;
  if (athlete.tokens.expires_at && athlete.tokens.expires_at < now + 60) {
    const result = await refreshStravaToken(athlete);
    if (!result.success) return 'unknown';
    accessToken = result.access_token;
    athletes[athleteIndex].tokens = { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: result.expires_at };
    await saveAthleteTokens(new Map([[normalizeId(athletes[athleteIndex].id), athletes[athleteIndex].tokens]]));
  }

  try {
    await axios.get(
      `${STRAVA_BASE_URL}/api/v3/activities/${objectId}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 20000 }
    );
    return 'exists';
  } catch (error) {
    return error.response?.status === 404 ? 'gone' : 'unknown';
  }
}

function activityOwnerId(activity) {
  return normalizeId(activity.athlete_id ?? activity.athlete?.id);
}

/** Édition qui reçoit les activités d'un athlète par webhook (cf. processOneWebhook). */
async function webhookEditionKey(athlete) {
  if (athlete.league_id && await store.resolveEdition(athlete.league_id)) return athlete.league_id;
  const mine = [];
  for (const edition of await activeEditions()) {
    const participants = await store.listParticipants(edition.key);
    if (participants.some(p => normalizeId(p.id) === normalizeId(athlete.id))) mine.push(edition);
  }
  return mine.length ? mine[mine.length - 1].key : null;
}

/** Recalcul du classement de chaque édition en cours où l'athlète joue. */
async function scheduleRefreshForAthlete(athleteId, reason) {
  await forEachActiveEdition('classement', async edition => {
    const participants = await store.listParticipants(edition.key);
    if (participants.some(p => normalizeId(p.id) === normalizeId(athleteId))) scheduleStandingsRefresh(reason);
  });
}

async function processOneWebhook(event) {
  const ownerId = normalizeId(event.owner_id);
  const objectId = event.object_id;

  console.log(`   📋 Traitement: owner=${ownerId} object=${objectId}`);

  // Événement d'un autre abonnement que le nôtre : forgé ou périmé
  if (STRAVA_SUBSCRIPTION_ID && String(event.subscription_id) !== STRAVA_SUBSCRIPTION_ID) {
    console.log(`   → Ignoré (abonnement ${event.subscription_id} inconnu)`);
    await logWebhook(event, 'ignored', { reason: 'unknown_subscription' });
    return;
  }

  if (event.object_type !== 'activity') {
    // L'athlète a retiré l'accès de Versant dans ses réglages Strava :
    // journalisé ici, traité avec la gestion du quota d'athlètes.
    if (event.object_type === 'athlete' && event.updates?.authorized === 'false') {
      console.log(`   → Accès Strava retiré par l'athlète ${ownerId}`);
      await logWebhook(event, 'deauthorized', {});
      return;
    }
    console.log(`   → Ignoré (type: ${event.object_type})`);
    await logWebhook(event, 'ignored', { reason: 'not_activity' });
    return;
  }

  const athletes = await safeReadJSON(ATHLETES_FILE, []);
  const athleteIndex = athletes.findIndex(a => normalizeId(a.id) === ownerId);

  if (athleteIndex < 0) {
    console.log(`   → Ignoré (athlète ${ownerId} non inscrit)`);
    await logWebhook(event, 'ignored', { reason: 'athlete_not_found' });
    return;
  }

  const athlete = athletes[athleteIndex];
  // Édition dont la vue reçoit l'activité (L33) : celle de la fiche (league_id,
  // versant/2026), sinon la plus récente édition en cours dont l'athlète est
  // participant. En organisation editions, l'activité est rangée une seule fois
  // chez l'athlète : toutes ses éditions la voient.
  const leagueId = await webhookEditionKey(athlete);
  if (!leagueId) {
    console.log('   → Ignoré (athlète sans édition en cours)');
    await logWebhook(event, 'ignored', { reason: 'no_edition' });
    return;
  }
  const activitiesLeague = leagueId;

  console.log(`   → Athlète: ${athlete.name}`);

  if (event.aspect_type === 'create') {
    let accessToken = athlete.tokens?.access_token;

    if (!accessToken) {
      console.log(`   ❌ Pas de token`);
      await logWebhook(event, 'failed', { reason: 'no_token' });
      await saveFailedWebhook(event, 'no_token');
      return;
    }

    // Refresh si expiré
    const now = Date.now() / 1000;
    if (athlete.tokens.expires_at && athlete.tokens.expires_at < now + 60) {
      console.log(`   🔄 Token expiré, refresh...`);

      const result = await refreshStravaToken(athlete);
      if (!result.success) {
        console.log(`   ❌ Refresh échoué`);
        await logWebhook(event, 'failed', { reason: 'refresh_failed' });
        await saveFailedWebhook(event, 'refresh_failed');
        return;
      }

      accessToken = result.access_token;
      athletes[athleteIndex].tokens = { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: result.expires_at };
      await saveAthleteTokens(new Map([[normalizeId(athletes[athleteIndex].id), athletes[athleteIndex].tokens]]));
    }

    // Fetch activité avec retry et délais
    let stravaActivity = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`   🌐 Fetch (${attempt}/3)...`);

        // Attendre un peu avant chaque tentative (Strava peut avoir un délai)
        if (attempt > 1) await sleep(3000);

        const response = await axios.get(
          `${STRAVA_BASE_URL}/api/v3/activities/${objectId}`,
          { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 20000 }
        );

        stravaActivity = response.data;
        console.log(`   ✓ Récupéré: ${stravaActivity.name}`);
        break;
      } catch (error) {
        const msg = error.response?.status === 404 ? 'Activity not found' : error.message;
        console.log(`   ⚠️ Tentative ${attempt}: ${msg}`);

        // Si 404, l'activité n'existe peut-être pas encore côté Strava
        if (error.response?.status === 404 && attempt < 3) {
          console.log(`   ⏳ Attente 5s avant retry...`);
          await sleep(5000);
        }
      }
    }

    if (!stravaActivity) {
      console.log(`   ❌ Impossible de récupérer l'activité`);
      await logWebhook(event, 'failed', { reason: 'fetch_failed' });
      await saveFailedWebhook(event, 'fetch_failed');
      return;
    }

    // L'activité renvoyée par Strava doit appartenir à l'émetteur de l'événement
    if (stravaActivity.athlete?.id != null && normalizeId(stravaActivity.athlete.id) !== ownerId) {
      console.log(`   → Ignoré (activité d'un autre athlète)`);
      await logWebhook(event, 'ignored', { reason: 'owner_mismatch' });
      return;
    }

    // Utilise VALID_SPORTS importé de shared-config
    const actType = stravaActivity.sport_type || stravaActivity.type;

    if (!VALID_SPORTS.includes(actType)) {
      console.log(`   → Ignoré (type: ${actType})`);
      await logWebhook(event, 'ignored', { reason: 'invalid_type', type: actType });
      return;
    }

    let activities = await store.readActivities(activitiesLeague);

    if (activities.find(a => a.id === stravaActivity.id)) {
      console.log(`   → Doublon`);
      await logWebhook(event, 'duplicate', {});
      return;
    }

    activities.push({
      id: stravaActivity.id,
      athlete: { id: ownerId, resource_state: 1 },
      athlete_id: ownerId,
      athlete_name: athlete.name,
      name: stravaActivity.name,
      type: stravaActivity.type,
      sport_type: stravaActivity.sport_type || stravaActivity.type,
      distance: stravaActivity.distance,
      moving_time: stravaActivity.moving_time,
      elapsed_time: stravaActivity.elapsed_time,
      total_elevation_gain: stravaActivity.total_elevation_gain,
      start_date: stravaActivity.start_date,
      start_date_local: stravaActivity.start_date_local,
      // Champs supplémentaires utiles (carte, localisation, vitesse, fréquence cardiaque...)
      // → sans ça, les webhooks créaient des activités sans polyline ni géoloc.
      map: stravaActivity.map || null,
      start_latlng: stravaActivity.start_latlng || null,
      end_latlng: stravaActivity.end_latlng || null,
      average_speed: stravaActivity.average_speed,
      max_speed: stravaActivity.max_speed,
      average_heartrate: stravaActivity.average_heartrate,
      max_heartrate: stravaActivity.max_heartrate,
      has_heartrate: stravaActivity.has_heartrate,
      elev_high: stravaActivity.elev_high,
      elev_low: stravaActivity.elev_low,
      trainer: stravaActivity.trainer,
      manual: stravaActivity.manual,
      commute: stravaActivity.commute,
      timezone: stravaActivity.timezone,
      utc_offset: stravaActivity.utc_offset,
      location_city: stravaActivity.location_city,
      location_state: stravaActivity.location_state,
      location_country: stravaActivity.location_country,
      synced_at: new Date().toISOString(),
      source: 'webhook'
    });

    await store.writeActivities(activitiesLeague, activities);

    // Météo de la nouvelle activité (best-effort, ne bloque pas le webhook)
    await enrichLeagueWeather(leagueId);

    console.log(`   ✅ Ajouté: ${stravaActivity.name} (+${stravaActivity.total_elevation_gain}m)`);
    await logWebhook(event, 'success', { name: stravaActivity.name, elevation: stravaActivity.total_elevation_gain });
    await scheduleRefreshForAthlete(ownerId, 'webhook Strava');

  } else if (event.aspect_type === 'delete') {
    // Une activité n'est retirée que si elle appartient à l'émetteur de
    // l'événement et que Strava confirme qu'elle n'existe plus : un événement
    // forgé ne peut rien supprimer.
    const target = (await store.readActivities(activitiesLeague)).find(a => a.id === objectId);
    if (!target) return;

    if (activityOwnerId(target) !== ownerId) {
      console.log(`   → Ignoré (activité d'un autre athlète)`);
      await logWebhook(event, 'ignored', { reason: 'owner_mismatch' });
      return;
    }

    const onStrava = await checkActivityOnStrava(athletes, athleteIndex, objectId);
    if (onStrava === 'exists') {
      console.log(`   → Ignoré (activité toujours présente sur Strava)`);
      await logWebhook(event, 'ignored', { reason: 'still_on_strava' });
      return;
    }
    if (onStrava !== 'gone') {
      console.log(`   ❌ Suppression non vérifiable auprès de Strava`);
      await logWebhook(event, 'failed', { reason: 'delete_unverified' });
      await saveFailedWebhook(event, 'delete_unverified');
      return;
    }

    let activities = await store.readActivities(activitiesLeague);
    const before = activities.length;
    activities = activities.filter(a => a.id !== objectId);

    if (activities.length < before) {
      await store.writeActivities(activitiesLeague, activities);
      console.log(`   🗑️ Supprimé`);
      await logWebhook(event, 'deleted', {});
      await scheduleRefreshForAthlete(ownerId, 'webhook Strava');
    }
  } else if (event.aspect_type === 'update') {
    // Activité modifiée sur Strava - la mettre à jour localement
    let activities = await store.readActivities(activitiesLeague);
    const existingIndex = activities.findIndex(a => a.id === objectId);

    if (existingIndex < 0) {
      console.log(`   → Activité ${objectId} non trouvée localement, ignorée`);
      await logWebhook(event, 'ignored', { reason: 'activity_not_found' });
      return;
    }

    if (activityOwnerId(activities[existingIndex]) !== ownerId) {
      console.log(`   → Ignoré (activité d'un autre athlète)`);
      await logWebhook(event, 'ignored', { reason: 'owner_mismatch' });
      return;
    }

    // Récupérer les nouvelles données depuis Strava
    let accessToken = athlete.tokens?.access_token;

    if (!accessToken) {
      console.log(`   ❌ Pas de token pour update`);
      await logWebhook(event, 'failed', { reason: 'no_token' });
      return;
    }

    // Refresh si expiré
    const now = Date.now() / 1000;
    if (athlete.tokens.expires_at && athlete.tokens.expires_at < now + 60) {
      const result = await refreshStravaToken(athlete);
      if (!result.success) {
        console.log(`   ❌ Refresh échoué pour update`);
        await logWebhook(event, 'failed', { reason: 'refresh_failed' });
        return;
      }
      accessToken = result.access_token;
      athletes[athleteIndex].tokens = { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: result.expires_at };
      await saveAthleteTokens(new Map([[normalizeId(athletes[athleteIndex].id), athletes[athleteIndex].tokens]]));
    }

    try {
      console.log(`   🌐 Fetch update...`);
      const response = await axios.get(
        `${STRAVA_BASE_URL}/api/v3/activities/${objectId}`,
        { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 20000 }
      );

      const stravaActivity = response.data;
      const existing = activities[existingIndex];

      // Log les changements
      const changes = [];
      if (existing.total_elevation_gain !== stravaActivity.total_elevation_gain) {
        changes.push(`D+: ${existing.total_elevation_gain}→${stravaActivity.total_elevation_gain}m`);
      }
      if (existing.distance !== stravaActivity.distance) {
        changes.push(`Dist: ${(existing.distance/1000).toFixed(1)}→${(stravaActivity.distance/1000).toFixed(1)}km`);
      }
      if (existing.name !== stravaActivity.name) {
        changes.push(`Nom: "${existing.name}"→"${stravaActivity.name}"`);
      }

      if (changes.length === 0) {
        console.log(`   → Pas de changement pertinent`);
        await logWebhook(event, 'no_change', {});
        return;
      }

      // Préserver les champs locaux
      const localFields = {
        excluded: existing.excluded,
        excluded_reason: existing.excluded_reason,
        excluded_at: existing.excluded_at,
        source: existing.source,
        synced_at: existing.synced_at
      };

      // Mettre à jour
      activities[existingIndex] = {
        id: stravaActivity.id,
        athlete: { id: ownerId, resource_state: 1 },
        athlete_id: ownerId,
        athlete_name: athlete.name,
        name: stravaActivity.name,
        type: stravaActivity.type,
        sport_type: stravaActivity.sport_type || stravaActivity.type,
        distance: stravaActivity.distance,
        moving_time: stravaActivity.moving_time,
        elapsed_time: stravaActivity.elapsed_time,
        total_elevation_gain: stravaActivity.total_elevation_gain,
        start_date: stravaActivity.start_date,
        start_date_local: stravaActivity.start_date_local,
        // Champs supplémentaires (carte, localisation, vitesse, fréquence cardiaque...)
        map: stravaActivity.map || null,
        start_latlng: stravaActivity.start_latlng || null,
        end_latlng: stravaActivity.end_latlng || null,
        average_speed: stravaActivity.average_speed,
        max_speed: stravaActivity.max_speed,
        average_heartrate: stravaActivity.average_heartrate,
        max_heartrate: stravaActivity.max_heartrate,
        has_heartrate: stravaActivity.has_heartrate,
        elev_high: stravaActivity.elev_high,
        elev_low: stravaActivity.elev_low,
        trainer: stravaActivity.trainer,
        manual: stravaActivity.manual,
        commute: stravaActivity.commute,
        timezone: stravaActivity.timezone,
        utc_offset: stravaActivity.utc_offset,
        location_city: stravaActivity.location_city,
        location_state: stravaActivity.location_state,
        location_country: stravaActivity.location_country,
        ...localFields,
        updated_at: new Date().toISOString(),
        update_source: 'webhook'
      };

      await store.writeActivities(activitiesLeague, activities);

      console.log(`   🔄 MAJ: ${changes.join(', ')}`);
      await logWebhook(event, 'updated', { changes, name: stravaActivity.name });
      await scheduleRefreshForAthlete(ownerId, 'webhook Strava');

    } catch (error) {
      console.log(`   ❌ Erreur fetch update: ${error.message}`);
      await logWebhook(event, 'failed', { reason: 'fetch_failed', error: error.message });
    }
  }
}

async function saveFailedWebhook(event, reason) {
  const failed = await safeReadJSON(FAILED_WEBHOOKS_FILE, []);
  const existing = failed.find(f => f.event.object_id === event.object_id);

  if (existing) {
    existing.retry_count++;
    existing.last_reason = reason;
    existing.last_attempt = new Date().toISOString();
  } else {
    failed.push({
      event,
      reason,
      failed_at: new Date().toISOString(),
      last_attempt: new Date().toISOString(),
      retry_count: 0
    });
  }

  await safeWriteJSON(FAILED_WEBHOOKS_FILE, failed);
}

async function retryFailedWebhooks() {
  console.log('🔄 Retry webhooks échoués...');

  const failed = await safeReadJSON(FAILED_WEBHOOKS_FILE, []);
  if (failed.length === 0) {
    console.log('   ✅ Aucun webhook en échec');
    return;
  }

  console.log(`   📋 ${failed.length} à retenter`);
  const stillFailed = [];

  for (const item of failed) {
    if (item.retry_count >= 5) continue;

    try {
      await processOneWebhook(item.event);
      console.log(`   ✅ Réussi: ${item.event.object_id}`);
    } catch (error) {
      item.retry_count++;
      item.last_attempt = new Date().toISOString();
      stillFailed.push(item);
    }

    await sleep(2000);
  }

  await safeWriteJSON(FAILED_WEBHOOKS_FILE, stillFailed);
}

// ============================================
// ADMIN ROUTES
// ============================================
app.post('/api/admin/login', (req, res) => {
  if (ADMIN_PASSWORD && req.body.password === ADMIN_PASSWORD) {
    res.json({ success: true, token: generateToken() });
  } else {
    res.status(401).json({ error: 'Mot de passe incorrect' });
  }
});

app.get('/api/admin/webhooks/log', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const logs = await safeReadJSON(WEBHOOK_LOG_FILE, []);
  res.json({ count: logs.length, logs: logs.slice(0, 100) });
});

app.get('/api/admin/webhooks/failed', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const failed = await safeReadJSON(FAILED_WEBHOOKS_FILE, []);
  res.json({ count: failed.length, webhooks: failed });
});

app.post('/api/admin/webhooks/retry', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  await retryFailedWebhooks();
  const failed = await safeReadJSON(FAILED_WEBHOOKS_FILE, []);
  res.json({ message: 'Retry effectué', remaining: failed.length });
});

app.post('/api/admin/webhooks/clear', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  await safeWriteJSON(WEBHOOK_LOG_FILE, []);
  await safeWriteJSON(FAILED_WEBHOOKS_FILE, []);
  res.json({ message: 'Logs effacés' });
});

app.get('/api/admin/strava/status', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const response = await axios.get(`${STRAVA_BASE_URL}/api/v3/push_subscriptions`, {
      params: { client_id: STRAVA_CONFIG.clientId, client_secret: STRAVA_CONFIG.clientSecret }
    });
    res.json({ active: response.data.length > 0, subscriptions: response.data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/strava/subscribe', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const check = await axios.get(`${STRAVA_BASE_URL}/api/v3/push_subscriptions`, {
      params: { client_id: STRAVA_CONFIG.clientId, client_secret: STRAVA_CONFIG.clientSecret }
    });

    if (check.data.length > 0) {
      return res.json({ message: 'Déjà abonné', subscription: check.data[0] });
    }

    const response = await axios.post(`${STRAVA_BASE_URL}/api/v3/push_subscriptions`, {
      client_id: STRAVA_CONFIG.clientId,
      client_secret: STRAVA_CONFIG.clientSecret,
      callback_url: 'https://versant-app.fr/api/webhook/strava',
      verify_token: STRAVA_VERIFY_TOKEN
    });

    res.json({ message: 'Abonnement créé', subscription: response.data });
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.post('/api/admin/tokens/refresh-all', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  await refreshAllTokens();
  res.json({ message: 'Tokens rafraîchis' });
});

app.get('/api/admin/diagnostic', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  const athletes = await safeReadJSON(ATHLETES_FILE, []);
  const webhookLogs = await safeReadJSON(WEBHOOK_LOG_FILE, []);
  const failedWebhooks = await safeReadJSON(FAILED_WEBHOOKS_FILE, []);
  const jokers = await readJokerUsage();

  const now = Date.now() / 1000;
  const last24h = Date.now() - 24 * 60 * 60 * 1000;
  const recentLogs = webhookLogs.filter(l => new Date(l.timestamp).getTime() > last24h);

  res.json({
    timestamp: new Date().toISOString(),
    athletes: {
      total: athletes.length,
      withToken: athletes.filter(a => a.tokens?.access_token).length,
      expired: athletes.filter(a => a.tokens?.expires_at && a.tokens.expires_at < now).length,
      // Migration des mots de passe (cf. hashPassword) : comptes encore sans hash
      // scrypt, à reconnecter ou réinitialiser avant de supprimer l'ancien hash.
      passwordScrypt: athletes.filter(a => a.password_scrypt).length,
      passwordLegacyOnly: athletes.filter(a => a.password_hash && !a.password_scrypt).length
    },
    webhooks: {
      last24h: recentLogs.length,
      success: recentLogs.filter(l => l.status === 'success').length,
      failed: recentLogs.filter(l => l.status === 'failed').length,
      pendingRetry: failedWebhooks.length
    },
    jokers: {
      totalUsed: jokers.length
    },
    recentWebhooks: webhookLogs.slice(0, 20)
  });
});

// Export sans secrets : ni hash de mot de passe, ni tokens Strava, ni jeton de
// réinitialisation. La sauvegarde complète des données se fait côté serveur.
const ATHLETE_SECRET_FIELDS = ['password_hash', 'password_scrypt', 'tokens', 'reset_token', 'reset_expires'];

app.get('/api/admin/athletes/download', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const athletes = await safeReadJSON(ATHLETES_FILE, []);
  const exported = athletes.map(a =>
    Object.fromEntries(Object.entries(a).filter(([key]) => !ATHLETE_SECRET_FIELDS.includes(key)))
  );
  res.setHeader('Content-Disposition', 'attachment; filename=athletes.json');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(exported, null, 2));
});

// Liste admin des athlètes d'une ligue, avec les e-mails. Déclarée APRÈS
// /download : sinon « download » serait pris pour un identifiant de ligue.
app.get('/api/admin/athletes/:leagueId', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const athletes = await store.listParticipants(req.params.leagueId);
    res.json(athletes
      .filter(a => a.active)
      .map(a => ({
        id: a.id,
        name: a.name,
        email: a.email,
        registered_at: a.registered_at,
        active_from_round: a.active_from_round ?? null
      })));
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/activities/:leagueId/download', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = await store.exportActivities(req.params.leagueId);
    res.setHeader('Content-Disposition', `attachment; filename=${req.params.leagueId}_activities.json`);
    res.send(data);
  } catch {
    res.status(404).json({ error: 'Fichier non trouvé' });
  }
});

// ============================================
// EXCLUSION D'ACTIVITÉS
// ============================================

// Exclure/réintégrer une activité
app.post('/api/admin/activities/:leagueId/:activityId/exclude', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    const { leagueId, activityId } = req.params;
    const { exclude } = req.body;

    const activitiesLeague = leagueId;
    let activities = await store.readActivities(activitiesLeague);

    const activityIndex = activities.findIndex(a => String(a.id) === String(activityId));
    if (activityIndex < 0) {
      return res.status(404).json({ error: 'Activité non trouvée' });
    }

    activities[activityIndex].excluded = exclude;
    activities[activityIndex].excluded_at = exclude ? new Date().toISOString() : null;
    activities[activityIndex].excluded_reason = exclude ? 'Exclu par admin' : null;

    await store.writeActivities(activitiesLeague, activities);

    console.log(`${exclude ? '🚫' : '↩️'} Activité ${activityId} ${exclude ? 'exclue' : 'réintégrée'}`);

    res.json({
      success: true,
      activity_id: activityId,
      excluded: exclude,
      activity: activities[activityIndex]
    });
  } catch (error) {
    console.error('Erreur exclusion activité:', error);
    res.status(500).json({ error: error.message });
  }
});



// ============================================
// FROZEN RESULTS ROUTES
// ============================================

// Récupérer tous les résultats figés
app.get('/api/frozen-results', async (req, res) => {
  try {
    const results = await frozenResults.getAllFrozenResults();
    res.json(results);
  } catch (error) {
    console.error('Erreur frozen-results:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/** Forme stockée du classement annuel (yearlyStandingsSnapshot), calculé par le serveur (L22). */
function compactStandings(standings) {
    // Normaliser : ne stocker que les champs utiles (anti-bloat)
    const compact = standings.map(s => ({
      id: String(s.participant?.id ?? s.id),
      name: s.participant?.name ?? s.name,
      totalMainPoints: s.totalMainPoints || 0,
      totalEliminatedPoints: s.totalEliminatedPoints || 0,
      totalRescapePoints: s.totalRescapePoints || 0,
      totalGaugePoints: s.totalGaugePoints || 0,
      totalBonusPoints: s.totalBonusPoints || 0,
      totalPoints: s.totalPoints || 0,
      wins: s.wins || 0,
      seasonsPlayed: s.seasonsPlayed || 0
    })).filter(s => s.id && s.id !== 'undefined');
    return compact;
}

async function saveYearlyStandingsSnapshot(compact) {
    const data = await frozenResults.getAllFrozenResults();
    const fullData = (await frozenResults.loadFrozenResultsRaw?.()) || data;
    fullData.yearlyStandingsSnapshot = {
      updatedAt: new Date().toISOString(),
      standings: compact
    };
    await frozenResults.saveFrozenResultsRaw?.(fullData);
}

// ============================================
// CLASSEMENT ANNUEL CALCULÉ PAR LE SERVEUR (L22)
// ============================================
// Le moteur du front tourne côté serveur (engine-runner.js) : le classement ne
// dépend plus du code, éventuellement en cache, d'un navigateur. Il est
// recalculé après chaque écriture qui peut le changer (gel, synchro, webhook,
// action de jeu ou d'admin), en différé pour regrouper les déclenchements.
const engineRunner = require('./engine-runner');
const STANDINGS_REFRESH_DELAY_MS = 10000;
const standingsRefreshTimers = new Map(); // un recalcul différé par édition
let standingsRefreshChain = Promise.resolve();

/** Édition de l'appel en cours : null pour l'édition par défaut (chemin inchangé). */
function internalEdition() {
  const context = currentEdition();
  return context === LEGACY_CONTEXT ? null : { key: context.leagueId, token: INTERNAL_TOKEN };
}

function localApiBase() {
  return `http://127.0.0.1:${PORT}`;
}

/** Recalcule et enregistre le classement annuel. Les recalculs s'enchaînent, jamais en parallèle. */
function refreshYearlyStandings(reason) {
  const run = async () => {
    const started = Date.now();
    const edition = internalEdition();
    const { standings } = await engineRunner.computeYearlyStandings({ baseUrl: localApiBase(), edition });
    const compact = compactStandings(standings);
    if (compact.length === 0) throw new Error('classement vide, rien enregistré');
    await saveYearlyStandingsSnapshot(compact);
    console.log(`🏆 Classement annuel recalculé${edition ? ` [${edition.key}]` : ''} (${reason}) : ${compact.length} joueurs, ${Date.now() - started} ms`);
    return compact;
  };
  const result = standingsRefreshChain.then(run, run);
  standingsRefreshChain = result.catch(() => {});
  return result;
}

/** Recalcul différé. Coupé en bac à sable (VERSANT_DISABLE_JOBS), comme les autres tâches. */
function scheduleStandingsRefresh(reason) {
  if (JOBS_DISABLED) return;
  // Le minuteur garde le contexte d'édition de l'appel (AsyncLocalStorage)
  const key = currentEdition().leagueId;
  clearTimeout(standingsRefreshTimers.get(key));
  standingsRefreshTimers.set(key, setTimeout(() => {
    standingsRefreshTimers.delete(key);
    refreshYearlyStandings(reason).catch(e => console.error(`❌ Classement annuel [${key}] :`, e.message));
  }, STANDINGS_REFRESH_DELAY_MS));
}

/** Contexte d'une édition désignée par une route admin (body.edition), ou celui par défaut. */
async function adminEditionContext(req) {
  const key = req.body?.edition;
  return key ? store.editionContext(String(key)) : LEGACY_CONTEXT;
}

// Admin : recalculer et enregistrer maintenant
app.post('/api/admin/standings/refresh', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const context = await adminEditionContext(req);
    if (!context) return res.status(404).json({ error: 'Édition introuvable' });
    const compact = await withEdition(context, () => refreshYearlyStandings('admin'));
    res.json({ success: true, count: compact.length });
  } catch (error) {
    console.error('Erreur recalcul classement:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin : calculer le classement à une date donnée, SANS l'enregistrer
// (vérification, harnais de non-régression)
app.post('/api/admin/standings/compute', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const at = req.body?.at ? new Date(req.body.at) : null;
    if (at && isNaN(at.getTime())) return res.status(400).json({ error: 'date invalide' });
    const context = await adminEditionContext(req);
    if (!context) return res.status(404).json({ error: 'Édition introuvable' });
    const result = await withEdition(context, () =>
      engineRunner.computeYearlyStandings({ baseUrl: localApiBase(), at: at?.toISOString(), edition: internalEdition() }));
    res.json({ at: result.at, standings: compactStandings(result.standings) });
  } catch (error) {
    console.error('Erreur calcul classement:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: Export du classement annuel, tel que le serveur l'a calculé et
// enregistré dans yearlyStandingsSnapshot (cf. refreshYearlyStandings).
app.get('/api/admin/ranking/:leagueId/export', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = await frozenResults.loadFrozenResultsRaw();
    const snapshot = data?.yearlyStandingsSnapshot;
    if (!snapshot?.standings?.length) {
      return res.status(404).json({ error: 'Aucun classement disponible (il est calculé au démarrage du serveur et après chaque gel ; POST /api/admin/standings/refresh pour le forcer)' });
    }
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=classement-${req.params.leagueId}-${date}.json`);
    res.send(JSON.stringify({
      league_id: req.params.leagueId,
      generated_at: new Date().toISOString(),
      snapshot_updated_at: snapshot.updatedAt,
      ranking: snapshot.standings
    }, null, 2));
  } catch (error) {
    console.error('Erreur export classement:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Calcule (et met en cache) les équipes d'un round saison team.
 * Source unique de vérité : frontend et backend produisent des équipes
 * identiques en consommant cet endpoint.
 *
 * Stratégie :
 *  - Si le round est déjà figé (frozen_results.rounds[X].teams existent) →
 *    on retourne directement les équipes figées.
 *  - Sinon (round en cours) → on appelle calculateTeamRoundResults en mode
 *    "preview" (sans persister) et on retourne les équipes formées.
 *
 * Cache mémoire 30s pour limiter le coût.
 */
const _teamsCache = new Map(); // key = édition + round (teamsCacheKey), value = { ts, payload }
const teamsCacheKey = roundNumber => `${currentEdition().paths.frozen}#${roundNumber}`;
const TEAMS_CACHE_TTL_MS = 30000;

/**
 * Enregistre la compo d'un round dans season_teams.json, sauf si une compo y
 * est déjà : le premier tirage gagne, il n'est jamais écrasé. Écritures
 * enchaînées pour que deux requêtes simultanées ne se marchent pas dessus.
 * @returns {Promise<boolean>} true si une compo est enregistrée pour ce round
 */
let _seasonTeamsWriteChain = Promise.resolve();
function lockSeasonTeams(file, seasonNumber, roundNumber, teams) {
  const run = async () => {
    const stored = await safeReadJSON(file, {});
    const seasonEntry = stored[String(seasonNumber)] || (stored[String(seasonNumber)] = {});
    seasonEntry.rounds = seasonEntry.rounds || {};
    const existing = seasonEntry.rounds[String(roundNumber)];
    if (Array.isArray(existing?.teams) && existing.teams.length > 0) return true;
    seasonEntry.rounds[String(roundNumber)] = { teams, lockedAt: new Date().toISOString() };
    await safeWriteJSON(file, stored);
    console.log(`🔒 Équipes S${seasonNumber} R${roundNumber} verrouillées (premier tirage)`);
    return true;
  };
  const result = _seasonTeamsWriteChain.then(run, run);
  _seasonTeamsWriteChain = result.catch(e => console.error('❌ Verrouillage équipes:', e.message));
  return result.catch(() => false);
}

app.get('/api/teams/round/:roundNumber', async (req, res) => {
  try {
    const roundNumber = parseInt(req.params.roundNumber);
    if (!Number.isInteger(roundNumber) || roundNumber < 1) {
      return res.status(400).json({ error: 'roundNumber invalide' });
    }

    // Cache hit ?
    const cached = _teamsCache.get(teamsCacheKey(roundNumber));
    if (cached && Date.now() - cached.ts < TEAMS_CACHE_TTL_MS) {
      return res.json(cached.payload);
    }

    // 1. Si le round est déjà figé, renvoyer les équipes figées
    const allFrozen = await frozenResults.getAllFrozenResults();
    const frozenRound = allFrozen?.rounds?.[String(roundNumber)];
    if (frozenRound?.frozen && Array.isArray(frozenRound.teams)) {
      const payload = {
        roundNumber,
        seasonNumber: frozenRound.seasonNumber,
        roundInSeason: frozenRound.roundInSeason,
        seasonType: frozenRound.seasonType || (isTeamSeason(frozenRound.seasonNumber) ? 'team' : 'standard'),
        frozen: true,
        teams: frozenRound.teams,
        eliminatedTeam: frozenRound.eliminatedTeam || null
      };
      _teamsCache.set(teamsCacheKey(roundNumber), { ts: Date.now(), payload });
      return res.json(payload);
    }

    // 2. Vérifier si c'est bien une saison team
    const { isTeamSeason: isTeam } = require('./shared-config');
    // On utilise calculateRoundResults dans un mode "dry-run" : on charge les
    // données mais on n'appelle pas la persistance.
    const config = currentEdition().config;
    const leagueId = config.leagueId;
    const activitiesLeague = leagueId;
    const activities = await store.readActivities(activitiesLeague);
    const athletesAll = await safeReadJSON(ATHLETES_FILE, []);
    const leagueAthletes = (await store.listParticipants(leagueId)).filter(a => a.active);
    const jokerUsage = await readJokerUsage();

    // Détecter la saison de ce round à partir des rounds figés précédents.
    let detectedSeason = null;
    for (let r = roundNumber - 1; r >= 1; r--) {
      const prev = allFrozen.rounds?.[String(r)];
      if (prev?.seasonNumber != null) {
        const survivors = (prev.activeParticipants?.length || 0) - (prev.eliminations?.length || 0);
        const wasTeamFinal = prev.teamFinalRound === true;
        const wasConfigForcedFinale = prev.configForcedFinale === true;
        detectedSeason = (survivors <= 1 || wasTeamFinal || wasConfigForcedFinale)
          ? Number(prev.seasonNumber) + 1
          : Number(prev.seasonNumber);
        break;
      }
    }
    if (detectedSeason == null) detectedSeason = 1;

    if (!isTeam(detectedSeason)) {
      return res.status(400).json({
        error: 'Pas une saison team',
        seasonNumber: detectedSeason
      });
    }

    // Calcul "live" via le module frozen-results (sans persister).
    // calculateRoundResults n'est pas exporté, donc on appelle freezeRoundResults
    // serait destructif. Solution : passer par un appel direct à la fonction
    // interne via require, mais comme elle n'est pas exportée non plus,
    // on duplique a minima la formation des équipes ici.
    //
    // Plus simple : on appelle l'endpoint cache directement via le team-utils.
    const teamUtils = require('./team-utils');
    const teamSettings = require('./shared-config').getTeamSettings(detectedSeason);
    const teamSize = teamSettings.teamSize;

    // Déterminer les actifs de cette saison (non éliminés dans rounds précédents)
    let activeIds = leagueAthletes.map(a => String(a.id));
    for (let r = roundNumber - 1; r >= 1; r--) {
      const prev = allFrozen.rounds?.[String(r)];
      if (!prev?.frozen) continue;
      if (Number(prev.seasonNumber) !== Number(detectedSeason)) break;
      if (Array.isArray(prev.eliminations)) {
        const elimIds = prev.eliminations.map(e => String(e.id));
        activeIds = activeIds.filter(id => !elimIds.includes(id));
      }
    }

    // Carte d'équilibrage : D+ de l'année (saison réglée sur 'elevation'),
    // sinon points du snapshot du classement annuel. Même calcul que le gel.
    let pointsMap = {};
    activeIds.forEach(id => { pointsMap[id] = 0; });
    if (teamSettings.balanceBy === 'elevation') {
      pointsMap = teamUtils.buildElevationBalanceMap(
        activeIds.map(id => ({ id })), activities, sharedConfig.getRoundDates(roundNumber, config).start,
        { adjustments: teamSettings.elevationAdjustments, isValidSport: sharedConfig.isValidSport }
      );
    } else {
      const snap = allFrozen.yearlyStandingsSnapshot?.standings;
      if (Array.isArray(snap)) {
        snap.forEach(s => {
          if (s.id != null && pointsMap[String(s.id)] !== undefined) {
            pointsMap[String(s.id)] = s.totalPoints || 0;
          }
        });
      }
    }

    // Récupérer animaux déjà utilisés cette saison
    const usedAnimalIds = new Set();
    for (const [k, r] of Object.entries(allFrozen.rounds || {})) {
      if (!r?.frozen) continue;
      if (Number(r.seasonNumber) !== Number(detectedSeason)) continue;
      if (Array.isArray(r.teams)) {
        for (const t of r.teams) {
          if (t.animal?.id) usedAnimalIds.add(t.animal.id);
        }
      }
    }

    const activeAthletes = activeIds.map(id => {
      const a = leagueAthletes.find(x => String(x.id) === id);
      return { id, name: a?.name || `Athlète ${id}` };
    });

 // === 2.5 PRÉ-LOAD : équipes verrouillées (par round si dispo, sinon par saison) ===
    // Nouvelle structure attendue dans season_teams.json :
    //   { "<seasonNum>": { "teams": [...] (compo originale R1), "rounds": { "<roundNum>": { "teams": [...] } } } }
    //
    // Priorité de lecture :
    //   1. season_teams.json["<season>"]["rounds"]["<round>"]["teams"]  (= compo spécifique du round)
    //   2. season_teams.json["<season>"]["teams"]                       (= legacy, compo de toute la saison)
    //
    // Cas d'usage :
    //   - R21 = round 1 d'une saison team : lit "teams" à la racine (compo initiale tirée au sort)
    //   - R22, R23 ... : lit "rounds[X].teams" si stocké (re-tirage après élimination)
    const SEASON_TEAMS_FILE = currentEdition().paths.seasonTeams;
    const storedSeasonTeams = await safeReadJSON(SEASON_TEAMS_FILE, {});
    const seasonEntry = storedSeasonTeams[String(detectedSeason)];

    let lockedTeams = null;
    let lockedSource = null;
    if (seasonEntry) {
      // 1. Priorité au round spécifique
      const roundEntry = seasonEntry.rounds?.[String(roundNumber)];
      if (roundEntry && Array.isArray(roundEntry.teams) && roundEntry.teams.length > 0) {
        lockedTeams = roundEntry.teams;
        lockedSource = `rounds["${roundNumber}"]`;
      }
      // 2. Sinon fallback : compo "racine" UNIQUEMENT pour le R1 de la saison
      else if (Array.isArray(seasonEntry.teams) && seasonEntry.teams.length > 0) {
        // Détecter si c'est le R1 de la saison team : on regarde s'il n'y a aucun round
        // précédent figé pour cette saison
        const isFirstRoundOfSeason = !Object.values(allFrozen.rounds || {}).some(r =>
          Number(r?.seasonNumber) === detectedSeason && Number(r?.roundNumber) < roundNumber
        );
        if (isFirstRoundOfSeason) {
          lockedTeams = seasonEntry.teams;
          lockedSource = 'teams (root, legacy)';
        }
      }
    }

    if (lockedTeams) {
      const payload = {
        roundNumber,
        seasonNumber: detectedSeason,
        seasonType: 'team',
        frozen: false,
        teams: lockedTeams,
        eliminatedTeam: null,
        lockedFromFile: true,
        lockedSource
      };
      _teamsCache.set(teamsCacheKey(roundNumber), { ts: Date.now(), payload });
      return res.json(payload);
    }

    // Sinon : tirage normal
    const teams = teamUtils.formBalancedTeams(activeAthletes, pointsMap, roundNumber, teamSize);
    const teamsWithAnimal = teamUtils.assignTeamAnimals(teams, usedAnimalIds, roundNumber);

    // Le premier tirage d'un round commencé est définitif : on l'enregistre dans
    // season_teams.json (lu en priorité ci-dessus ET par le gel). Sans ça, la
    // compo était recalculée à chaque visite et changeait dès qu'une donnée
    // d'entrée bougeait (activité synchronisée en retard, snapshot du classement
    // renvoyé par un navigateur, athlète activé...).
    // Seulement si le round a commencé et que le round précédent est figé :
    // avant, la liste des joueurs en lice n'est pas encore sûre.
    const roundStarted = Date.now() >= sharedConfig.getRoundDates(roundNumber, config).start.getTime();
    const previousFrozen = roundNumber === 1 || allFrozen.rounds?.[String(roundNumber - 1)]?.frozen === true;
    let locked = false;
    if (roundStarted && previousFrozen) {
      locked = await lockSeasonTeams(SEASON_TEAMS_FILE, detectedSeason, roundNumber, teamsWithAnimal);
    }

    const payload = {
      roundNumber,
      seasonNumber: detectedSeason,
      seasonType: 'team',
      frozen: false,
      teams: teamsWithAnimal,
      eliminatedTeam: null
    };
    if (locked) {
      // Une requête concurrente a pu verrouiller avant nous : renvoyer la compo enregistrée
      const stored = await safeReadJSON(SEASON_TEAMS_FILE, {});
      payload.teams = stored[String(detectedSeason)]?.rounds?.[String(roundNumber)]?.teams || teamsWithAnimal;
      payload.lockedFromFile = true;
      payload.lockedSource = `rounds["${roundNumber}"]`;
    }
    _teamsCache.set(teamsCacheKey(roundNumber), { ts: Date.now(), payload });
    res.json(payload);
  } catch (error) {
    console.error('Erreur teams round:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer les résultats d'un round spécifique
app.get('/api/frozen-results/round/:roundNumber', async (req, res) => {
  try {
    const round = await frozenResults.getFrozenRoundResult(parseInt(req.params.roundNumber));
    if (!round) {
      return res.status(404).json({ error: 'Round non trouvé ou pas encore figé' });
    }
    res.json(round);
  } catch (error) {
    console.error('Erreur frozen-results:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Vérifier si un round est figé
app.get('/api/frozen-results/check/:roundNumber', async (req, res) => {
  try {
    const isFrozen = await frozenResults.isRoundFrozen(parseInt(req.params.roundNumber));
    res.json({ roundNumber: parseInt(req.params.roundNumber), frozen: isFrozen });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer le classement annuel basé sur les résultats figés
app.get('/api/frozen-results/standings/:leagueId', async (req, res) => {
  try {
    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const leagueAthletes = (await store.listParticipants(req.params.leagueId)).filter(a => a.active);
    const standings = await frozenResults.calculateYearlyStandings(leagueAthletes);
    res.json(standings);
  } catch (error) {
    console.error('Erreur standings:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Admin: Figer manuellement un round
app.post('/api/admin/freeze-round/:roundNumber', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    const roundNumber = parseInt(req.params.roundNumber);
    const leagueId = req.body.leagueId || currentEdition().leagueId;

    const activitiesLeague = leagueId;
    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const leagueAthletes = (await store.listParticipants(leagueId)).filter(a => a.active);
    const jokerUsage = await readJokerUsage();

    // Consolider la météo avant de figer (round gelé = définitif)
    await enrichLeagueWeather(leagueId);
    const activitiesForFreeze = await store.readActivities(activitiesLeague);

    const result = await frozenResults.freezeRoundResults(
      roundNumber,
      activitiesForFreeze,
      leagueAthletes,
      jokerUsage,
      currentEdition().config
    );

    res.json({ success: true, round: result });
  } catch (error) {
    console.error('Erreur freeze:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: Auto-figer tous les rounds terminés
app.post('/api/admin/auto-freeze', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    const leagueId = req.body.leagueId || currentEdition().leagueId;

    const activitiesLeague = leagueId;
    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const leagueAthletes = (await store.listParticipants(leagueId)).filter(a => a.active);
    const jokerUsage = await readJokerUsage();

    // Consolider la météo avant de figer (round gelé = définitif)
    await enrichLeagueWeather(leagueId);
    const activitiesForFreeze = await store.readActivities(activitiesLeague);

    const frozen = await frozenResults.autoFreezeCompletedRounds(
      activitiesForFreeze,
      leagueAthletes,
      jokerUsage,
      currentEdition().config
    );

    res.json({ success: true, frozenCount: frozen.length, rounds: frozen });
  } catch (error) {
    console.error('Erreur auto-freeze:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: Défiger un round spécifique
app.post('/api/admin/unfreeze-round/:roundNumber', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    const roundNumber = parseInt(req.params.roundNumber);
    const success = await frozenResults.unfreezeRound(roundNumber);
    res.json({ success, roundNumber });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Figer le classement final du challenge des éliminés pour une saison
// Phase 2 — voir BACKEND_TODO.md
app.post('/api/admin/freeze-elim-challenge/:seasonNumber', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    const seasonNumber = parseInt(req.params.seasonNumber);
    if (Number.isNaN(seasonNumber) || seasonNumber < 1) {
      return res.status(400).json({ error: 'invalid_season_number' });
    }
    const leagueId = req.body?.leagueId || currentEdition().leagueId;
    const force = req.body?.force === true;

    const result = await frozenResults.freezeEliminatedChallengeForSeason(seasonNumber, {
      leagueId,
      force,
      currentDate: req.body?.currentDate ? new Date(req.body.currentDate) : undefined
    });

    if (!result.success) {
      return res.status(409).json(result);
    }
    res.json(result);
  } catch (error) {
    console.error('Erreur freeze-elim-challenge:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: Défiger le classement du challenge des éliminés pour une saison
app.post('/api/admin/unfreeze-elim-challenge/:seasonNumber', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    const seasonNumber = parseInt(req.params.seasonNumber);
    if (Number.isNaN(seasonNumber) || seasonNumber < 1) {
      return res.status(400).json({ error: 'invalid_season_number' });
    }
    const success = await frozenResults.unfreezeEliminatedChallengeForSeason(seasonNumber);
    res.json({ success, seasonNumber });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Réinitialiser tous les résultats figés
app.post('/api/admin/reset-frozen', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    await frozenResults.resetAllFrozenResults();
    res.json({ success: true, message: 'Tous les résultats figés ont été supprimés' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Importer un fichier frozen_results.json complet
app.post('/api/admin/import-frozen-results', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    const { data, merge } = req.body;

    if (!data || !data.rounds) {
      return res.status(400).json({ error: 'Format invalide - objet avec "rounds" attendu' });
    }

    const result = await frozenResults.importFrozenResults(data, { merge: merge !== false });

    res.json({
      success: true,
      imported: result.imported,
      skipped: result.skipped,
      totalRounds: result.totalRounds
    });
  } catch (error) {
    console.error('Erreur import:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CRON - Ajout auto-freeze
// ============================================
cron.schedule('0 6 * * *', () => { console.log('🕐 Sync 6h'); autoSyncAllLeagues(); });
cron.schedule('0 10 * * *', () => { console.log('🕐 Sync 10h'); autoSyncAllLeagues(); });
cron.schedule('0 14 * * *', () => { console.log('🕐 Sync 14h'); autoSyncAllLeagues(); });
cron.schedule('0 18 * * *', () => { console.log('🕐 Sync 18h'); autoSyncAllLeagues(); });
cron.schedule('0 22 * * *', () => { console.log('🕐 Sync 22h'); autoSyncAllLeagues(); });

// Auto-freeze des rounds terminés, juste après minuit.
// IMPORTANT : on SYNCHRONISE Strava d'abord, puis on fige. Sans ça, le freeze
// utiliserait les activités du dernier sync (22h) et raterait les activités de
// la dernière soirée du round → un round terminé se figerait avec des données
// incomplètes (et un round figé ne se recalcule jamais). Le sync est attendu
// (await) avant le freeze, donc la nouvelle saison démarre dès que les deux
// sont finis (~00h15 + durée du sync).
async function runAutoFreeze(reason, { sync } = { sync: true }) {
  const started = Date.now();
  if (sync) {
    try {
      console.log(`🔄 [${reason}] Sync Strava avant auto-freeze...`);
      await autoSyncAllLeagues();
    } catch (e) {
      // Best-effort : on tente quand même le freeze avec les données sur disque.
      console.error(`⚠️ [${reason}] Sync avant freeze échoué, on fige avec les données existantes:`, e.message);
    }
  }
  // Chaque édition en cours, dans son contexte (L33)
  const frozenAll = [];
  await forEachActiveEdition('gel', async () => {
    frozenAll.push(...await freezeCurrentEdition(reason, started));
  });
  return frozenAll;
}

/** Gel des rounds terminés de l'édition en cours (contexte d'édition). */
async function freezeCurrentEdition(reason, started) {
  try {
    const leagueId = currentEdition().leagueId;
    const activitiesLeague = leagueId;
    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const leagueAthletes = (await store.listParticipants(leagueId)).filter(a => a.active);
    if (leagueAthletes.length === 0) {
      console.log(`[${reason}] aucun athlète actif, skip auto-freeze`);
      return [];
    }
    const jokerUsage = await readJokerUsage();

    // Consolider la météo AVANT de figer : un round gelé ne change plus jamais,
    // il doit donc l'être sur la donnée météo la plus à jour possible.
    await enrichLeagueWeather(leagueId);
    const activitiesForFreeze = await store.readActivities(activitiesLeague);

    const frozen = await frozenResults.autoFreezeCompletedRounds(
      activitiesForFreeze, leagueAthletes, jokerUsage, currentEdition().config
    );
    const editionLabel = currentEdition() === LEGACY_CONTEXT ? '' : ` [${currentEdition().leagueId}]`;
    console.log(`❄️ [${reason}]${editionLabel} ${frozen.length} round(s) figé(s) en ${Math.round((Date.now() - started) / 1000)} s (sync compris)`);
    if (frozen.length > 0) scheduleStandingsRefresh(`gel (${reason})`);
    return frozen;
  } catch (error) {
    console.error(`❌ [${reason}] Erreur auto-freeze:`, error.message);
    return [];
  }
}

// Sync + auto-freeze à 00h15 (heure de Paris, quel que soit le fuseau du
// serveur) : la nouvelle saison repart dès la nuit, pas le lendemain matin.
// 00h15 laisse ~15 min aux montres/apps pour téléverser les dernières
// activités de la soirée avant le sync.
cron.schedule('15 0 * * *', () => runAutoFreeze('cron 00h15', { sync: true }), {
  timezone: 'Europe/Paris'
});

cron.schedule('0 20 * * *', async () => {
  console.log('🕐 Tâches 20h');
  await autoSyncAllLeagues();
  await retryFailedWebhooks();
});

cron.schedule('30 */2 * * *', () => {
  console.log('🔄 Refresh tokens');
  refreshAllTokens();
});

// ============================================
// START
// ============================================

/**
 * Y a-t-il au moins un round terminé qui n'est pas encore figé ?
 * Même borne de fin que l'auto-freeze (getRoundDates(r).end).
 */
async function hasPendingRoundToFreeze() {
  try {
    const data = await frozenResults.loadFrozenResultsRaw();
    const now = Date.now();
    for (let r = 1; r <= 500; r++) {
      const end = frozenResults.getRoundDates(r, currentEdition().config).end.getTime();
      if (end >= now) return false; // round pas terminé → les suivants non plus
      if (!data?.rounds?.[String(r)]?.frozen) return true;
    }
    return false;
  } catch (e) {
    console.warn('⚠️ hasPendingRoundToFreeze:', e.message);
    return false;
  }
}

/**
 * Au démarrage : figer les rounds terminés en retard. Couvre le cas où le
 * serveur était down au moment du cron 00h15.
 *
 * On ne resync que s'il y a RÉELLEMENT quelque chose à figer : figer sur des
 * données Strava périmées grave un résultat faux pour toujours. L'intention
 * d'origine (ne pas taper Strava à chaque redémarrage/déploiement) est préservée,
 * puisque le cas courant est « rien à figer » → aucun appel.
 */
async function catchUpAutoFreezeOnStartup() {
  // Une édition en cours avec un round terminé non figé suffit (L33)
  let pending = false;
  await forEachActiveEdition('rattrapage', async () => {
    if (await hasPendingRoundToFreeze()) pending = true;
  });
  if (!pending) {
    console.log('[startup] aucun round en retard, pas de freeze');
    return;
  }
  console.log('[startup] round(s) terminé(s) non figé(s) → sync avant freeze');
  const frozen = await runAutoFreeze('startup', { sync: true });
  frozen.forEach(r => {
    console.log(`   ❄️ Round ${r.roundNumber} (saison ${r.seasonNumber})`);
  });
}

initializeServer().then(async () => {
  app.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║     🚀 VERSANT SERVER v2.6             ║');
    console.log('╠════════════════════════════════════════╣');
    console.log(`║  Port: ${PORT}                             ║`);
    console.log('║  Syncs: 6h, 10h, 14h, 18h, 22h         ║');
    console.log('║  Auto-freeze: sync+00h15 + démarrage   ║');
    console.log('║  Refresh tokens: toutes les 2h        ║');
    console.log('╚════════════════════════════════════════╝');
    if (!ADMIN_PASSWORD) console.warn('⚠️  ADMIN_PASSWORD non défini : toutes les routes admin sont refusées');
    if (JOBS_DISABLED) console.log('⏸️  VERSANT_DISABLE_JOBS=1 : tâches planifiées et rattrapage du gel désactivés');
    if (process.env.VERSANT_DATA_DIR) console.log(`📁 Données : ${DATA_DIR}`);
    if (STORE_LAYOUT !== 'legacy') console.log(`🗂️  Organisation des données : ${STORE_LAYOUT}`);
    scheduleStandingsRefresh('démarrage');
    console.log('');
  });

  // Catch-up auto-freeze au démarrage (différé de quelques secondes pour
  // laisser le serveur se stabiliser avant de toucher aux fichiers).
  if (!JOBS_DISABLED) {
    setTimeout(async () => {
      await catchUpAutoFreezeOnStartup();
      // Bonus restés rattachés à une saison close (ex: saison figée par script)
      await frozenResults.purgeClosedSeasonBonuses().catch(e =>
        console.warn('⚠️ Rattrapage purge bonus:', e.message));
      // Saison Deadline en cours : recaler les rounds restants
      await replanDeadline('démarrage');
    }, 5000);
  }
});