/**
 * ============================================
 * VERSANT - SERVEUR BACKEND
 * ============================================
 * Gestion des inscriptions, authentification Strava,
 * synchronisation des activités et support multi-ligues
 */
require('dotenv').config();

// TEST - À enlever après debug
console.log('=== TEST DOTENV ===');
console.log('STRAVA_CLIENT_ID:', process.env.STRAVA_CLIENT_ID);
console.log('STRAVA_CLIENT_SECRET:', process.env.STRAVA_CLIENT_SECRET ? 'Défini ✓' : 'MANQUANT ✗');
console.log('PORT:', process.env.PORT);
console.log('===================');

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Configuration Strava
const STRAVA_CONFIG = {
  clientId: process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET,
  redirectUri: process.env.STRAVA_REDIRECT_URI || 'http://localhost:3000/inscription.html'
};

// Chemins des données
const DATA_DIR = path.join(__dirname, 'data');
const LEAGUES_DIR = path.join(DATA_DIR, 'leagues');
const ATHLETES_FILE = path.join(DATA_DIR, 'athletes.json');

// ============================================
// INITIALISATION
// ============================================
async function initializeServer() {
  // Créer les répertoires nécessaires
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(LEAGUES_DIR, { recursive: true });

  // Initialiser le fichier athletes si nécessaire
  try {
    await fs.access(ATHLETES_FILE);
  } catch {
    await fs.writeFile(ATHLETES_FILE, JSON.stringify([], null, 2));
  }

  console.log('✅ Serveur initialisé');
}

// ============================================
// ROUTES - AUTHENTIFICATION STRAVA
// ============================================

/**
 * Échange le code d'autorisation contre un token d'accès
 */
app.post('/api/auth/strava/exchange', async (req, res) => {
  try {
    const { code } = req.body;

        // DEBUG - À ENLEVER APRÈS
    console.log('=== DEBUG STRAVA ===');
    console.log('Client ID:', STRAVA_CONFIG.clientId);
    console.log('Client Secret:', STRAVA_CONFIG.clientSecret ? 'Défini ✓' : 'MANQUANT ✗');
    console.log('Code reçu:', code);
    console.log('===================');

    if (!code) {
      return res.status(400).json({ error: 'Code manquant' });
    }

    // Échange avec Strava
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
 * Rafraîchir un token d'accès expiré
 */
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

// ============================================
// ROUTES - INSCRIPTION ATHLÈTES
// ============================================

/**
 * Inscrire un nouvel athlète
 */
app.post('/api/athletes/register', async (req, res) => {
  try {
    const { athlete_id, name, email, strava_data, access_token, league_id } = req.body;

    if (!athlete_id || !name || !league_id) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    // Charger les athlètes existants
    const athletesData = await fs.readFile(ATHLETES_FILE, 'utf8');
    const athletes = JSON.parse(athletesData);

    // Vérifier si l'athlète est déjà inscrit
    const existingIndex = athletes.findIndex(a => a.id === athlete_id && a.league_id === league_id);
    
    const athleteRecord = {
      id: athlete_id,
      name: name,
      email: email || null,
      league_id: league_id,
      strava_profile: strava_data,
      registered_at: new Date().toISOString(),
      tokens: {
        access_token: access_token,
        // Le refresh_token devrait être stocké de manière sécurisée
        // et n'est pas retourné au client
      },
      jokers: ["duel", "multiplicateur", "bouclier", "sabotage"], // Jokers initiaux
      active: true
    };

    if (existingIndex >= 0) {
      // Mise à jour
      athletes[existingIndex] = { ...athletes[existingIndex], ...athleteRecord };
    } else {
      // Nouvel athlète
      athletes.push(athleteRecord);
    }

    // Sauvegarder
    await fs.writeFile(ATHLETES_FILE, JSON.stringify(athletes, null, 2));

    console.log(`✅ Athlète inscrit: ${name} (${athlete_id}) - Ligue: ${league_id}`);

    res.json({ 
      success: true, 
      athlete_id,
      message: 'Inscription réussie' 
    });

  } catch (error) {
    console.error('Erreur inscription:', error);
    res.status(500).json({ error: 'Erreur lors de l\'inscription' });
  }
});

/**
 * Récupérer la liste des athlètes d'une ligue
 */
app.get('/api/athletes/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    
    const athletesData = await fs.readFile(ATHLETES_FILE, 'utf8');
    const athletes = JSON.parse(athletesData);
    
    // Filtrer par ligue et ne retourner que les données publiques
    const leagueAthletes = athletes
      .filter(a => a.league_id === leagueId && a.active)
      .map(a => ({
        id: a.id,
        name: a.name,
        strava_profile: {
          firstname: a.strava_profile.firstname,
          lastname: a.strava_profile.lastname,
          profile: a.strava_profile.profile
        },
        jokers: a.jokers,
        registered_at: a.registered_at
      }));

    res.json(leagueAthletes);

  } catch (error) {
    console.error('Erreur récupération athlètes:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des athlètes' });
  }
});

// ============================================
// ROUTES - SYNCHRONISATION ACTIVITÉS
// ============================================

/**
 * Récupérer les activités d'un athlète depuis Strava
 */
async function fetchAthleteActivities(athleteId, accessToken, after = null, before = null) {
  try {
    const params = {
      per_page: 200,
      page: 1
    };

    if (after) params.after = Math.floor(new Date(after).getTime() / 1000);
    if (before) params.before = Math.floor(new Date(before).getTime() / 1000);

    const response = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      params
    });

    return response.data;

  } catch (error) {
    console.error(`Erreur fetch activités ${athleteId}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Récupérer le stream (GPX) d'une activité
 */
async function fetchActivityStream(activityId, accessToken) {
  try {
    const response = await axios.get(
      `https://www.strava.com/api/v3/activities/${activityId}/streams`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        },
        params: {
          keys: 'latlng,altitude,distance,grade_smooth',
          key_by_type: true
        }
      }
    );

    return response.data;

  } catch (error) {
    console.error(`Erreur fetch stream ${activityId}:`, error.response?.data || error.message);
    return null;
  }
}

/**
 * Synchroniser les activités pour une ligue
 */
app.post('/api/sync/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { startDate, endDate } = req.body;

    console.log(`🔄 Début synchronisation ligue: ${leagueId}`);

    // Charger les athlètes de la ligue
    const athletesData = await fs.readFile(ATHLETES_FILE, 'utf8');
    const allAthletes = JSON.parse(athletesData);
    const leagueAthletes = allAthletes.filter(a => a.league_id === leagueId && a.active);

    if (leagueAthletes.length === 0) {
      return res.status(404).json({ error: 'Aucun athlète dans cette ligue' });
    }

    const allActivities = [];
    const errors = [];

    // Synchroniser chaque athlète
    for (const athlete of leagueAthletes) {
      try {
        console.log(`  📥 ${athlete.name}...`);
        
        let accessToken = athlete.tokens.access_token;
        
        // Vérifier si le token doit être rafraîchi
        if (athlete.tokens.expires_at && athlete.tokens.expires_at < Date.now() / 1000) {
          const newTokens = await refreshStravaToken(athlete.tokens.refresh_token);
          accessToken = newTokens.access_token;
          
          // Mettre à jour les tokens
          athlete.tokens = newTokens;
        }

        // Récupérer les activités
        const activities = await fetchAthleteActivities(
          athlete.id,
          accessToken,
          startDate,
          endDate
        );

        // Ajouter l'ID de l'athlète et filtrer par type de sport
        const validSports = ['Run', 'TrailRun', 'Hike', 'Ride', 'MountainBikeRide', 
                            'GravelRide', 'BackcountrySki', 'NordicSki', 'AlpineSki'];
        
        const filteredActivities = activities
          .filter(a => validSports.includes(a.sport_type))
          .map(a => ({
            ...a,
            athlete_id: athlete.id,
            date: a.start_date.split('T')[0]
          }));

        allActivities.push(...filteredActivities);
        console.log(`    ✓ ${filteredActivities.length} activités`);

      } catch (error) {
        console.error(`    ✗ Erreur ${athlete.name}:`, error.message);
        errors.push({ athlete_id: athlete.id, error: error.message });
      }
    }

    // Sauvegarder les tokens mis à jour
    await fs.writeFile(ATHLETES_FILE, JSON.stringify(allAthletes, null, 2));

    // Sauvegarder les activités
    const leagueDataFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);
    await fs.writeFile(leagueDataFile, JSON.stringify(allActivities, null, 2));

    console.log(`✅ Synchronisation terminée: ${allActivities.length} activités`);

    res.json({
      success: true,
      activities_count: allActivities.length,
      athletes_count: leagueAthletes.length,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('Erreur synchronisation:', error);
    res.status(500).json({ error: 'Erreur lors de la synchronisation' });
  }
});

/**
 * Récupérer les activités d'une ligue
 */
app.get('/api/activities/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const leagueDataFile = path.join(LEAGUES_DIR, `${leagueId}_activities.json`);

    try {
      const data = await fs.readFile(leagueDataFile, 'utf8');
      const activities = JSON.parse(data);
      res.json(activities);
    } catch (error) {
      // Fichier n'existe pas encore
      res.json([]);
    }

  } catch (error) {
    console.error('Erreur récupération activités:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des activités' });
  }
});

// ============================================
// ROUTES - CHALLENGES SPÉCIAUX
// ============================================

/**
 * Analyser une activité pour les challenges spéciaux
 * (pente > X%, hors sentier)
 */
app.post('/api/analyze/activity/:activityId', async (req, res) => {
  try {
    const { activityId } = req.params;
    const { athlete_id, challenge_type, threshold } = req.body;

    // Récupérer l'athlète pour avoir son token
    const athletesData = await fs.readFile(ATHLETES_FILE, 'utf8');
    const athletes = JSON.parse(athletesData);
    const athlete = athletes.find(a => a.id === athlete_id);

    if (!athlete) {
      return res.status(404).json({ error: 'Athlète non trouvé' });
    }

    // Récupérer le stream de l'activité
    const stream = await fetchActivityStream(activityId, athlete.tokens.access_token);

    if (!stream || !stream.grade_smooth || !stream.altitude) {
      return res.status(400).json({ error: 'Données de stream insuffisantes' });
    }

    let result = {};

    // Analyse selon le type de challenge
    if (challenge_type === 'steep_slope') {
      // Challenge pente > threshold%
      result = analyzeSteepSlope(stream, threshold || 15);
    } else if (challenge_type === 'off_trail') {
      // Challenge hors sentier (nécessite données supplémentaires)
      result = analyzeOffTrail(stream);
    }

    res.json(result);

  } catch (error) {
    console.error('Erreur analyse activité:', error);
    res.status(500).json({ error: 'Erreur lors de l\'analyse' });
  }
});

/**
 * Analyser le D+ sur pentes raides
 */
function analyzeSteepSlope(stream, threshold) {
  const grades = stream.grade_smooth.data;
  const altitudes = stream.altitude.data;
  const distances = stream.distance?.data || [];

  let elevationOnSteep = 0;
  let previousAlt = altitudes[0];

  for (let i = 1; i < grades.length; i++) {
    const grade = grades[i];
    const currentAlt = altitudes[i];
    
    if (grade >= threshold && currentAlt > previousAlt) {
      elevationOnSteep += currentAlt - previousAlt;
    }
    
    previousAlt = currentAlt;
  }

  return {
    elevation_on_steep: Math.round(elevationOnSteep),
    threshold_percentage: threshold,
    total_points: altitudes.length
  };
}

/**
 * Analyser le D+ hors sentier
 * Note: Nécessiterait des données de type de surface ou comparaison avec OSM
 */
function analyzeOffTrail(stream) {
  // Implémentation simplifiée
  // En réalité, il faudrait comparer les coordonnées GPS avec une carte
  // des routes goudronnées (via Overpass API ou données OSM locales)
  
  return {
    elevation_off_trail: 0,
    note: 'Analyse hors-sentier nécessite intégration OSM'
  };
}

// ============================================
// TÂCHES AUTOMATIQUES
// ============================================

/**
 * Synchronisation quotidienne automatique
 * Chaque jour à 6h du matin
 */
cron.schedule('0 6 * * *', async () => {
  console.log('🕐 Synchronisation automatique...');
  
  try {
    const athletesData = await fs.readFile(ATHLETES_FILE, 'utf8');
    const athletes = JSON.parse(athletesData);
    
    // Grouper par ligue
    const leagues = [...new Set(athletes.map(a => a.league_id))];
    
    for (const leagueId of leagues) {
      console.log(`  📊 Synchronisation ${leagueId}...`);
      
      // Synchroniser les 7 derniers jours pour être sûr
      const endDate = new Date().toISOString().split('T')[0];
      const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      // Utiliser la même logique que la route /api/sync
      // (code simplifié ici)
    }
    
    console.log('✅ Synchronisation automatique terminée');
  } catch (error) {
    console.error('❌ Erreur synchronisation automatique:', error);
  }
});

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================

initializeServer().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Serveur Versant démarré sur le port ${PORT}`);
    console.log(`📍 Interface: http://localhost:${PORT}`);
    console.log(`📍 API: http://localhost:${PORT}/api`);
  });
});

module.exports = app;
