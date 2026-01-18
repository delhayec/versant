/**
 * ============================================
 * VERSANT - SERVEUR BACKEND v2.0
 * ============================================
 * Features:
 * - Login avec mot de passe
 * - Gestion des jokers
 * - Interface admin
 * - Règles avancées (activités, saisons, horaires)
 */
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const crypto = require('crypto');

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
  for (const file of [ATHLETES_FILE, JOKERS_FILE, SESSIONS_FILE]) {
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
// SYNCHRONISATION (Inchangée)
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
        const response = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            after: Math.floor(new Date(start).getTime() / 1000),
            before: Math.floor(new Date(end).getTime() / 1000),
            per_page: 200
          }
        });

        const validSports = ['Run', 'TrailRun', 'Hike', 'Ride', 'MountainBikeRide', 'GravelRide', 'BackcountrySki', 'NordicSki', 'AlpineSki'];
        const activities = response.data
          .filter(a => validSports.includes(a.sport_type))
          .map(a => ({
            ...a,
            athlete_id: athlete.id,
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
// CRON - Sync automatique à 20h
// ============================================
cron.schedule('0 20 * * *', async () => {
  console.log('🕐 Synchronisation automatique (20h)...');
  
  try {
    const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
    const leagues = [...new Set(athletes.map(a => a.league_id))];

    for (const leagueId of leagues) {
      console.log(`  🔄 Sync: ${leagueId}`);
      // Appeler la fonction de sync
    }
  } catch (error) {
    console.error('Erreur sync auto:', error);
  }
});

// ============================================
// DÉMARRAGE
// ============================================
initializeServer().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Serveur Versant démarré sur le port ${PORT}`);
    console.log(`📍 Interface: http://localhost:${PORT}`);
    console.log(`📍 API: http://localhost:${PORT}/api`);
    console.log(`🔐 Admin password: ${ADMIN_PASSWORD}`);
  });
});
