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

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const crypto = require('crypto');

// Import configuration partagée (source unique de vérité)
const { CHALLENGE_CONFIG, VALID_SPORTS, isValidSport, JOKER_IDS, INITIAL_JOKER_STOCK } = require('./shared-config');

// Import du module jokers
const { createJokersRoutes } = require('./jokers-routes');

// Import du module bonus éphémères
const { createBonusesRoutes } = require('./bonuses-routes');

// Import du module frozen results
const frozenResults = require('./frozen-results.js');


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Configuration Strava (unique)
const STRAVA_CONFIG = {
  clientId: process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const STRAVA_VERIFY_TOKEN = process.env.STRAVA_VERIFY_TOKEN || 'VERSANT2026';

const DATA_DIR = path.join(__dirname, 'data');
const LEAGUES_DIR = path.join(DATA_DIR, 'leagues');
const ATHLETES_FILE = path.join(DATA_DIR, 'athletes.json');
const JOKERS_FILE = path.join(DATA_DIR, 'jokers_usage.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const FAILED_WEBHOOKS_FILE = path.join(DATA_DIR, 'failed_webhooks.json');
const WEBHOOK_LOG_FILE = path.join(DATA_DIR, 'webhook_log.json');
const SPECIAL_RULES_FILE = path.join(DATA_DIR, 'special_rules.json');

// ============================================
// UTILITAIRES
// ============================================
function normalizeId(id) {
  if (id === null || id === undefined) return null;
  return String(id).trim();
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function verifyPassword(password, hash) {
  return hashPassword(password) === hash;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// FILE LOCKING
// ============================================
const fileLocks = new Map();

async function acquireLock(filePath, timeout = 15000) {
  const start = Date.now();
  while (fileLocks.get(filePath)) {
    if (Date.now() - start > timeout) {
      console.warn(`⚠️ Lock timeout: ${filePath}`);
      fileLocks.delete(filePath);
      break;
    }
    await sleep(50);
  }
  fileLocks.set(filePath, true);
}

function releaseLock(filePath) {
  fileLocks.delete(filePath);
}

async function safeReadJSON(filePath, defaultValue = []) {
  await acquireLock(filePath);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch {
    return defaultValue;
  } finally {
    releaseLock(filePath);
  }
}

async function safeWriteJSON(filePath, data) {
  await acquireLock(filePath);
  try {
    const tempPath = filePath + '.tmp';
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
    await fs.rename(tempPath, filePath);
  } finally {
    releaseLock(filePath);
  }
}

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
  const raw = await safeReadJSON(JOKERS_FILE, []);
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

/**
 * Lecture-modification-écriture atomique.
 * Le lock est maintenu pendant tout le cycle, éliminant les race conditions.
 * @param {string} filePath - Chemin du fichier JSON
 * @param {Function} modifyFn - Fonction (data) => modifiedData
 * @param {*} defaultValue - Valeur par défaut si le fichier n'existe pas
 * @returns {*} Les données modifiées
 */
async function safeModifyJSON(filePath, modifyFn, defaultValue = []) {
  await acquireLock(filePath);
  try {
    let data;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      data = JSON.parse(raw);
    } catch {
      data = defaultValue;
    }
    
    const modified = await modifyFn(data);
    
    const tempPath = filePath + '.tmp';
    await fs.writeFile(tempPath, JSON.stringify(modified, null, 2));
    await fs.rename(tempPath, filePath);
    
    return modified;
  } finally {
    releaseLock(filePath);
  }
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

  // Initialiser special_rules.json en tant qu'objet (pas tableau)
  try {
    await fs.access(SPECIAL_RULES_FILE);
  } catch {
    await fs.writeFile(SPECIAL_RULES_FILE, JSON.stringify({}, null, 2));
  }

  // Migration: corriger le format de jokers_usage.json si nécessaire
  try {
    const raw = JSON.parse(await fs.readFile(JOKERS_FILE, 'utf8'));
    if (!Array.isArray(raw)) {
      const normalized = normalizeJokerUsage(raw);
      await fs.writeFile(JOKERS_FILE, JSON.stringify(normalized, null, 2));
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

function checkAdmin(req, res) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Non autorisé' });
    return false;
  }
  return true;
}

// Monter le router jokers
const jokersRouter = createJokersRoutes({
  ATHLETES_FILE,
  JOKERS_FILE,
  FROZEN_FILE: path.join(DATA_DIR, 'frozen_results.json'),
  ADMIN_PASSWORD,
  requireAuth
});
app.use('/api', jokersRouter);

// Initialiser les routes bonus éphémères
createBonusesRoutes(app, requireAuth, checkAdmin);

// ============================================
// CONFIG ROUTE (publique)
// ============================================
app.get('/api/config', (req, res) => {
  res.json({
    challenge: CHALLENGE_CONFIG,
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
    const rules = await safeReadJSON(SPECIAL_RULES_FILE, {});
    res.json(rules);
  } catch (error) {
    res.json({});
  }
});

// POST admin - définir la règle spéciale pour un round
app.post('/api/admin/special-rules', async (req, res) => {
  try {
    const password = req.headers['x-admin-password'];
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Non autorisé' });
    }

    const { roundNumber, rule } = req.body;
    if (!roundNumber) return res.status(400).json({ error: 'roundNumber requis' });

    const rules = await safeReadJSON(SPECIAL_RULES_FILE, {});

    if (!rule || rule === 'standard') {
      // Supprimer l'override pour revenir à standard
      delete rules[String(roundNumber)];
    } else {
      rules[String(roundNumber)] = rule;
    }

    await fs.writeFile(SPECIAL_RULES_FILE, JSON.stringify(rules, null, 2));
    res.json({ success: true, rules });
  } catch (error) {
    console.error('Erreur special-rules:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE admin - supprimer toutes les règles spéciales
app.delete('/api/admin/special-rules', async (req, res) => {
  try {
    const password = req.headers['x-admin-password'];
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Non autorisé' });
    }

    await fs.writeFile(SPECIAL_RULES_FILE, JSON.stringify({}, null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
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
  try {
    const password = req.headers['x-admin-password'];
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Non autorisé' });
    }

    const seasonNumber = parseInt(req.params.seasonNumber);
    const { bonuses } = req.body;
    if (!bonuses || !Array.isArray(bonuses)) {
      return res.status(400).json({ error: 'bonuses (array) requis' });
    }

    const frozen = await frozenResults.getAllFrozenResults();
    if (!frozen.seasonBonuses) frozen.seasonBonuses = {};
    frozen.seasonBonuses[String(seasonNumber)] = bonuses;
    frozen.lastUpdated = new Date().toISOString();

    const FROZEN_FILE_PATH = path.join(DATA_DIR, 'frozen_results.json');
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

    const response = await axios.post('https://www.strava.com/oauth/token', {
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

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Données manquantes' });

    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const athlete = athletes.find(a => a.email?.toLowerCase() === email.toLowerCase());

    if (!athlete || !verifyPassword(password, athlete.password_hash)) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

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

    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const idx = athletes.findIndex(a => normalizeId(a.id) === normalizeId(athleteId));

    if (idx === -1) {
      return res.status(404).json({ error: 'Athlète non trouvé' });
    }

    // Hasher le nouveau mot de passe
    athletes[idx].password_hash = hashPassword(newPassword);

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

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const athleteId = await validateSession(token);
    if (!athleteId) return res.status(401).json({ error: 'Non authentifié' });

    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const athlete = athletes.find(a => normalizeId(a.id) === normalizeId(athleteId));
    if (!athlete) return res.status(404).json({ error: 'Athlète non trouvé' });

    // Calculer les jokers restants
    const jokerUsage = await readJokerUsage();
    const usedByAthlete = jokerUsage.filter(j => normalizeId(j.athlete_id) === normalizeId(athleteId));

    const availableJokers = JOKER_IDS.filter(jokerId => {
      const usedCount = usedByAthlete.filter(j => j.joker_id === jokerId).length;
      return usedCount < INITIAL_JOKER_STOCK;
    });

    res.json({
      id: athlete.id,
      name: athlete.name,
      email: athlete.email,
      league_id: athlete.league_id,
      jokers: availableJokers
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// ATHLETES ROUTES
// ============================================
app.post('/api/athletes/register', async (req, res) => {
  try {
    const { athlete_id, name, email, password, strava_data, access_token, refresh_token, expires_at, league_id } = req.body;

    if (!athlete_id || !name || !league_id || !password || !email) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court' });
    }

    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const normalizedId = normalizeId(athlete_id);

    if (athletes.find(a => a.email?.toLowerCase() === email.toLowerCase())) {
      return res.status(400).json({ error: 'Email déjà utilisé' });
    }

    if (athletes.find(a => normalizeId(a.id) === normalizedId && a.league_id === league_id)) {
      return res.status(400).json({ error: 'Déjà inscrit' });
    }

    athletes.push({
      id: normalizedId,
      name,
      email,
      password_hash: hashPassword(password),
      league_id,
      strava_profile: strava_data,
      registered_at: new Date().toISOString(),
      tokens: { access_token, refresh_token, expires_at },
      active: true
    });

    await safeWriteJSON(ATHLETES_FILE, athletes);
    const token = await createSession(normalizedId);
    console.log(`✅ Athlète inscrit: ${name}`);
    res.json({ success: true, athlete_id: normalizedId, token });
  } catch (error) {
    res.status(500).json({ error: 'Erreur inscription' });
  }
});

app.get('/api/athletes/:leagueId', async (req, res) => {
  try {
    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const leagueAthletes = athletes
      .filter(a => a.league_id === req.params.leagueId && a.active)
      .map(a => ({ id: a.id, name: a.name, email: a.email, registered_at: a.registered_at }));
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
    JOKER_IDS.forEach(jokerId => {
      const usedCount = myUsage.filter(j => j.joker_id === jokerId).length;
      stock[jokerId] = Math.max(0, INITIAL_JOKER_STOCK - usedCount);
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

    if (!joker_id || round_number === undefined) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const athlete = athletes.find(a => normalizeId(a.id) === normalizeId(req.athleteId));

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
        let targetSeason = null;
        const targetRoundEntry = frozenData.rounds[String(round_number)];
        if (targetRoundEntry?.seasonNumber != null) {
          targetSeason = Number(targetRoundEntry.seasonNumber);
        } else {
          try {
            const athletes2 = await safeReadJSON(ATHLETES_FILE, []);
            const totalParticipants = athletes2.filter(a =>
              a.league_id === (req.body.leagueId || 'versant-2026') && a.active
            ).length;
            if (totalParticipants >= 2) {
              const { getSeasonNumber } = require('./shared-config');
              targetSeason = getSeasonNumber(round_number, totalParticipants);
            }
          } catch {}
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

    // Pré-calculer le nombre d'usages dans frozen results pour cet athlète et ce joker
    let frozenUsageCount = 0;
    try {
      const frozenData = await frozenResults.getAllFrozenResults();
      if (frozenData?.rounds) {
        for (const [roundKey, roundData] of Object.entries(frozenData.rounds)) {
          const jokersUsed = roundData.jokersUsed || [];
          frozenUsageCount += jokersUsed.filter(j =>
            String(j.athleteId) === normalizeId(req.athleteId) && j.jokerId === joker_id
          ).length;
        }
      }
    } catch (e) {}

    // Lecture-vérification-écriture atomique (pas de race condition)
    let resultUsage = null;
    let error = null;

    await safeModifyJSON(JOKERS_FILE, (rawData) => {
      const jokerUsage = normalizeJokerUsage(rawData);
      const myUsage = jokerUsage.filter(j => normalizeId(j.athlete_id) === normalizeId(req.athleteId));
      const fileUsedCount = myUsage.filter(j => j.joker_id === joker_id).length;
      const totalUsedCount = fileUsedCount + frozenUsageCount;

      if (totalUsedCount >= INITIAL_JOKER_STOCK) {
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
    await safeWriteJSON(JOKERS_FILE, []);
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

// Admin: Télécharger jokers_usage.json (format tableau, importable directement)
app.get('/api/admin/jokers/download', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = await fs.readFile(JOKERS_FILE, 'utf8');
    res.setHeader('Content-Disposition', 'attachment; filename=jokers_usage.json');
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  } catch {
    res.status(404).json({ error: 'Fichier non trouvé' });
  }
});

// ============================================
// ACTIVITIES ROUTES
// ============================================
app.get('/api/activities/:leagueId', async (req, res) => {
  try {
    const activitiesFile = path.join(LEAGUES_DIR, `${req.params.leagueId}_activities.json`);
    const activities = await safeReadJSON(activitiesFile, []);
    res.json(activities);
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/activities-status/:leagueId', async (req, res) => {
  try {
    const activitiesFile = path.join(LEAGUES_DIR, `${req.params.leagueId}_activities.json`);
    const stats = await fs.stat(activitiesFile).catch(() => null);
    const activities = await safeReadJSON(activitiesFile, []);

    let lastActivity = null;
    if (activities.length > 0) {
      const sorted = [...activities].sort((a, b) => new Date(b.synced_at || b.start_date) - new Date(a.synced_at || a.start_date));
      lastActivity = { id: sorted[0].id, name: sorted[0].name, athlete_name: sorted[0].athlete_name, synced_at: sorted[0].synced_at };
    }

    res.json({ count: activities.length, lastModified: stats?.mtime?.toISOString() || null, lastActivity });
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

      const response = await axios.post('https://www.strava.com/oauth/token', {
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

async function refreshAllTokens() {
  console.log('🔄 Refresh préventif des tokens...');

  const athletes = await safeReadJSON(ATHLETES_FILE, []);
  const now = Date.now() / 1000;
  let refreshed = 0;

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
        refreshed++;
      }
      await sleep(500); // Pause entre chaque refresh
    }
  }

  if (refreshed > 0) {
    await safeWriteJSON(ATHLETES_FILE, athletes);
    console.log(`   ✅ ${refreshed} tokens rafraîchis`);
  }
}

// ============================================
// SYNC MANUAL - AVEC MISE À JOUR DES ACTIVITÉS
// ============================================
async function syncLeague(leagueId, startDate, endDate, options = {}) {
  const { updateExisting = true } = options; // Par défaut, on met à jour les existantes

  console.log(`🔄 Sync ${leagueId}: ${startDate} → ${endDate} (update=${updateExisting})`);

  const athletes = await safeReadJSON(ATHLETES_FILE, []);
  const leagueAthletes = athletes.filter(a => a.league_id === leagueId && a.active);

  const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);
  let activities = await safeReadJSON(activitiesFile, []);

  let totalNew = 0;
  let totalUpdated = 0;
  const errors = [];

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
        athletes[i].tokens = { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: result.expires_at };
      }

      const afterTs = Math.floor(new Date(startDate).getTime() / 1000);
      const beforeTs = Math.floor(new Date(endDate).getTime() / 1000) + 86400;

      const response = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
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

  await safeWriteJSON(ATHLETES_FILE, athletes);
  await safeWriteJSON(activitiesFile, activities);

  console.log(`   ✅ Total: ${totalNew} nouvelles, ${totalUpdated} mises à jour`);
  return { success: true, totalNew, totalUpdated, errors };
}

app.post('/api/sync/:leagueId', async (req, res) => {
  try {
    const start = req.body.startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const end = req.body.endDate || new Date().toISOString().split('T')[0];
    const result = await syncLeague(req.params.leagueId, start, end);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Erreur sync' });
  }
});

async function autoSyncAllLeagues() {
  console.log('🔄 Sync automatique...');
  await refreshAllTokens();

  const athletes = await safeReadJSON(ATHLETES_FILE, []);
  const leagues = [...new Set(athletes.map(a => a.league_id).filter(Boolean))];

  const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const end = new Date().toISOString().split('T')[0];

  for (const leagueId of leagues) {
    await syncLeague(leagueId, start, end);
  }

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

async function processOneWebhook(event) {
  const ownerId = normalizeId(event.owner_id);
  const objectId = event.object_id;

  console.log(`   📋 Traitement: owner=${ownerId} object=${objectId}`);

  if (event.object_type !== 'activity') {
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
  const leagueId = athlete.league_id;
  const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);

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
      await safeWriteJSON(ATHLETES_FILE, athletes);
    }

    // Fetch activité avec retry et délais
    let stravaActivity = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`   🌐 Fetch (${attempt}/3)...`);

        // Attendre un peu avant chaque tentative (Strava peut avoir un délai)
        if (attempt > 1) await sleep(3000);

        const response = await axios.get(
          `https://www.strava.com/api/v3/activities/${objectId}`,
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

    // Utilise VALID_SPORTS importé de shared-config
    const actType = stravaActivity.sport_type || stravaActivity.type;

    if (!VALID_SPORTS.includes(actType)) {
      console.log(`   → Ignoré (type: ${actType})`);
      await logWebhook(event, 'ignored', { reason: 'invalid_type', type: actType });
      return;
    }

    let activities = await safeReadJSON(activitiesFile, []);

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

    await safeWriteJSON(activitiesFile, activities);

    console.log(`   ✅ Ajouté: ${stravaActivity.name} (+${stravaActivity.total_elevation_gain}m)`);
    await logWebhook(event, 'success', { name: stravaActivity.name, elevation: stravaActivity.total_elevation_gain });

  } else if (event.aspect_type === 'delete') {
    let activities = await safeReadJSON(activitiesFile, []);
    const before = activities.length;
    activities = activities.filter(a => a.id !== objectId);

    if (activities.length < before) {
      await safeWriteJSON(activitiesFile, activities);
      console.log(`   🗑️ Supprimé`);
      await logWebhook(event, 'deleted', {});
    }
  } else if (event.aspect_type === 'update') {
    // Activité modifiée sur Strava - la mettre à jour localement
    let activities = await safeReadJSON(activitiesFile, []);
    const existingIndex = activities.findIndex(a => a.id === objectId);

    if (existingIndex < 0) {
      console.log(`   → Activité ${objectId} non trouvée localement, ignorée`);
      await logWebhook(event, 'ignored', { reason: 'activity_not_found' });
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
      await safeWriteJSON(ATHLETES_FILE, athletes);
    }

    try {
      console.log(`   🌐 Fetch update...`);
      const response = await axios.get(
        `https://www.strava.com/api/v3/activities/${objectId}`,
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

      await safeWriteJSON(activitiesFile, activities);

      console.log(`   🔄 MAJ: ${changes.join(', ')}`);
      await logWebhook(event, 'updated', { changes, name: stravaActivity.name });

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
  res.json({ message: 'Logs effacés' });
});

app.get('/api/admin/strava/status', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const response = await axios.get('https://www.strava.com/api/v3/push_subscriptions', {
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
    const check = await axios.get('https://www.strava.com/api/v3/push_subscriptions', {
      params: { client_id: STRAVA_CONFIG.clientId, client_secret: STRAVA_CONFIG.clientSecret }
    });

    if (check.data.length > 0) {
      return res.json({ message: 'Déjà abonné', subscription: check.data[0] });
    }

    const response = await axios.post('https://www.strava.com/api/v3/push_subscriptions', {
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
      expired: athletes.filter(a => a.tokens?.expires_at && a.tokens.expires_at < now).length
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

app.get('/api/admin/athletes/download', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const data = await fs.readFile(ATHLETES_FILE, 'utf8');
  res.setHeader('Content-Disposition', 'attachment; filename=athletes.json');
  res.send(data);
});

app.get('/api/admin/activities/:leagueId/download', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = await fs.readFile(path.join(LEAGUES_DIR, `${req.params.leagueId}_activities.json`), 'utf8');
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

    const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);
    let activities = await safeReadJSON(activitiesFile, []);

    const activityIndex = activities.findIndex(a => String(a.id) === String(activityId));
    if (activityIndex < 0) {
      return res.status(404).json({ error: 'Activité non trouvée' });
    }

    activities[activityIndex].excluded = exclude;
    activities[activityIndex].excluded_at = exclude ? new Date().toISOString() : null;
    activities[activityIndex].excluded_reason = exclude ? 'Exclu par admin' : null;

    await safeWriteJSON(activitiesFile, activities);

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
    const leagueAthletes = athletes.filter(a => a.league_id === req.params.leagueId && a.active);
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
    const leagueId = req.body.leagueId || 'versant-2026';

    const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);
    const activities = await safeReadJSON(activitiesFile, []);
    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const leagueAthletes = athletes.filter(a => a.league_id === leagueId && a.active);
    const jokerUsage = await readJokerUsage();

    const result = await frozenResults.freezeRoundResults(
      roundNumber,
      activities,
      leagueAthletes,
      jokerUsage,
      CHALLENGE_CONFIG
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
    const leagueId = req.body.leagueId || 'versant-2026';

    const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);
    const activities = await safeReadJSON(activitiesFile, []);
    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const leagueAthletes = athletes.filter(a => a.league_id === leagueId && a.active);
    const jokerUsage = await readJokerUsage();

    const frozen = await frozenResults.autoFreezeCompletedRounds(
      activities,
      leagueAthletes,
      jokerUsage,
      CHALLENGE_CONFIG
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
    const leagueId = req.body?.leagueId || 'versant-2026';
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

// Admin: Figer un round avec des données pré-calculées du frontend
// Cette route accepte les données exactes affichées sur la page principale
app.post('/api/admin/freeze-round-with-data/:roundNumber', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    const roundNumber = parseInt(req.params.roundNumber);
    const { roundData, force } = req.body;

    if (!roundData) {
      return res.status(400).json({ error: 'roundData manquant dans le body' });
    }

    const result = await frozenResults.freezeRoundWithData(
      roundNumber,
      roundData,
      { force: force === true }
    );

    if (result.success) {
      res.json({ success: true, round: result.round, method: result.method });
    } else {
      res.status(400).json({ success: false, error: result.error, existing: result.existing });
    }
  } catch (error) {
    console.error('Erreur freeze with data:', error);
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
// GITHUB WEBHOOK
// ============================================
app.post('/api/webhook/github', (req, res) => {
  const { exec } = require('child_process');
  if (req.headers['x-github-event'] === 'push' && req.body.ref?.includes('master')) {
    res.json({ message: 'Deploying...' });
    exec(`cd ${path.join(__dirname, '..')} && git pull && cd backend && npm install && pm2 restart versant-api`);
  } else {
    res.json({ message: 'Ignored' });
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

// Auto-freeze des rounds terminés à 00h05 (après minuit)
cron.schedule('5 0 * * *', async () => {
  console.log('❄️ Auto-freeze des rounds terminés...');
  try {
    const leagueId = 'versant-2026';
    const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);
    const activities = await safeReadJSON(activitiesFile, []);
    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const leagueAthletes = athletes.filter(a => a.league_id === leagueId && a.active);
    const jokerUsage = await readJokerUsage();
    
    const frozen = await frozenResults.autoFreezeCompletedRounds(
      activities, leagueAthletes, jokerUsage, CHALLENGE_CONFIG
    );
    
    console.log(`❄️ ${frozen.length} round(s) figé(s)`);
  } catch (error) {
    console.error('❌ Erreur auto-freeze:', error);
  }
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
 * Au démarrage : vérifier s'il y a des rounds en retard de freeze.
 * Couvre le cas où le serveur était down au moment du cron 00h05.
 */
async function catchUpAutoFreezeOnStartup() {
  try {
    const leagueId = 'versant-2026';
    const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);
    const activities = await safeReadJSON(activitiesFile, []);
    const athletes = await safeReadJSON(ATHLETES_FILE, []);
    const leagueAthletes = athletes.filter(a => a.league_id === leagueId && a.active);
    const jokerUsage = await readJokerUsage();

    if (leagueAthletes.length === 0) {
      console.log('🚀 Catch-up auto-freeze: aucun athlète actif, skip');
      return;
    }

    const frozen = await frozenResults.autoFreezeCompletedRounds(
      activities, leagueAthletes, jokerUsage, CHALLENGE_CONFIG
    );

    if (frozen.length > 0) {
      console.log(`🚀 Catch-up auto-freeze au démarrage : ${frozen.length} round(s) figé(s) en retard`);
      frozen.forEach(r => {
        console.log(`   ❄️ Round ${r.roundNumber} (saison ${r.seasonNumber})`);
      });
    } else {
      console.log('🚀 Catch-up auto-freeze: tout est à jour');
    }
  } catch (error) {
    console.error('⚠️ Erreur catch-up auto-freeze au démarrage:', error.message);
    // Ne pas bloquer le démarrage du serveur si le catch-up échoue
  }
}

initializeServer().then(async () => {
  app.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║     🚀 VERSANT SERVER v2.6             ║');
    console.log('╠════════════════════════════════════════╣');
    console.log(`║  Port: ${PORT}                             ║`);
    console.log('║  Syncs: 6h, 10h, 14h, 18h, 22h         ║');
    console.log('║  Auto-freeze: 00h05 + au démarrage     ║');
    console.log('║  Refresh tokens: toutes les 2h        ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
  });

  // Catch-up auto-freeze au démarrage (différé de quelques secondes pour
  // laisser le serveur se stabiliser avant de toucher aux fichiers).
  setTimeout(() => {
    catchUpAutoFreezeOnStartup();
  }, 5000);
});