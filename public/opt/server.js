/**
 * ============================================
 * VERSANT - SERVEUR BACKEND v2.1
 * ============================================
 * Features:
 * - Login avec mot de passe
 * - Gestion des jokers
 * - Interface admin
 * - Règles avancées (activités, saisons, horaires)
 * - Webhook Strava amélioré avec retry
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

// Import du module jokers amélioré
const { createJokersRoutes, JOKER_CONFIG, createInitialJokersStock } = require('./jokers-routes');

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

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // À changer !

// Chemins
const DATA_DIR = path.join(__dirname, 'data');
const LEAGUES_DIR = path.join(DATA_DIR, 'leagues');
const ATHLETES_FILE = path.join(DATA_DIR, 'athletes.json');
const JOKERS_FILE = path.join(DATA_DIR, 'jokers_usage.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const FAILED_WEBHOOKS_FILE = path.join(DATA_DIR, 'failed_webhooks.json');

// ============================================
// UTILITAIRES - HASH MOT DE PASSE
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
// UTILITAIRES - GESTION HORAIRES
// ============================================
/**
 * Obtenir la date/heure de fin de round (20h)
 * Si activité après 20h, elle compte pour le round suivant
 */
function getRoundEndTime(roundEndDate) {
  const endDate = new Date(roundEndDate);
  endDate.setHours(20, 0, 0, 0); // 20h00
  return endDate;
}

/**
 * Vérifier si une activité compte pour un round
 * Règle : Si l'activité se termine après 20h, elle compte pour le round suivant
 */
function activityCountsForRound(activity, roundStartDate, roundEndDate) {
  const activityEnd = new Date(activity.start_date);
  if (activity.elapsed_time) {
    activityEnd.setSeconds(activityEnd.getSeconds() + activity.elapsed_time);
  }

  const roundStart = new Date(roundStartDate);
  roundStart.setHours(0, 0, 0, 0);

  const roundEnd = getRoundEndTime(roundEndDate);

  // L'activité doit se terminer avant 20h le dernier jour
  return activityEnd >= roundStart && activityEnd < roundEnd;
}

// ============================================
// INITIALISATION
// ============================================
async function initializeServer() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(LEAGUES_DIR, { recursive: true });

  // Initialiser les fichiers
  for (const file of [ATHLETES_FILE, JOKERS_FILE, SESSIONS_FILE, FAILED_WEBHOOKS_FILE]) {
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
  const sessions = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));

  sessions.push({
    token,
    athlete_id: athleteId,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 jours
  });

  await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  return token;
}

async function validateSession(token) {
  if (!token) return null;

  const sessions = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  const session = sessions.find(s => s.token === token);

  if (!session) return null;

  // Vérifier l'expiration
  if (new Date(session.expires_at) < new Date()) {
    return null;
  }

  return session.athlete_id;
}

// Middleware d'authentification
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
// INTÉGRATION ROUTES JOKERS AMÉLIORÉES
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

/**
 * Échange Strava code → token
 */
app.post('/api/auth/strava/exchange', async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Code manquant' });
    }

    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: STRAVA_CONFIG.clientId,
      client_secret: STRAVA_CONFIG.clientSecret,
      code: code,
      grant_type: 'authorization_code'
    });

    const { access_token, refresh_token, expires_at, athlete } = response.data;

    res.json({
      access_token,
      refresh_token,
      expires_at,
      athlete
    });

  } catch (error) {
    console.error('Erreur échange token Strava:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Échec de l\'authentification Strava',
      details: error.response?.data
    });
  }
});

/**
 * LOGIN - Connexion avec email + mot de passe
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    // Charger les athlètes
    const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));

    // Chercher par email (insensible à la casse)
    const athlete = athletes.find(a =>
      a.email && a.email.toLowerCase() === email.toLowerCase()
    );

    if (!athlete) {
      return res.status(401).json({ error: 'Aucun compte trouvé avec cet email' });
    }

    if (!athlete.password_hash) {
      return res.status(401).json({ error: 'Mot de passe non défini pour ce compte' });
    }

    // Vérifier le mot de passe
    if (!verifyPassword(password, athlete.password_hash)) {
      return res.status(401).json({ error: 'Mot de passe incorrect' });
    }

    // Créer une session
    const token = await createSession(athlete.id);

    res.json({
      success: true,
      token,
      athlete: {
        id: athlete.id,
        name: athlete.name,
        email: athlete.email,
        league_id: athlete.league_id
      }
    });

  } catch (error) {
    console.error('Erreur login:', error);
    res.status(500).json({ error: 'Erreur lors de la connexion' });
  }
});

/**
 * LOGOUT
 */
app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const sessions = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
      const filtered = sessions.filter(s => s.token !== token);
      await fs.writeFile(SESSIONS_FILE, JSON.stringify(filtered, null, 2));
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur logout' });
  }
});

/**
 * Vérifier si connecté
 */
app.get('/api/auth/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const athleteId = await validateSession(token);

    if (!athleteId) {
      return res.status(401).json({ error: 'Non authentifié' });
    }

    const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
    const athlete = athletes.find(a => a.id === athleteId);

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

/**
 * Inscrire un nouvel athlète AVEC mot de passe
 */
app.post('/api/athletes/register', async (req, res) => {
  try {
    const {
      athlete_id,
      name,
      email,
      password,  // NOUVEAU
      strava_data,
      access_token,
      refresh_token,
      expires_at,
      league_id
    } = req.body;

    if (!athlete_id || !name || !league_id || !password || !email) {
      return res.status(400).json({ error: 'Données manquantes (ID, nom, email, ligue, mot de passe requis)' });
    }

    // Vérifier le format de l'email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Format d\'email invalide' });
    }

    // Vérifier si l'email est déjà utilisé
    const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
    const emailExists = athletes.find(a =>
      a.email && a.email.toLowerCase() === email.toLowerCase()
    );

    if (emailExists) {
      return res.status(400).json({ error: 'Cet email est déjà utilisé par un autre compte' });
    }

    // Vérifier la force du mot de passe (minimum 6 caractères)
    if (password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }

    // Vérifier si déjà inscrit dans cette ligue
    const existingIndex = athletes.findIndex(a => a.id === athlete_id && a.league_id === league_id);

    if (existingIndex >= 0) {
      return res.status(400).json({ error: 'Déjà inscrit dans cette ligue' });
    }

    // Charger la config de la ligue pour vérifier la saison
    const leagueConfigPath = path.join(LEAGUES_DIR, `${league_id}_config.json`);
    let currentSeason = 1;
    let canJoinNow = true;

    try {
      const configData = await fs.readFile(leagueConfigPath, 'utf8');
      const config = JSON.parse(configData);
      currentSeason = config.current_season || 1;

      // Règle : Si saison en cours, inscription valable pour la prochaine saison
      const now = new Date();
      const seasonStart = new Date(config.season_start_date);

      if (now > seasonStart) {
        canJoinNow = false;
        currentSeason += 1;
      }
    } catch {
      // Pas de config = première saison
    }

    const athleteRecord = {
      id: athlete_id,
      name: name,
      email: email || null,
      password_hash: hashPassword(password), // HASH du mot de passe
      league_id: league_id,
      strava_profile: strava_data,
      registered_at: new Date().toISOString(),
      active_from_season: currentSeason, // NOUVELLE RÈGLE
      tokens: {
        access_token: access_token,
        refresh_token: refresh_token,
        expires_at: expires_at
      },
      jokers: ["duel", "multiplicateur", "bouclier", "sabotage"],
      jokers_used: [], // Historique des jokers utilisés
      active: canJoinNow
    };

    athletes.push(athleteRecord);

    // Sauvegarder
    await fs.writeFile(ATHLETES_FILE, JSON.stringify(athletes, null, 2));

    // Créer une session
    const token = await createSession(athlete_id);

    console.log(`✅ Athlète inscrit: ${name} (${athlete_id}) - Ligue: ${league_id} - Saison: ${currentSeason}`);

    res.json({
      success: true,
      athlete_id,
      token, // Retourner le token pour connexion auto
      active_from_season: currentSeason,
      message: canJoinNow
        ? 'Inscription réussie'
        : `Inscription réussie - Vous rejoindrez la ligue à la saison ${currentSeason}`
    });

  } catch (error) {
    console.error('Erreur inscription:', error);
    res.status(500).json({ error: 'Erreur lors de l\'inscription' });
  }
});

/**
 * Liste des athlètes d'une ligue
 */
app.get('/api/athletes/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));

    // Filtrer par ligue et retirer les données sensibles
    const leagueAthletes = athletes
      .filter(a => a.league_id === leagueId && a.active)
      .map(a => ({
        id: a.id,
        name: a.name,
        email: a.email,
        registered_at: a.registered_at,
        active_from_season: a.active_from_season
      }));

    res.json(leagueAthletes);
  } catch (error) {
    console.error('Erreur récupération athlètes:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// ROUTES - JOKERS
// ============================================

/**
 * Utiliser un joker
 */
app.post('/api/jokers/use', requireAuth, async (req, res) => {
  try {
    const { joker_id, target_athlete_id, round_number } = req.body;
    const athleteId = req.athleteId;

    if (!joker_id || !round_number) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    // Charger l'athlète
    const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
    const athleteIndex = athletes.findIndex(a => a.id === athleteId);

    if (athleteIndex < 0) {
      return res.status(404).json({ error: 'Athlète non trouvé' });
    }

    const athlete = athletes[athleteIndex];

    // Vérifier que le joker est disponible
    if (!athlete.jokers || !athlete.jokers.includes(joker_id)) {
      return res.status(400).json({ error: 'Joker non disponible' });
    }

    // Vérifier qu'il n'a pas déjà été utilisé ce round
    const jokerUsage = JSON.parse(await fs.readFile(JOKERS_FILE, 'utf8'));
    const alreadyUsed = jokerUsage.find(
      j => j.athlete_id === athleteId &&
           j.joker_id === joker_id &&
           j.round_number === round_number
    );

    if (alreadyUsed) {
      return res.status(400).json({ error: 'Joker déjà utilisé ce round' });
    }

    // Enregistrer l'utilisation
    const usage = {
      athlete_id: athleteId,
      joker_id: joker_id,
      target_athlete_id: target_athlete_id || null,
      round_number: round_number,
      used_at: new Date().toISOString(),
      status: 'active'
    };

    jokerUsage.push(usage);
    await fs.writeFile(JOKERS_FILE, JSON.stringify(jokerUsage, null, 2));

    // Retirer le joker de la liste disponible
    athlete.jokers = athlete.jokers.filter(j => j !== joker_id);
    athlete.jokers_used = athlete.jokers_used || [];
    athlete.jokers_used.push(usage);

    athletes[athleteIndex] = athlete;
    await fs.writeFile(ATHLETES_FILE, JSON.stringify(athletes, null, 2));

    console.log(`🃏 Joker utilisé: ${joker_id} par ${athlete.name} (Round ${round_number})`);

    res.json({
      success: true,
      message: 'Joker activé avec succès',
      usage
    });

  } catch (error) {
    console.error('Erreur utilisation joker:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Récupérer les jokers d'un athlète
 */
app.get('/api/jokers/my', requireAuth, async (req, res) => {
  try {
    const athleteId = req.athleteId;
    const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
    const athlete = athletes.find(a => a.id === athleteId);

    if (!athlete) {
      return res.status(404).json({ error: 'Athlète non trouvé' });
    }

    res.json({
      available: athlete.jokers || [],
      used: athlete.jokers_used || []
    });

  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Récupérer tous les jokers actifs d'un round
 */
app.get('/api/jokers/round/:roundNumber', async (req, res) => {
  try {
    const { roundNumber } = req.params;
    const jokerUsage = JSON.parse(await fs.readFile(JOKERS_FILE, 'utf8'));

    const roundJokers = jokerUsage.filter(
      j => j.round_number === parseInt(roundNumber) && j.status === 'active'
    );

    res.json(roundJokers);
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// ROUTES - ACTIVITÉS
// ============================================

/**
 * Récupérer les activités d'une ligue
 * Applique la règle des 20h
 */
app.get('/api/activities/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { round_number, start_date, end_date } = req.query;

    const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);

    try {
      const data = await fs.readFile(activitiesFile, 'utf8');
      let activities = JSON.parse(data);

      // Filtrer par round si spécifié (avec règle 20h)
      if (round_number && start_date && end_date) {
        activities = activities.filter(a =>
          activityCountsForRound(a, start_date, end_date)
        );
      }

      res.json(activities);
    } catch {
      res.json([]);
    }

  } catch (error) {
    console.error('Erreur récupération activités:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Statut des activités pour le polling (léger)
 * Retourne juste le count et le timestamp de dernière modification
 */
app.get('/api/activities-status/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);

    try {
      const stats = await fs.stat(activitiesFile);
      const data = await fs.readFile(activitiesFile, 'utf8');
      const activities = JSON.parse(data);

      // Trouver la dernière activité ajoutée
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

      res.json({
        count: activities.length,
        lastModified: stats.mtime.toISOString(),
        lastActivity
      });
    } catch {
      res.json({ count: 0, lastModified: null, lastActivity: null });
    }

  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Endpoint de diagnostic complet
 */
app.get('/api/debug/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);

    // Charger activités
    let activities = [];
    try {
      activities = JSON.parse(await fs.readFile(activitiesFile, 'utf8'));
    } catch {}

    // Charger athlètes
    let athletes = [];
    try {
      const allAthletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
      athletes = allAthletes.filter(a => a.league_id === leagueId);
    } catch {}

    // Analyser les formats
    const withAthleteObj = activities.filter(a => a.athlete && a.athlete.id);
    const withAthleteId = activities.filter(a => a.athlete_id);
    const fromWebhook = activities.filter(a => a.source === 'webhook');
    const fromSync = activities.filter(a => a.source !== 'webhook');

    // Dates
    const dates = activities.map(a => a.start_date?.substring(0, 10)).filter(Boolean);
    const uniqueDates = [...new Set(dates)].sort().reverse();

    // Activités depuis le 2 février 2026
    const challengeStart = new Date('2026-02-02');
    const sinceChallenge = activities.filter(a => new Date(a.start_date) >= challengeStart);

    res.json({
      summary: {
        totalActivities: activities.length,
        totalAthletes: athletes.length,
        activitiesSinceChallengeStart: sinceChallenge.length,
        fromWebhook: fromWebhook.length,
        fromSync: fromSync.length,
        withAthleteObject: withAthleteObj.length,
        withAthleteIdOnly: withAthleteId.length - withAthleteObj.length,
        missingAthleteInfo: activities.length - withAthleteId.length
      },
      dates: {
        mostRecent: uniqueDates.slice(0, 10),
        challengeStart: '2026-02-02',
        activitiesInCurrentRound: sinceChallenge.length
      },
      athletes: athletes.map(a => ({
        id: a.id,
        name: a.name,
        active: a.active,
        activityCount: activities.filter(act =>
          String(act.athlete?.id) === String(a.id) || String(act.athlete_id) === String(a.id)
        ).length
      })),
      recentActivities: activities
        .sort((a, b) => new Date(b.start_date) - new Date(a.start_date))
        .slice(0, 20)
        .map(a => ({
          id: a.id,
          name: a.name,
          date: a.start_date?.substring(0, 10),
          elevation: a.total_elevation_gain,
          source: a.source || 'sync',
          athleteObj: a.athlete?.id || null,
          athleteId: a.athlete_id || null,
          athleteName: a.athlete_name || null
        })),
      issues: [
        ...(withAthleteObj.length < activities.length ?
          [`${activities.length - withAthleteObj.length} activités sans athlete.id (problème de filtrage)`] : []),
        ...(sinceChallenge.length === 0 ?
          ['Aucune activité depuis le début du challenge (02/02/2026)'] : []),
        ...(athletes.length === 0 ?
          ['Aucun athlète inscrit'] : [])
      ]
    });

  } catch (error) {
    console.error('Erreur debug:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ROUTES - ADMIN
// ============================================

/**
 * Login admin
 */
app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body;

    if (password === ADMIN_PASSWORD) {
      const token = generateToken();
      res.json({ success: true, token, role: 'admin' });
    } else {
      res.status(401).json({ error: 'Mot de passe incorrect' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Télécharger le fichier athletes.json
 */
app.get('/api/admin/athletes/download', async (req, res) => {
  try {
    const password = req.headers['x-admin-password'];

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Non autorisé' });
    }

    const data = await fs.readFile(ATHLETES_FILE, 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=athletes.json');
    res.send(data);

  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Télécharger les activités d'une ligue
 */
app.get('/api/admin/activities/:leagueId/download', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const password = req.headers['x-admin-password'];

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Non autorisé' });
    }

    const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);
    const data = await fs.readFile(activitiesFile, 'utf8');

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=${leagueId}_activities.json`);
    res.send(data);

  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Télécharger le fichier jokers_usage.json
 */
app.get('/api/admin/jokers/download', async (req, res) => {
  try {
    const password = req.headers['x-admin-password'];

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Non autorisé' });
    }

    const data = await fs.readFile(JOKERS_FILE, 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=jokers_usage.json');
    res.send(data);

  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Récupérer les données jokers pour l'admin
 */
app.get('/api/admin/jokers/:leagueId', async (req, res) => {
  try {
    const password = req.headers['x-admin-password'];

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Non autorisé' });
    }

    const { leagueId } = req.params;

    // Charger les athlètes de la ligue
    const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
    const leagueAthletes = athletes.filter(a => a.league_id === leagueId);

    // Charger l'historique des jokers
    let usage = [];
    try {
      usage = JSON.parse(await fs.readFile(JOKERS_FILE, 'utf8'));
    } catch {}

    res.json({
      athletes: leagueAthletes,
      usage: usage.filter(u => leagueAthletes.some(a => a.id === u.athleteId))
    });

  } catch (error) {
    console.error('Erreur admin jokers:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Mettre à jour les jokers d'un athlète
 */
app.put('/api/admin/jokers/:athleteId', async (req, res) => {
  try {
    const password = req.headers['x-admin-password'];

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Non autorisé' });
    }

    const { athleteId } = req.params;
    const { jokerStock } = req.body;

    const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
    const index = athletes.findIndex(a => String(a.id) === String(athleteId));

    if (index === -1) {
      return res.status(404).json({ error: 'Athlète non trouvé' });
    }

    athletes[index].jokerStock = jokerStock;
    await fs.writeFile(ATHLETES_FILE, JSON.stringify(athletes, null, 2));

    console.log(`🃏 Jokers mis à jour pour ${athleteId}:`, jokerStock);
    res.json({ success: true, jokerStock });

  } catch (error) {
    console.error('Erreur mise à jour jokers:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Réinitialiser tous les jokers d'une ligue
 */
app.post('/api/admin/jokers/reset/:leagueId', async (req, res) => {
  try {
    const password = req.headers['x-admin-password'];

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Non autorisé' });
    }

    const { leagueId } = req.params;
    const defaultStock = { duel: 2, multiplicateur: 2, bouclier: 2, sabotage: 2 };

    const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
    let count = 0;

    athletes.forEach(a => {
      if (a.league_id === leagueId) {
        a.jokerStock = { ...defaultStock };
        count++;
      }
    });

    await fs.writeFile(ATHLETES_FILE, JSON.stringify(athletes, null, 2));

    // Vider aussi l'historique des jokers utilisés pour cette ligue
    let usage = [];
    try {
      usage = JSON.parse(await fs.readFile(JOKERS_FILE, 'utf8'));
      const athleteIds = athletes.filter(a => a.league_id === leagueId).map(a => a.id);
      usage = usage.filter(u => !athleteIds.includes(u.athleteId));
      await fs.writeFile(JOKERS_FILE, JSON.stringify(usage, null, 2));
    } catch {}

    console.log(`🔄 Jokers réinitialisés pour ${count} athlètes de ${leagueId}`);
    res.json({ success: true, count });

  } catch (error) {
    console.error('Erreur reset jokers:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Lister tous les fichiers disponibles
 */
app.get('/api/admin/files', async (req, res) => {
  try {
    const password = req.headers['x-admin-password'];

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Non autorisé' });
    }

    const leagueFiles = await fs.readdir(LEAGUES_DIR);

    res.json({
      athletes: 'athletes.json',
      jokers: 'jokers_usage.json',
      sessions: 'sessions.json',
      leagues: leagueFiles
    });

  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Exclure ou réintégrer une activité
 */
app.post('/api/admin/activities/:leagueId/:activityId/exclude', async (req, res) => {
  try {
    const password = req.headers['x-admin-password'];

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Non autorisé' });
    }

    const { leagueId, activityId } = req.params;
    const { exclude, reason } = req.body;

    const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);

    let activities = [];
    try {
      activities = JSON.parse(await fs.readFile(activitiesFile, 'utf8'));
    } catch (e) {
      return res.status(404).json({ error: 'Fichier activités non trouvé' });
    }

    // Trouver l'activité
    const activityIndex = activities.findIndex(a => String(a.id) === String(activityId));

    if (activityIndex === -1) {
      return res.status(404).json({ error: 'Activité non trouvée' });
    }

    // Modifier le statut
    activities[activityIndex].excluded = exclude;
    activities[activityIndex].excluded_at = exclude ? new Date().toISOString() : null;
    activities[activityIndex].excluded_reason = exclude ? (reason || 'Exclu par admin') : null;

    // Sauvegarder
    await fs.writeFile(activitiesFile, JSON.stringify(activities, null, 2));

    console.log(`📝 Activité ${activityId}: ${exclude ? 'exclue' : 'réintégrée'}`);

    res.json({
      success: true,
      activity: activities[activityIndex],
      message: exclude ? 'Activité exclue' : 'Activité réintégrée'
    });

  } catch (error) {
    console.error('Erreur exclusion activité:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Exporter le classement en JSON
 */
app.get('/api/admin/ranking/:leagueId/export', async (req, res) => {
  try {
    const password = req.headers['x-admin-password'];

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Non autorisé' });
    }

    const { leagueId } = req.params;
    const ranking = await generateRanking(leagueId);

    const exportData = {
      league_id: leagueId,
      generated_at: new Date().toISOString(),
      ranking: ranking
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=classement-${leagueId}-${new Date().toISOString().split('T')[0]}.json`);
    res.send(JSON.stringify(exportData, null, 2));

  } catch (error) {
    console.error('Erreur export classement:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Générer le classement à partir des activités
 */
async function generateRanking(leagueId) {
  const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);
  const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));

  let activities = [];
  try {
    activities = JSON.parse(await fs.readFile(activitiesFile, 'utf8'));
  } catch (e) {
    activities = [];
  }

  // Filtrer les activités exclues
  const validActivities = activities.filter(a => !a.excluded);

  // Grouper par athlète
  const athleteStats = {};

  for (const athlete of athletes.filter(a => a.league_id === leagueId)) {
    athleteStats[athlete.id] = {
      id: athlete.id,
      name: athlete.name,
      total_distance: 0,
      total_elevation: 0,
      total_activities: 0,
      activities: []
    };
  }

  for (const activity of validActivities) {
    if (athleteStats[activity.athlete_id]) {
      athleteStats[activity.athlete_id].total_distance += activity.distance || 0;
      athleteStats[activity.athlete_id].total_elevation += activity.total_elevation_gain || 0;
      athleteStats[activity.athlete_id].total_activities += 1;
      athleteStats[activity.athlete_id].activities.push({
        id: activity.id,
        name: activity.name,
        date: activity.start_date,
        distance: activity.distance,
        elevation: activity.total_elevation_gain
      });
    }
  }

  // Convertir en tableau et trier par D+ (critère principal)
  const ranking = Object.values(athleteStats)
    .sort((a, b) => b.total_elevation - a.total_elevation)
    .map((athlete, index) => ({
      rank: index + 1,
      ...athlete,
      total_distance_km: (athlete.total_distance / 1000).toFixed(2),
      total_elevation_m: Math.round(athlete.total_elevation)
    }));

  return ranking;
}

/**
 * Export automatique du classement et push sur Git
 */
async function exportAndPushRanking() {
  const { exec } = require('child_process');
  const leagueId = 'versant-2026';

  try {
    console.log('📊 Export automatique du classement...');

    const ranking = await generateRanking(leagueId);

    const exportData = {
      league_id: leagueId,
      generated_at: new Date().toISOString(),
      ranking: ranking
    };

    // Sauvegarder dans le dossier public/data
    const exportPath = path.join(__dirname, '..', 'public', 'data', 'classement.json');
    await fs.writeFile(exportPath, JSON.stringify(exportData, null, 2));

    console.log(`✅ Classement exporté: ${exportPath}`);

    // Git add, commit, push
    const projectDir = path.join(__dirname, '..');
    const dateStr = new Date().toISOString().split('T')[0];

    exec(`cd ${projectDir} && git add public/data/classement.json && git commit -m "📊 Classement auto ${dateStr}" && git push origin master`, (error, stdout, stderr) => {
      if (error) {
        // Pas grave si rien à commit
        if (error.message.includes('nothing to commit')) {
          console.log('ℹ️ Pas de changement à commit');
        } else {
          console.error(`⚠️ Erreur git: ${error.message}`);
        }
        return;
      }
      console.log(`✅ Classement pushé sur GitHub`);
    });

  } catch (error) {
    console.error('❌ Erreur export automatique:', error);
  }
}

// ============================================
// WEBHOOK GITHUB - DÉPLOIEMENT AUTOMATIQUE
// ============================================

/**
 * Webhook GitHub pour auto-déploiement
 * Configurez sur GitHub: Settings > Webhooks > Add webhook
 * Payload URL: http://178.170.116.175/api/webhook/github
 * Content type: application/json
 */
app.post('/api/webhook/github', async (req, res) => {
  const { exec } = require('child_process');

  try {
    const event = req.headers['x-github-event'];
    const payload = req.body;

    console.log(`📥 Webhook GitHub reçu: ${event}`);

    // Vérifier que c'est un push sur master/main
    if (event === 'push') {
      const branch = payload.ref?.replace('refs/heads/', '');

      if (branch === 'master' || branch === 'main') {
        console.log(`🔄 Push détecté sur ${branch}, lancement du déploiement...`);

        // Répondre immédiatement à GitHub (évite le timeout)
        res.json({ success: true, message: 'Déploiement lancé' });

        // Exécuter git pull puis redémarrer PM2
        const projectDir = path.join(__dirname, '..');

        exec(`cd ${projectDir} && git pull origin ${branch}`, (error, stdout, stderr) => {
          if (error) {
            console.error(`❌ Erreur git pull: ${error.message}`);
            console.error(stderr);
            return;
          }
          console.log(`✅ Git pull réussi:\n${stdout}`);

          // Installer les nouvelles dépendances si nécessaire
          exec(`cd ${projectDir}/backend && npm install`, (errNpm, stdoutNpm) => {
            if (errNpm) {
              console.error(`⚠️ Erreur npm install: ${errNpm.message}`);
            } else {
              console.log(`✅ npm install terminé`);
            }

            // Redémarrer le serveur avec PM2
            exec('pm2 restart versant-api', (errPm2, stdoutPm2) => {
              if (errPm2) {
                console.error(`❌ Erreur restart PM2: ${errPm2.message}`);
              } else {
                console.log(`✅ Serveur redémarré avec PM2`);

                // Copier les fichiers publics vers Nginx
                exec(`sudo cp -r ${projectDir}/public/* /var/www/versant/`, (errCopy) => {
                  if (errCopy) {
                    console.error(`❌ Erreur copie fichiers publics: ${errCopy.message}`);
                  } else {
                    console.log(`✅ Fichiers publics copiés vers /var/www/versant/`);
                  }
                });
              }
            });
          });
        });

      } else {
        res.json({ success: true, message: `Push ignoré (branche: ${branch})` });
      }
    } else {
      res.json({ success: true, message: `Événement ignoré: ${event}` });
    }

  } catch (error) {
    console.error('Erreur webhook:', error);
    res.status(500).json({ error: 'Erreur webhook' });
  }
});

// ============================================
// SYNCHRONISATION STRAVA
// ============================================

async function refreshStravaToken(refreshToken) {
  try {
    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: STRAVA_CONFIG.clientId,
      client_secret: STRAVA_CONFIG.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });

    return {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_at: response.data.expires_at
    };
  } catch (error) {
    console.error('Erreur refresh token:', error.response?.data || error.message);
    throw error;
  }
}

app.post('/api/sync/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { startDate, endDate } = req.body;

    const start = startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const end = endDate || new Date().toISOString().split('T')[0];

    console.log(`🔄 Synchronisation de la ligue: ${leagueId}`);
    console.log(`📅 Période: ${start} → ${end}`);

    const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
    const leagueAthletes = athletes.filter(a => a.league_id === leagueId && a.active);

    const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);
    let existingActivities = [];

    try {
      existingActivities = JSON.parse(await fs.readFile(activitiesFile, 'utf8'));
    } catch {}

    let totalActivities = 0;
    const errors = [];

    for (const athlete of leagueAthletes) {
      try {
        console.log(`  📥 ${athlete.name}...`);

        let accessToken = athlete.tokens.access_token;

        // Refresh si expiré
        if (athlete.tokens.expires_at && athlete.tokens.expires_at < Date.now() / 1000) {
          const newTokens = await refreshStravaToken(athlete.tokens.refresh_token);
          accessToken = newTokens.access_token;

          // Sauvegarder
          const athleteIndex = athletes.findIndex(a => a.id === athlete.id);
          athletes[athleteIndex].tokens = newTokens;
          await fs.writeFile(ATHLETES_FILE, JSON.stringify(athletes, null, 2));
        }

        // Récupérer les activités
        // Note: "before" doit être le lendemain de endDate à minuit pour inclure toute la journée
        const endDatePlusOne = new Date(end);
        endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);

        const response = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            after: Math.floor(new Date(start).getTime() / 1000),
            before: Math.floor(endDatePlusOne.getTime() / 1000),
            per_page: 200
          }
        });

        const validSports = ['Run', 'TrailRun', 'Hike', 'Ride', 'MountainBikeRide', 'GravelRide', 'BackcountrySki', 'NordicSki', 'AlpineSki'];
        const activities = response.data
          .filter(a => validSports.includes(a.sport_type))
          .map(a => ({
            ...a,
            athlete_id: athlete.id,
            athlete_name: athlete.name, // Ajout du nom de l'athlète
            date: a.start_date.split('T')[0]
          }));

        // Fusionner
        for (const activity of activities) {
          const existingIndex = existingActivities.findIndex(e => e.id === activity.id);
          if (existingIndex >= 0) {
            existingActivities[existingIndex] = activity;
          } else {
            existingActivities.push(activity);
          }
        }

        totalActivities += activities.length;
        console.log(`    ✓ ${activities.length} activités`);

      } catch (error) {
        console.error(`    ✗ Erreur: ${error.message}`);
        errors.push({ athlete: athlete.name, error: error.message });
      }
    }

    // Sauvegarder
    await fs.writeFile(activitiesFile, JSON.stringify(existingActivities, null, 2));

    console.log(`✅ Synchronisation réussie!`);
    console.log(`   📊 ${totalActivities} activités`);
    console.log(`   👥 ${leagueAthletes.length} athlètes`);

    res.json({
      success: true,
      totalActivities,
      athletesCount: leagueAthletes.length,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('Erreur synchronisation:', error);
    res.status(500).json({ error: 'Erreur lors de la synchronisation' });
  }
});

// ============================================
// CRON - Sync automatique à 20h + Export classement
// ============================================
cron.schedule('0 20 * * *', async () => {
  console.log('🕐 Tâches automatiques (20h)...');

  try {
    // 1. Synchroniser les activités
    console.log('  🔄 Synchronisation des activités...');
    const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
    const leagues = [...new Set(athletes.map(a => a.league_id))];

    for (const leagueId of leagues) {
      console.log(`    → Sync: ${leagueId}`);
      // La sync est gérée par les webhooks, mais on peut faire une sync de rattrapage ici si besoin
    }

    // 2. Exporter le classement et push sur Git
    console.log('  📊 Export du classement...');
    await exportAndPushRanking();

    // 3. Retenter les webhooks échoués
    console.log('  🔄 Retry des webhooks échoués...');
    await retryFailedWebhooks();

    console.log('✅ Tâches automatiques terminées');

  } catch (error) {
    console.error('❌ Erreur tâches auto:', error);
  }
});

// ============================================
// WEBHOOKS STRAVA - VERSION AMÉLIORÉE AVEC RETRY
// ============================================

// Token de vérification pour Strava (à définir dans .env)
const STRAVA_VERIFY_TOKEN = process.env.STRAVA_VERIFY_TOKEN || 'VERSANT2026';

/**
 * Sauvegarder un webhook échoué pour retry ultérieur
 */
async function saveFailedWebhook(event, reason) {
  try {
    let failed = [];
    try {
      failed = JSON.parse(await fs.readFile(FAILED_WEBHOOKS_FILE, 'utf8'));
    } catch (e) { failed = []; }

    // Vérifier si pas déjà enregistré
    const exists = failed.find(f => f.event.object_id === event.object_id);
    if (exists) {
      exists.retry_count++;
      exists.last_reason = reason;
      exists.last_attempt = new Date().toISOString();
    } else {
      failed.push({
        event,
        reason,
        failed_at: new Date().toISOString(),
        last_attempt: new Date().toISOString(),
        retry_count: 0
      });
    }

    await fs.writeFile(FAILED_WEBHOOKS_FILE, JSON.stringify(failed, null, 2));
    console.log(`   💾 Webhook sauvegardé pour retry ultérieur (raison: ${reason})`);
  } catch (e) {
    console.error('   ❌ Impossible de sauvegarder le webhook échoué:', e.message);
  }
}

/**
 * Retenter les webhooks échoués
 */
async function retryFailedWebhooks() {
  try {
    let failed = [];
    try {
      failed = JSON.parse(await fs.readFile(FAILED_WEBHOOKS_FILE, 'utf8'));
    } catch (e) { return; }

    if (failed.length === 0) {
      console.log('   ℹ️ Aucun webhook à retenter');
      return;
    }

    console.log(`   🔄 ${failed.length} webhooks à retenter...`);

    const stillFailed = [];

    for (const item of failed) {
      // Max 5 retries
      if (item.retry_count >= 5) {
        console.log(`   ⚠️ Webhook ${item.event.object_id} abandonné après 5 tentatives`);
        continue;
      }

      try {
        await processWebhookEvent(item.event);
        console.log(`   ✅ Webhook ${item.event.object_id} réussi au retry`);
      } catch (error) {
        item.retry_count++;
        item.last_attempt = new Date().toISOString();
        item.last_reason = error.message;
        stillFailed.push(item);
        console.log(`   ❌ Webhook ${item.event.object_id} échoué à nouveau: ${error.message}`);
      }
    }

    await fs.writeFile(FAILED_WEBHOOKS_FILE, JSON.stringify(stillFailed, null, 2));

  } catch (error) {
    console.error('   ❌ Erreur retry webhooks:', error.message);
  }
}

/**
 * Fonction de refresh token avec retry
 */
async function refreshStravaTokenWithRetry(refreshToken, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post('https://www.strava.com/oauth/token', {
        client_id: STRAVA_CONFIG.clientId,
        client_secret: STRAVA_CONFIG.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      });
      return {
        success: true,
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token,
        expires_at: response.data.expires_at
      };
    } catch (error) {
      console.log(`   ⚠️ Refresh token tentative ${attempt}/${maxRetries} échouée: ${error.message}`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * attempt)); // Attente progressive
      }
    }
  }
  return { success: false };
}

/**
 * Traiter un événement webhook (utilisé pour le traitement initial et les retries)
 */
async function processWebhookEvent(event) {
  // Vérifier que c'est une activité
  if (event.object_type !== 'activity') {
    return; // Pas une erreur, juste ignoré
  }

  // Trouver l'athlète
  const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
  const athlete = athletes.find(a => String(a.id) === String(event.owner_id));

  if (!athlete) {
    return; // Athlète non inscrit, pas une erreur
  }

  const leagueId = athlete.league_id;
  const activitiesFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);

  // Charger les activités
  let activities = [];
  try {
    activities = JSON.parse(await fs.readFile(activitiesFile, 'utf8'));
  } catch (e) {
    activities = [];
  }

  if (event.aspect_type === 'create') {
    // Vérifier le token
    let accessToken = athlete.tokens?.access_token;
    if (!accessToken) {
      throw new Error('no_token');
    }

    // Rafraîchir si expiré
    if (athlete.tokens?.expires_at < Date.now() / 1000) {
      console.log(`   🔄 Token expiré pour ${athlete.name}, rafraîchissement...`);
      const refreshResult = await refreshStravaTokenWithRetry(athlete.tokens.refresh_token);

      if (!refreshResult.success) {
        throw new Error('refresh_failed');
      }

      accessToken = refreshResult.access_token;
      athlete.tokens.access_token = refreshResult.access_token;
      athlete.tokens.refresh_token = refreshResult.refresh_token;
      athlete.tokens.expires_at = refreshResult.expires_at;
      await fs.writeFile(ATHLETES_FILE, JSON.stringify(athletes, null, 2));
      console.log(`   ✅ Token rafraîchi pour ${athlete.name}`);
    }

    // Récupérer l'activité avec retry
    let stravaActivity = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const activityResponse = await axios.get(
          `https://www.strava.com/api/v3/activities/${event.object_id}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 10000
          }
        );
        stravaActivity = activityResponse.data;
        break;
      } catch (error) {
        console.log(`   ⚠️ Fetch activité tentative ${attempt}/3: ${error.message}`);
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }

    if (!stravaActivity) {
      throw new Error('fetch_failed');
    }

    // Types valides
    const validTypes = ['Run', 'Hike', 'Walk', 'TrailRun', 'Trail Run', 'Ride', 'MountainBikeRide', 'GravelRide', 'NordicSki', 'BackcountrySki', 'Snowshoe'];
    if (!validTypes.includes(stravaActivity.type)) {
      console.log(`   → Ignoré (type ${stravaActivity.type} non valide)`);
      return;
    }

    // Transformer l'activité
    const newActivity = {
      id: stravaActivity.id,
      athlete: {
        id: athlete.id,
        resource_state: 1
      },
      athlete_id: athlete.id,
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
      average_heartrate: stravaActivity.average_heartrate,
      max_heartrate: stravaActivity.max_heartrate,
      synced_at: new Date().toISOString(),
      source: 'webhook'
    };

    // Ajouter si pas déjà présente
    if (!activities.find(a => a.id === newActivity.id)) {
      activities.push(newActivity);
      await fs.writeFile(activitiesFile, JSON.stringify(activities, null, 2));
      console.log(`   ✅ Activité ajoutée: ${newActivity.name} (${(newActivity.distance/1000).toFixed(2)}km, +${newActivity.total_elevation_gain}m)`);
    }

  } else if (event.aspect_type === 'delete') {
    activities = activities.filter(a => a.id !== event.object_id);
    await fs.writeFile(activitiesFile, JSON.stringify(activities, null, 2));
    console.log(`   🗑️ Activité supprimée: ${event.object_id}`);
  }
}

/**
 * Validation du webhook (GET) - Strava envoie un challenge
 */
app.get('/api/webhook/strava', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('🔔 Webhook Strava - Validation reçue');
  console.log(`   Mode: ${mode}, Token: ${token}, Challenge: ${challenge}`);

  if (mode === 'subscribe' && token === STRAVA_VERIFY_TOKEN) {
    console.log('✅ Webhook Strava validé !');
    res.json({ 'hub.challenge': challenge });
  } else {
    console.log('❌ Token de vérification invalide');
    res.status(403).send('Forbidden');
  }
});

/**
 * Réception des événements (POST) - VERSION AMÉLIORÉE
 */
app.post('/api/webhook/strava', async (req, res) => {
  const event = req.body;

  console.log('🔔 Webhook Strava - Événement reçu:');
  console.log(`   Type: ${event.object_type}, Action: ${event.aspect_type}`);
  console.log(`   Athlete ID: ${event.owner_id}, Object ID: ${event.object_id}`);

  // Répondre immédiatement à Strava (ils veulent une réponse < 2 sec)
  res.status(200).send('EVENT_RECEIVED');

  // Traitement asynchrone
  try {
    // Vérifier que c'est une activité
    if (event.object_type !== 'activity') {
      console.log('   → Ignoré (pas une activité)');
      return;
    }

    // Trouver l'athlète
    const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
    const athlete = athletes.find(a => String(a.id) === String(event.owner_id));

    if (!athlete) {
      console.log(`   → Ignoré (athlète ${event.owner_id} non inscrit)`);
      return;
    }

    console.log(`   → Athlète trouvé: ${athlete.name} (${athlete.league_id})`);

    // Traiter l'événement
    await processWebhookEvent(event);

  } catch (error) {
    console.error(`❌ Erreur traitement webhook: ${error.message}`);
    // Sauvegarder pour retry
    await saveFailedWebhook(event, error.message);
  }
});

// ============================================
// ADMIN - GESTION WEBHOOK
// ============================================

/**
 * Endpoint pour vérifier le statut de l'abonnement webhook Strava
 */
app.get('/api/admin/strava/subscribe/status', async (req, res) => {
  const password = req.headers['x-admin-password'];

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const viewResponse = await axios.get('https://www.strava.com/api/v3/push_subscriptions', {
      params: {
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET
      }
    });

    if (viewResponse.data.length > 0) {
      res.json({
        active: true,
        subscription: viewResponse.data[0]
      });
    } else {
      res.json({ active: false });
    }

  } catch (error) {
    console.error('❌ Erreur vérification webhook:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur vérification webhook',
      details: error.response?.data || error.message
    });
  }
});

/**
 * Endpoint pour créer l'abonnement webhook Strava
 */
app.post('/api/admin/strava/subscribe', async (req, res) => {
  const password = req.headers['x-admin-password'];

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    // Vérifier si un abonnement existe déjà
    const viewResponse = await axios.get('https://www.strava.com/api/v3/push_subscriptions', {
      params: {
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET
      }
    });

    if (viewResponse.data.length > 0) {
      console.log('📋 Abonnement webhook existant:', viewResponse.data);
      return res.json({
        message: 'Abonnement webhook déjà existant',
        subscription: viewResponse.data[0]
      });
    }

    // Créer un nouvel abonnement
    const callbackUrl = `https://versant-app.fr/api/webhook/strava`;

    const createResponse = await axios.post('https://www.strava.com/api/v3/push_subscriptions', {
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      callback_url: callbackUrl,
      verify_token: STRAVA_VERIFY_TOKEN
    });

    console.log('✅ Abonnement webhook créé:', createResponse.data);
    res.json({
      message: 'Abonnement webhook créé avec succès',
      subscription: createResponse.data
    });

  } catch (error) {
    console.error('❌ Erreur création webhook:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur création webhook',
      details: error.response?.data || error.message
    });
  }
});

/**
 * Endpoint pour supprimer l'abonnement webhook Strava
 */
app.delete('/api/admin/strava/subscribe', async (req, res) => {
  const password = req.headers['x-admin-password'];

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    // Récupérer l'abonnement existant
    const viewResponse = await axios.get('https://www.strava.com/api/v3/push_subscriptions', {
      params: {
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET
      }
    });

    if (viewResponse.data.length === 0) {
      return res.json({ message: 'Aucun abonnement à supprimer' });
    }

    const subscriptionId = viewResponse.data[0].id;

    // Supprimer l'abonnement
    await axios.delete(`https://www.strava.com/api/v3/push_subscriptions/${subscriptionId}`, {
      params: {
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET
      }
    });

    console.log('🗑️ Abonnement webhook supprimé:', subscriptionId);
    res.json({ message: 'Abonnement supprimé', subscriptionId });

  } catch (error) {
    console.error('❌ Erreur suppression webhook:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erreur suppression webhook' });
  }
});

/**
 * Voir les webhooks échoués
 */
app.get('/api/admin/webhooks/failed', async (req, res) => {
  const password = req.headers['x-admin-password'];

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    let failed = [];
    try {
      failed = JSON.parse(await fs.readFile(FAILED_WEBHOOKS_FILE, 'utf8'));
    } catch {}

    res.json({ count: failed.length, webhooks: failed });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Forcer le retry des webhooks échoués
 */
app.post('/api/admin/webhooks/retry', async (req, res) => {
  const password = req.headers['x-admin-password'];

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    await retryFailedWebhooks();

    let failed = [];
    try {
      failed = JSON.parse(await fs.readFile(FAILED_WEBHOOKS_FILE, 'utf8'));
    } catch {}

    res.json({
      message: 'Retry effectué',
      remaining: failed.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// DIAGNOSTIC SYSTÈME
// ============================================

/**
 * Endpoint de diagnostic complet du système
 */
app.get('/api/admin/diagnostic', async (req, res) => {
  const password = req.headers['x-admin-password'];

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const diagnostic = {
      timestamp: new Date().toISOString(),
      athletes: { status: 'unknown', count: 0, details: [] },
      activities: { status: 'unknown', leagues: [] },
      webhook: { status: 'unknown' },
      failedWebhooks: { count: 0 },
      recommendations: []
    };

    // 1. Vérifier athletes.json
    try {
      const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
      diagnostic.athletes.count = athletes.length;

      if (athletes.length === 0) {
        diagnostic.athletes.status = 'error';
        diagnostic.athletes.error = 'Fichier vide - aucun athlète enregistré';
        diagnostic.recommendations.push({
          priority: 'critical',
          message: 'athletes.json est vide. Les athlètes doivent se réinscrire via /inscription.html'
        });
      } else {
        diagnostic.athletes.status = 'ok';
        diagnostic.athletes.withTokens = athletes.filter(a => a.tokens?.access_token).length;
        diagnostic.athletes.withExpiredTokens = athletes.filter(a =>
          a.tokens?.expires_at && a.tokens.expires_at < Date.now() / 1000
        ).length;
        diagnostic.athletes.active = athletes.filter(a => a.active).length;

        // Liste des athlètes sans tokens
        const noTokens = athletes.filter(a => !a.tokens?.access_token);
        if (noTokens.length > 0) {
          diagnostic.athletes.withoutTokens = noTokens.map(a => ({ id: a.id, name: a.name }));
          diagnostic.recommendations.push({
            priority: 'warning',
            message: `${noTokens.length} athlètes sans token Strava`
          });
        }
      }
    } catch (error) {
      diagnostic.athletes.status = 'error';
      diagnostic.athletes.error = error.message;
    }

    // 2. Vérifier les activités
    try {
      const files = await fs.readdir(LEAGUES_DIR);
      const activityFiles = files.filter(f => f.endsWith('_activities.json'));

      for (const file of activityFiles) {
        const activities = JSON.parse(await fs.readFile(path.join(LEAGUES_DIR, file), 'utf8'));
        const leagueId = file.replace('_activities.json', '');

        const webhookCount = activities.filter(a => a.source === 'webhook').length;
        const syncCount = activities.filter(a => !a.source || a.source === 'sync').length;

        // Dernière activité
        let lastActivity = null;
        if (activities.length > 0) {
          const sorted = [...activities].sort((a, b) =>
            new Date(b.synced_at || b.start_date) - new Date(a.synced_at || a.start_date)
          );
          lastActivity = {
            name: sorted[0].name,
            date: sorted[0].start_date,
            source: sorted[0].source || 'sync'
          };
        }

        diagnostic.activities.leagues.push({
          leagueId,
          total: activities.length,
          viaWebhook: webhookCount,
          viaSync: syncCount,
          lastActivity
        });
      }
      diagnostic.activities.status = 'ok';
    } catch (error) {
      diagnostic.activities.status = 'error';
      diagnostic.activities.error = error.message;
    }

    // 3. Vérifier l'abonnement webhook
    try {
      const viewResponse = await axios.get('https://www.strava.com/api/v3/push_subscriptions', {
        params: {
          client_id: STRAVA_CLIENT_ID,
          client_secret: STRAVA_CLIENT_SECRET
        }
      });

      if (viewResponse.data.length > 0) {
        diagnostic.webhook.status = 'active';
        diagnostic.webhook.subscription = viewResponse.data[0];
      } else {
        diagnostic.webhook.status = 'inactive';
        diagnostic.recommendations.push({
          priority: 'warning',
          message: 'Aucun abonnement webhook actif. Créez-en un via POST /api/admin/strava/subscribe'
        });
      }
    } catch (error) {
      diagnostic.webhook.status = 'error';
      diagnostic.webhook.error = error.message;
    }

    // 4. Vérifier les webhooks échoués
    try {
      const failed = JSON.parse(await fs.readFile(FAILED_WEBHOOKS_FILE, 'utf8'));
      diagnostic.failedWebhooks.count = failed.length;
      if (failed.length > 0) {
        diagnostic.recommendations.push({
          priority: 'info',
          message: `${failed.length} webhooks en attente de retry. Forcer via POST /api/admin/webhooks/retry`
        });
      }
    } catch {}

    // Résumé
    diagnostic.summary = {
      healthy: diagnostic.athletes.status === 'ok' &&
               diagnostic.athletes.count > 0 &&
               diagnostic.athletes.withTokens > 0 &&
               diagnostic.webhook.status === 'active',
      criticalIssues: diagnostic.recommendations.filter(r => r.priority === 'critical').length,
      warnings: diagnostic.recommendations.filter(r => r.priority === 'warning').length
    };

    res.json(diagnostic);

  } catch (error) {
    console.error('Erreur diagnostic:', error);
    res.status(500).json({ error: 'Erreur lors du diagnostic' });
  }
});

/**
 * Importer des athlètes depuis un backup JSON
 */
app.post('/api/admin/athletes/import', async (req, res) => {
  const password = req.headers['x-admin-password'];

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const { athletes: importedAthletes, mode = 'merge' } = req.body;

    if (!importedAthletes || !Array.isArray(importedAthletes)) {
      return res.status(400).json({ error: 'Format invalide. Attendu: { athletes: [...] }' });
    }

    let athletes = [];

    if (mode === 'merge') {
      // Fusionner avec les existants
      try {
        athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
      } catch {}

      for (const imported of importedAthletes) {
        const existingIndex = athletes.findIndex(a => String(a.id) === String(imported.id));
        if (existingIndex >= 0) {
          // Mettre à jour (préserver les tokens existants si pas fournis)
          athletes[existingIndex] = {
            ...athletes[existingIndex],
            ...imported,
            tokens: imported.tokens || athletes[existingIndex].tokens
          };
        } else {
          athletes.push(imported);
        }
      }
    } else {
      // Remplacer complètement
      athletes = importedAthletes;
    }

    await fs.writeFile(ATHLETES_FILE, JSON.stringify(athletes, null, 2));

    res.json({
      success: true,
      message: `${importedAthletes.length} athlètes importés (mode: ${mode})`,
      totalAthletes: athletes.length
    });

  } catch (error) {
    console.error('Erreur import:', error);
    res.status(500).json({ error: 'Erreur lors de l\'import' });
  }
});

// ============================================
// DÉMARRAGE
// ============================================
initializeServer().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Serveur Versant v2.1 démarré sur le port ${PORT}`);
    console.log(`📍 Interface: http://localhost:${PORT}`);
    console.log(`📍 API: http://localhost:${PORT}/api`);
    console.log(`🔐 Admin password: ${ADMIN_PASSWORD}`);
  });
});