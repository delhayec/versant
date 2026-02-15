/**
 * ============================================
 * VERSANT - SERVEUR BACKEND v2.3
 * ============================================
 * AMÉLIORATIONS WEBHOOK:
 * - Normalisation systématique des IDs (string)
 * - File locking pour éviter les race conditions
 * - Queue de traitement webhook
 * - Logging détaillé de chaque étape
 * - Refresh préventif des tokens (toutes les 2h)
 * - Sync automatique 5x/jour en backup
 * - Diagnostic complet
 */
require('dotenv').config();

const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const crypto = require('crypto');

// Import du module jokers
const { createJokersRoutes } = require('./jokers-routes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Configuration
const STRAVA_CONFIG = {
  clientId: process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET,
  redirectUri: process.env.STRAVA_REDIRECT_URI || 'http://localhost:3000/inscription.html'
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const STRAVA_VERIFY_TOKEN = process.env.STRAVA_VERIFY_TOKEN || 'VERSANT2026';

// Chemins
const DATA_DIR = path.join(__dirname, 'data');
const LEAGUES_DIR = path.join(DATA_DIR, 'leagues');
const ATHLETES_FILE = path.join(DATA_DIR, 'athletes.json');
const JOKERS_FILE = path.join(DATA_DIR, 'jokers_usage.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const FAILED_WEBHOOKS_FILE = path.join(DATA_DIR, 'failed_webhooks.json');
const WEBHOOK_LOG_FILE = path.join(DATA_DIR, 'webhook_log.json');

// ============================================
// NORMALISATION DES IDS (CRITIQUE!)
// ============================================
// Strava envoie parfois des numbers, parfois des strings
// On normalise TOUT en string pour éviter les problèmes de comparaison
function normalizeId(id) {
  if (id === null || id === undefined) return null;
  return String(id).trim();
}

// ============================================
// SYSTÈME DE LOCK FICHIERS (évite corruption)
// ============================================
const fileLocks = new Map();
const lockTimeouts = new Map();

async function acquireLock(filePath, timeout = 10000) {
  const start = Date.now();
  while (fileLocks.get(filePath)) {
    if (Date.now() - start > timeout) {
      console.warn(`⚠️ Lock timeout pour ${filePath}, forçage...`);
      fileLocks.delete(filePath);
      break;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  fileLocks.set(filePath, true);

  // Auto-release après 30 sec (sécurité)
  const timeoutId = setTimeout(() => {
    if (fileLocks.get(filePath)) {
      console.warn(`⚠️ Lock auto-release pour ${filePath}`);
      fileLocks.delete(filePath);
    }
  }, 30000);
  lockTimeouts.set(filePath, timeoutId);
}

function releaseLock(filePath) {
  fileLocks.delete(filePath);
  const timeoutId = lockTimeouts.get(filePath);
  if (timeoutId) {
    clearTimeout(timeoutId);
    lockTimeouts.delete(filePath);
  }
}

async function safeReadJSON(filePath, defaultValue = []) {
  await acquireLock(filePath);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Erreur lecture ${filePath}:`, error.message);
    }
    return defaultValue;
  } finally {
    releaseLock(filePath);
  }
}

async function safeWriteJSON(filePath, data) {
  await acquireLock(filePath);
  try {
    // Écriture atomique: écrire dans un fichier temp puis renommer
    const tempPath = filePath + '.tmp';
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
    await fs.rename(tempPath, filePath);
  } catch (error) {
    console.error(`Erreur écriture ${filePath}:`, error.message);
    throw error;
  } finally {
    releaseLock(filePath);
  }
}

// ============================================
// LOGGING WEBHOOK DÉTAILLÉ
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

    // Garder 500 derniers logs
    if (logs.length > 500) logs.length = 500;

    await safeWriteJSON(WEBHOOK_LOG_FILE, logs);
  } catch (e) {
    console.error('Erreur log webhook:', e.message);
  }
}

// ============================================
// UTILITAIRES
// ============================================
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function verifyPassword(password, hash) {
  return hashPassword(password) === hash;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ============================================
// INITIALISATION
// ============================================
async function initializeServer() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(LEAGUES_DIR, { recursive: true });

  const files = [ATHLETES_FILE, JOKERS_FILE, SESSIONS_FILE, FAILED_WEBHOOKS_FILE, WEBHOOK_LOG_FILE];
  for (const file of files) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, JSON.stringify([], null, 2));
    }
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

  if (!athleteId) {
    return res.status(401).json({ error: 'Non authentifié' });
  }

  req.athleteId = athleteId;
  next();
}

// ============================================
// ROUTES JOKERS
// ============================================
const jokersRouter = createJokersRoutes({
  ATHLETES_FILE,
  JOKERS_FILE,
  ADMIN_PASSWORD,
  requireAuth
});
app.use('/api', jokersRouter);

// ============================================
// ROUTES - AUTHENTIFICATION
// ============================================
app.post('/api/auth/strava/exchange', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Code manquant' });
    }

    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: STRAVA_CONFIG.clientId,
      client_secret: STRAVA_CONFIG.clientSecret,
      code,
      grant_type: 'authorization_code'
    });

    const { access_token, refresh_token, expires_at, athlete } = response.data;
    res.json({ access_token, refresh_token, expires_at, athlete });

  } catch (error) {
    console.error('Erreur échange token:', error.response?.data || error.message);
    res.status(500).json({ error: 'Échec authentification Strava' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const athlete = athletes.find(a => a.email?.toLowerCase() === email.toLowerCase());

    if (!athlete || !verifyPassword(password, athlete.password_hash)) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const token = await createSession(athlete.id);
    res.json({
      success: true,
      token,
      athlete: { id: athlete.id, name: athlete.name, email: athlete.email, league_id: athlete.league_id }
    });

  } catch (error) {
    console.error('Erreur login:', error);
    res.status(500).json({ error: 'Erreur connexion' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      const sessions = await safeReadJSON(SESSIONS_FILE, []);
      await safeWriteJSON(SESSIONS_FILE, sessions.filter(s => s.token !== token));
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur logout' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const athleteId = await validateSession(token);

    if (!athleteId) {
      return res.status(401).json({ error: 'Non authentifié' });
    }

    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const athlete = athletes.find(a => normalizeId(a.id) === normalizeId(athleteId));

    if (!athlete) {
      return res.status(404).json({ error: 'Athlète non trouvé' });
    }

    res.json({
      id: athlete.id,
      name: athlete.name,
      email: athlete.email,
      league_id: athlete.league_id,
      jokers: athlete.jokers || []
    });

  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// ROUTES - INSCRIPTION
// ============================================
app.post('/api/athletes/register', async (req, res) => {
  try {
    const { athlete_id, name, email, password, strava_data, access_token, refresh_token, expires_at, league_id } = req.body;

    if (!athlete_id || !name || !league_id || !password || !email) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court (min 6 caractères)' });
    }

    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const normalizedId = normalizeId(athlete_id);

    if (athletes.find(a => a.email?.toLowerCase() === email.toLowerCase())) {
      return res.status(400).json({ error: 'Email déjà utilisé' });
    }

    if (athletes.find(a => normalizeId(a.id) === normalizedId && a.league_id === league_id)) {
      return res.status(400).json({ error: 'Déjà inscrit' });
    }

    const athleteRecord = {
      id: normalizedId,
      name,
      email,
      password_hash: hashPassword(password),
      league_id,
      strava_profile: strava_data,
      registered_at: new Date().toISOString(),
      tokens: { access_token, refresh_token, expires_at },
      jokers: ["voleur", "multiplicateur", "bouclier", "sabotage"],
      jokers_used: [],
      active: true
    };

    athletes.push(athleteRecord);
    await safeWriteJSON(ATHLETES_FILE, athletes);

    const token = await createSession(normalizedId);
    console.log(`✅ Athlète inscrit: ${name} (ID: ${normalizedId})`);

    res.json({ success: true, athlete_id: normalizedId, token });

  } catch (error) {
    console.error('Erreur inscription:', error);
    res.status(500).json({ error: 'Erreur inscription' });
  }
});

app.get('/api/athletes/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const athletes = await safeReadJSON(ATHLETES_FILE, []);

    const leagueAthletes = athletes
      .filter(a => a.league_id === leagueId && a.active)
      .map(a => ({ id: a.id, name: a.name, email: a.email, registered_at: a.registered_at }));

    res.json(leagueAthletes);
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// ROUTES - JOKERS
// ============================================
app.post('/api/jokers/use', requireAuth, async (req, res) => {
  try {
    const { joker_id, target_athlete_id, round_number, selected_day, activate_now } = req.body;

    if (!joker_id || !round_number) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const athleteIndex = athletes.findIndex(a => normalizeId(a.id) === normalizeId(req.athleteId));

    if (athleteIndex < 0) {
      return res.status(404).json({ error: 'Athlète non trouvé' });
    }

    const athlete = athletes[athleteIndex];

    if (!athlete.jokers?.includes(joker_id)) {
      return res.status(400).json({ error: 'Joker non disponible' });
    }

    const usage = {
      athlete_id: athlete.id,
      joker_id,
      target_athlete_id: target_athlete_id || null,
      selected_day: selected_day || null,
      activate_now: activate_now || false,
      round_number,
      used_at: new Date().toISOString(),
      status: 'active'
    };

    const jokerUsage = await safeReadJSON(JOKERS_FILE, []);
    jokerUsage.push(usage);
    await safeWriteJSON(JOKERS_FILE, jokerUsage);

    athlete.jokers = athlete.jokers.filter(j => j !== joker_id);
    athlete.jokers_used = athlete.jokers_used || [];
    athlete.jokers_used.push(usage);
    athletes[athleteIndex] = athlete;
    await safeWriteJSON(ATHLETES_FILE, athletes);

    console.log(`🃏 Joker ${joker_id} utilisé par ${athlete.name}`);
    res.json({ success: true, usage });

  } catch (error) {
    console.error('Erreur joker:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/jokers/my', requireAuth, async (req, res) => {
  try {
    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const athlete = athletes.find(a => normalizeId(a.id) === normalizeId(req.athleteId));

    if (!athlete) {
      return res.status(404).json({ error: 'Athlète non trouvé' });
    }

    res.json({ available: athlete.jokers || [], used: athlete.jokers_used || [] });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/jokers/round/:roundNumber', async (req, res) => {
  try {
    const jokerUsage = await safeReadJSON(JOKERS_FILE, []);
    const roundJokers = jokerUsage.filter(j => j.round_number === parseInt(req.params.roundNumber) && j.status === 'active');
    res.json(roundJokers);
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// ROUTES - ACTIVITÉS
// ============================================
app.get('/api/activities/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);
    const activities = await safeReadJSON(activitiesFile, []);
    res.json(activities);
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/activities-status/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);

    try {
      const stats = await fs.stat(activitiesFile);
      const activities = await safeReadJSON(activitiesFile, []);

      let lastActivity = null;
      if (activities.length > 0) {
        const sorted = [...activities].sort((a, b) =>
          new Date(b.synced_at || b.start_date) - new Date(a.synced_at || a.start_date)
        );
        lastActivity = {
          id: sorted[0].id,
          name: sorted[0].name,
          athlete_name: sorted[0].athlete_name,
          synced_at: sorted[0].synced_at || sorted[0].start_date
        };
      }

      res.json({ count: activities.length, lastModified: stats.mtime.toISOString(), lastActivity });
    } catch {
      res.json({ count: 0, lastModified: null, lastActivity: null });
    }
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// STRAVA - REFRESH TOKEN ROBUSTE
// ============================================
async function refreshStravaToken(athlete) {
  const athleteName = athlete.name || 'Unknown';
  const refreshToken = athlete.tokens?.refresh_token;

  if (!refreshToken) {
    console.log(`   ❌ ${athleteName}: pas de refresh_token`);
    return { success: false, reason: 'no_refresh_token' };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`   🔄 ${athleteName}: refresh tentative ${attempt}/3...`);

      const response = await axios.post('https://www.strava.com/oauth/token', {
        client_id: STRAVA_CONFIG.clientId,
        client_secret: STRAVA_CONFIG.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }, { timeout: 10000 });

      console.log(`   ✅ ${athleteName}: token rafraîchi`);

      return {
        success: true,
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token,
        expires_at: response.data.expires_at
      };
    } catch (error) {
      const errorMsg = error.response?.data?.message || error.message;
      console.log(`   ⚠️ ${athleteName}: tentative ${attempt} échouée - ${errorMsg}`);

      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }

  console.log(`   ❌ ${athleteName}: refresh échoué après 3 tentatives`);
  return { success: false, reason: 'refresh_failed' };
}

// ============================================
// REFRESH PRÉVENTIF DE TOUS LES TOKENS
// ============================================
async function refreshAllTokensPreventively() {
  console.log('🔄 Refresh préventif des tokens...');

  const athletes = await safeReadJSON(ATHLETES_FILE, []);
  const now = Date.now() / 1000;
  let refreshed = 0;
  let failed = 0;

  for (let i = 0; i < athletes.length; i++) {
    const athlete = athletes[i];
    if (!athlete.tokens?.refresh_token) continue;

    // Rafraîchir si expire dans moins de 2 heures
    const expiresAt = athlete.tokens.expires_at || 0;
    if (expiresAt < now + 7200) {
      const result = await refreshStravaToken(athlete);

      if (result.success) {
        athletes[i].tokens = {
          access_token: result.access_token,
          refresh_token: result.refresh_token,
          expires_at: result.expires_at
        };
        refreshed++;
      } else {
        failed++;
      }

      // Petite pause entre chaque refresh pour éviter rate limiting
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (refreshed > 0 || failed > 0) {
    await safeWriteJSON(ATHLETES_FILE, athletes);
    console.log(`   ✅ ${refreshed} rafraîchis, ${failed} échoués`);
  } else {
    console.log(`   ✅ Tous les tokens sont valides`);
  }
}

// ============================================
// SYNCHRONISATION COMPLÈTE
// ============================================
async function syncLeague(leagueId, startDate, endDate) {
  console.log(`🔄 Sync ${leagueId}: ${startDate} → ${endDate}`);

  const athletes = await safeReadJSON(ATHLETES_FILE, []);
  const leagueAthletes = athletes.filter(a => a.league_id === leagueId && a.active);

  const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);
  let activities = await safeReadJSON(activitiesFile, []);

  let totalNew = 0;
  const errors = [];

  for (let i = 0; i < leagueAthletes.length; i++) {
    const athlete = leagueAthletes[i];
    const athleteId = normalizeId(athlete.id);

    try {
      console.log(`   📥 ${athlete.name}...`);

      // Vérifier le token
      let accessToken = athlete.tokens?.access_token;
      if (!accessToken) {
        console.log(`      ⚠️ Pas de token`);
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
        const idx = athletes.findIndex(a => normalizeId(a.id) === athleteId);
        if (idx >= 0) {
          athletes[idx].tokens = {
            access_token: result.access_token,
            refresh_token: result.refresh_token,
            expires_at: result.expires_at
          };
        }
      }

      // Fetch activités
      const afterTs = Math.floor(new Date(startDate).getTime() / 1000);
      const beforeTs = Math.floor(new Date(endDate).getTime() / 1000) + 86400;

      const response = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { after: afterTs, before: beforeTs, per_page: 200 },
        timeout: 15000
      });

      const validTypes = ['Run', 'TrailRun', 'Hike', 'Walk', 'Ride', 'MountainBikeRide', 'GravelRide', 'BackcountrySki', 'NordicSki', 'Snowshoe'];
      let newCount = 0;

      for (const act of response.data) {
        if (!validTypes.includes(act.sport_type) && !validTypes.includes(act.type)) continue;

        const exists = activities.find(a => a.id === act.id);
        if (!exists) {
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
      }

      console.log(`      ✓ ${response.data.length} activités, ${newCount} nouvelles`);

    } catch (error) {
      const msg = error.response?.data?.message || error.message;
      console.log(`      ✗ ${msg}`);
      errors.push({ athlete: athlete.name, error: msg });
    }
  }

  // Sauvegarder
  await safeWriteJSON(ATHLETES_FILE, athletes);
  await safeWriteJSON(activitiesFile, activities);

  console.log(`   ✅ Terminé: ${totalNew} nouvelles activités`);

  return { success: true, totalNew, athletesCount: leagueAthletes.length, errors };
}

async function autoSyncAllLeagues() {
  console.log('🔄 Synchronisation automatique de toutes les ligues...');

  try {
    // D'abord refresh tous les tokens
    await refreshAllTokensPreventively();

    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const leagues = [...new Set(athletes.map(a => a.league_id).filter(Boolean))];

    const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const end = new Date().toISOString().split('T')[0];

    for (const leagueId of leagues) {
      await syncLeague(leagueId, start, end);
    }

    console.log('✅ Sync automatique terminée');
  } catch (error) {
    console.error('❌ Erreur sync auto:', error.message);
  }
}

app.post('/api/sync/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { startDate, endDate } = req.body;

    const start = startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const end = endDate || new Date().toISOString().split('T')[0];

    const result = await syncLeague(leagueId, start, end);
    res.json(result);
  } catch (error) {
    console.error('Erreur sync:', error);
    res.status(500).json({ error: 'Erreur synchronisation' });
  }
});

// ============================================
// WEBHOOK STRAVA - QUEUE + TRAITEMENT ROBUSTE
// ============================================
const webhookQueue = [];
let isProcessingQueue = false;

// Validation webhook (GET)
app.get('/api/webhook/strava', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;

  console.log(`🔔 Validation webhook: mode=${mode}, token=${token}`);

  if (mode === 'subscribe' && token === STRAVA_VERIFY_TOKEN) {
    console.log('✅ Webhook validé');
    res.json({ 'hub.challenge': challenge });
  } else {
    console.log('❌ Validation échouée');
    res.status(403).send('Forbidden');
  }
});

// Réception webhook (POST)
app.post('/api/webhook/strava', (req, res) => {
  const event = req.body;

  const eventStr = `${event.object_type}:${event.aspect_type} owner=${event.owner_id} object=${event.object_id}`;
  console.log(`🔔 Webhook reçu: ${eventStr}`);

  // RÉPONDRE IMMÉDIATEMENT (Strava timeout = 2 sec)
  res.status(200).send('EVENT_RECEIVED');

  // Ajouter à la queue
  webhookQueue.push({
    ...event,
    received_at: new Date().toISOString()
  });

  // Déclencher le traitement
  processWebhookQueue();
});

async function processWebhookQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (webhookQueue.length > 0) {
    const event = webhookQueue.shift();

    try {
      await processOneWebhook(event);
    } catch (error) {
      console.error(`❌ Erreur traitement webhook: ${error.message}`);
      await logWebhook(event, 'error', { error: error.message });
    }

    // Petite pause entre chaque webhook
    await new Promise(r => setTimeout(r, 100));
  }

  isProcessingQueue = false;
}

async function processOneWebhook(event) {
  const ownerId = normalizeId(event.owner_id);
  const objectId = event.object_id;

  console.log(`   📋 Traitement: ${event.object_type}:${event.aspect_type} pour ${ownerId}`);

  // Ignorer si pas une activité
  if (event.object_type !== 'activity') {
    console.log(`   → Ignoré (type: ${event.object_type})`);
    await logWebhook(event, 'ignored', { reason: 'not_activity' });
    return;
  }

  // Trouver l'athlète
  const athletes = await safeReadJSON(ATHLETES_FILE, []);
  const athleteIndex = athletes.findIndex(a => normalizeId(a.id) === ownerId);

  if (athleteIndex < 0) {
    console.log(`   → Ignoré (athlète ${ownerId} non inscrit)`);
    await logWebhook(event, 'ignored', { reason: 'athlete_not_found', owner_id: ownerId });
    return;
  }

  const athlete = athletes[athleteIndex];
  const leagueId = athlete.league_id;
  const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);

  console.log(`   → Athlète trouvé: ${athlete.name} (${leagueId})`);

  // CRÉATION
  if (event.aspect_type === 'create') {
    console.log(`   📥 Nouvelle activité ${objectId}...`);

    // Vérifier/refresh token
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
      athletes[athleteIndex].tokens = {
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        expires_at: result.expires_at
      };
      await safeWriteJSON(ATHLETES_FILE, athletes);
    }

    // Fetch l'activité avec retry
    let stravaActivity = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`   🌐 Fetch activité (tentative ${attempt}/3)...`);

        const response = await axios.get(
          `https://www.strava.com/api/v3/activities/${objectId}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15000
          }
        );

        stravaActivity = response.data;
        console.log(`   ✓ Activité récupérée: ${stravaActivity.name}`);
        break;

      } catch (error) {
        const msg = error.response?.data?.message || error.message;
        console.log(`   ⚠️ Tentative ${attempt} échouée: ${msg}`);

        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
    }

    if (!stravaActivity) {
      console.log(`   ❌ Impossible de récupérer l'activité`);
      await logWebhook(event, 'failed', { reason: 'fetch_failed' });
      await saveFailedWebhook(event, 'fetch_failed');
      return;
    }

    // Vérifier le type
    const validTypes = ['Run', 'TrailRun', 'Hike', 'Walk', 'Ride', 'MountainBikeRide', 'GravelRide', 'BackcountrySki', 'NordicSki', 'Snowshoe'];
    const actType = stravaActivity.sport_type || stravaActivity.type;

    if (!validTypes.includes(actType)) {
      console.log(`   → Ignoré (type: ${actType})`);
      await logWebhook(event, 'ignored', { reason: 'invalid_type', type: actType });
      return;
    }

    // Charger les activités
    let activities = await safeReadJSON(activitiesFile, []);

    // Vérifier doublon
    if (activities.find(a => a.id === stravaActivity.id)) {
      console.log(`   → Doublon ignoré`);
      await logWebhook(event, 'duplicate', {});
      return;
    }

    // Ajouter
    const newActivity = {
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
      average_speed: stravaActivity.average_speed,
      max_speed: stravaActivity.max_speed,
      synced_at: new Date().toISOString(),
      source: 'webhook'
    };

    activities.push(newActivity);
    await safeWriteJSON(activitiesFile, activities);

    console.log(`   ✅ Activité ajoutée: ${newActivity.name} (+${newActivity.total_elevation_gain}m)`);
    await logWebhook(event, 'success', {
      activity_name: newActivity.name,
      elevation: newActivity.total_elevation_gain,
      distance: newActivity.distance
    });
  }

  // SUPPRESSION
  else if (event.aspect_type === 'delete') {
    let activities = await safeReadJSON(activitiesFile, []);
    const before = activities.length;
    activities = activities.filter(a => a.id !== objectId);

    if (activities.length < before) {
      await safeWriteJSON(activitiesFile, activities);
      console.log(`   🗑️ Activité ${objectId} supprimée`);
      await logWebhook(event, 'deleted', {});
    } else {
      console.log(`   → Activité ${objectId} non trouvée`);
      await logWebhook(event, 'ignored', { reason: 'not_found' });
    }
  }

  // UPDATE (ignoré)
  else if (event.aspect_type === 'update') {
    console.log(`   → Update ignoré`);
    await logWebhook(event, 'ignored', { reason: 'update_not_implemented' });
  }
}

async function saveFailedWebhook(event, reason) {
  try {
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
  } catch (e) {
    console.error('Erreur sauvegarde failed webhook:', e.message);
  }
}

async function retryFailedWebhooks() {
  console.log('🔄 Retry des webhooks échoués...');

  const failed = await safeReadJSON(FAILED_WEBHOOKS_FILE, []);

  if (failed.length === 0) {
    console.log('   ✅ Aucun webhook en échec');
    return;
  }

  console.log(`   📋 ${failed.length} webhooks à retenter`);

  const stillFailed = [];

  for (const item of failed) {
    if (item.retry_count >= 5) {
      console.log(`   ⚠️ Abandonné (5 tentatives): ${item.event.object_id}`);
      continue;
    }

    try {
      await processOneWebhook(item.event);
      console.log(`   ✅ Réussi: ${item.event.object_id}`);
    } catch (error) {
      item.retry_count++;
      item.last_attempt = new Date().toISOString();
      item.last_reason = error.message;
      stillFailed.push(item);
    }
  }

  await safeWriteJSON(FAILED_WEBHOOKS_FILE, stillFailed);
  console.log(`   📋 Restant: ${stillFailed.length}`);
}

// ============================================
// ADMIN - ENDPOINTS
// ============================================
function checkAdmin(req, res) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Non autorisé' });
    return false;
  }
  return true;
}

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
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
  res.json({ message: 'Logs et échecs effacés' });
});

app.get('/api/admin/strava/status', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    const response = await axios.get('https://www.strava.com/api/v3/push_subscriptions', {
      params: { client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET }
    });

    res.json({
      active: response.data.length > 0,
      subscriptions: response.data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/strava/subscribe', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    // Vérifier si déjà abonné
    const check = await axios.get('https://www.strava.com/api/v3/push_subscriptions', {
      params: { client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET }
    });

    if (check.data.length > 0) {
      return res.json({ message: 'Déjà abonné', subscription: check.data[0] });
    }

    // Créer l'abonnement
    const response = await axios.post('https://www.strava.com/api/v3/push_subscriptions', {
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      callback_url: 'https://versant-app.fr/api/webhook/strava',
      verify_token: STRAVA_VERIFY_TOKEN
    });

    res.json({ message: 'Abonnement créé', subscription: response.data });
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.delete('/api/admin/strava/subscribe', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    const check = await axios.get('https://www.strava.com/api/v3/push_subscriptions', {
      params: { client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET }
    });

    if (check.data.length === 0) {
      return res.json({ message: 'Aucun abonnement' });
    }

    await axios.delete(`https://www.strava.com/api/v3/push_subscriptions/${check.data[0].id}`, {
      params: { client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET }
    });

    res.json({ message: 'Abonnement supprimé' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/tokens/refresh-all', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  await refreshAllTokensPreventively();
  res.json({ message: 'Tokens rafraîchis' });
});

app.get('/api/admin/diagnostic', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const webhookLogs = await safeReadJSON(WEBHOOK_LOG_FILE, []);
    const failedWebhooks = await safeReadJSON(FAILED_WEBHOOKS_FILE, []);

    const now = Date.now() / 1000;

    // Stats tokens
    const tokenStats = {
      total: athletes.length,
      active: athletes.filter(a => a.active).length,
      withToken: athletes.filter(a => a.tokens?.access_token).length,
      expired: athletes.filter(a => a.tokens?.expires_at && a.tokens.expires_at < now).length,
      expiringSoon: athletes.filter(a => a.tokens?.expires_at && a.tokens.expires_at < now + 3600 && a.tokens.expires_at >= now).length
    };

    // Stats webhooks dernières 24h
    const last24h = Date.now() - 24 * 60 * 60 * 1000;
    const recentLogs = webhookLogs.filter(l => new Date(l.timestamp).getTime() > last24h);

    const webhookStats = {
      last24h: recentLogs.length,
      success: recentLogs.filter(l => l.status === 'success').length,
      failed: recentLogs.filter(l => l.status === 'failed' || l.status === 'error').length,
      ignored: recentLogs.filter(l => l.status === 'ignored').length,
      duplicate: recentLogs.filter(l => l.status === 'duplicate').length,
      pendingRetry: failedWebhooks.length
    };

    // Détail par athlète
    const athleteDetails = athletes.map(a => {
      const id = normalizeId(a.id);
      const recent = recentLogs.filter(l => normalizeId(l.owner_id) === id);

      return {
        id: a.id,
        name: a.name,
        hasToken: !!a.tokens?.access_token,
        tokenExpired: a.tokens?.expires_at ? a.tokens.expires_at < now : true,
        expiresIn: a.tokens?.expires_at ? Math.round((a.tokens.expires_at - now) / 60) + ' min' : 'N/A',
        webhooks24h: {
          total: recent.length,
          success: recent.filter(l => l.status === 'success').length,
          failed: recent.filter(l => l.status === 'failed').length
        }
      };
    });

    res.json({
      timestamp: new Date().toISOString(),
      tokens: tokenStats,
      webhooks: webhookStats,
      athletes: athleteDetails,
      recentWebhooks: webhookLogs.slice(0, 20),
      recommendations: [
        ...(tokenStats.expired > 0 ? [`⚠️ ${tokenStats.expired} tokens expirés - POST /api/admin/tokens/refresh-all`] : []),
        ...(failedWebhooks.length > 0 ? [`⚠️ ${failedWebhooks.length} webhooks en échec - POST /api/admin/webhooks/retry`] : []),
        ...(webhookStats.failed > webhookStats.success ? ['🚨 Plus d\'échecs que de succès - vérifier les tokens'] : [])
      ]
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/athletes/download', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const data = await fs.readFile(ATHLETES_FILE, 'utf8');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=athletes.json');
  res.send(data);
});

app.get('/api/admin/activities/:leagueId/download', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const activitiesFile = path.join(LEAGUES_DIR, `${req.params.leagueId}_activities.json`);
  try {
    const data = await fs.readFile(activitiesFile, 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=${req.params.leagueId}_activities.json`);
    res.send(data);
  } catch {
    res.status(404).json({ error: 'Fichier non trouvé' });
  }
});

// ============================================
// CLASSEMENT
// ============================================
async function generateRanking(leagueId) {
  const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);
  const athletes = await safeReadJSON(ATHLETES_FILE, []);
  const activities = await safeReadJSON(activitiesFile, []);

  const stats = {};

  for (const a of athletes.filter(a => a.league_id === leagueId)) {
    stats[normalizeId(a.id)] = {
      id: a.id,
      name: a.name,
      total_elevation: 0,
      total_distance: 0,
      activities: 0
    };
  }

  for (const act of activities.filter(a => !a.excluded)) {
    const id = normalizeId(act.athlete_id || act.athlete?.id);
    if (stats[id]) {
      stats[id].total_elevation += act.total_elevation_gain || 0;
      stats[id].total_distance += act.distance || 0;
      stats[id].activities++;
    }
  }

  return Object.values(stats)
    .sort((a, b) => b.total_elevation - a.total_elevation)
    .map((s, i) => ({ rank: i + 1, ...s }));
}

async function exportAndPushRanking() {
  const { exec } = require('child_process');

  try {
    console.log('📊 Export classement...');

    const ranking = await generateRanking('versant-2026');
    const data = {
      league_id: 'versant-2026',
      generated_at: new Date().toISOString(),
      ranking
    };

    const exportPath = path.join(__dirname, '..', 'public', 'data', 'classement.json');
    await fs.writeFile(exportPath, JSON.stringify(data, null, 2));

    const projectDir = path.join(__dirname, '..');
    exec(`cd ${projectDir} && git add public/data/classement.json && git commit -m "📊 Classement auto" && git push origin master`, (err) => {
      if (err && !err.message.includes('nothing to commit')) {
        console.error('Git error:', err.message);
      } else {
        console.log('✅ Classement exporté et pushé');
      }
    });

  } catch (error) {
    console.error('❌ Erreur export:', error.message);
  }
}

app.get('/api/admin/ranking/:leagueId/export', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const ranking = await generateRanking(req.params.leagueId);
  res.json({ league_id: req.params.leagueId, generated_at: new Date().toISOString(), ranking });
});

// ============================================
// WEBHOOK GITHUB
// ============================================
app.post('/api/webhook/github', (req, res) => {
  const { exec } = require('child_process');
  const event = req.headers['x-github-event'];

  if (event === 'push' && req.body.ref?.includes('master')) {
    res.json({ message: 'Deploying...' });

    const dir = path.join(__dirname, '..');
    exec(`cd ${dir} && git pull && cd backend && npm install && pm2 restart versant-api`);
  } else {
    res.json({ message: 'Ignored' });
  }
});

// ============================================
// CRON - TÂCHES AUTOMATIQUES
// ============================================

// Sync 5x par jour: 6h, 10h, 14h, 18h, 22h
cron.schedule('0 6 * * *', () => { console.log('🕐 Sync (6h)'); autoSyncAllLeagues(); });
cron.schedule('0 10 * * *', () => { console.log('🕐 Sync (10h)'); autoSyncAllLeagues(); });
cron.schedule('0 14 * * *', () => { console.log('🕐 Sync (14h)'); autoSyncAllLeagues(); });
cron.schedule('0 18 * * *', () => { console.log('🕐 Sync (18h)'); autoSyncAllLeagues(); });
cron.schedule('0 22 * * *', () => { console.log('🕐 Sync (22h)'); autoSyncAllLeagues(); });

// Export classement à 20h
cron.schedule('0 20 * * *', async () => {
  console.log('🕐 Tâches 20h...');
  await autoSyncAllLeagues();
  await exportAndPushRanking();
  await retryFailedWebhooks();
});

// Refresh tokens toutes les 2 heures
cron.schedule('30 */2 * * *', () => {
  console.log('🔄 Refresh préventif tokens');
  refreshAllTokensPreventively();
});

// ============================================
// DÉMARRAGE
// ============================================
initializeServer().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║     🚀 VERSANT SERVER v2.3             ║');
    console.log('╠════════════════════════════════════════╣');
    console.log(`║  Port: ${PORT}                             ║`);
    console.log('║  Syncs: 6h, 10h, 14h, 18h, 22h         ║');
    console.log('║  Refresh tokens: toutes les 2h        ║');
    console.log('║  Export classement: 20h               ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
  });
});