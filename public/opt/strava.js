/**
 * ============================================
 * VERSANT API - MODULE STRAVA
 * ============================================
 * 
 * Gestion de l'authentification OAuth2 et
 * récupération des activités depuis l'API Strava
 */

const config = require('./config');
const dataManager = require('./data-manager');

/**
 * Génère l'URL d'autorisation Strava
 * L'utilisateur doit cliquer sur ce lien pour autoriser l'app
 */
function getAuthorizationUrl(state = '') {
  const params = new URLSearchParams({
    client_id: config.strava.clientId,
    response_type: 'code',
    redirect_uri: `${config.server.baseUrl}/auth/callback`,
    scope: config.strava.scopes,
    state: state // Pour identifier l'utilisateur côté frontend
  });
  
  return `${config.strava.authUrl}?${params.toString()}`;
}

/**
 * Échange le code d'autorisation contre un token
 * Appelé après que l'utilisateur a autorisé l'app sur Strava
 */
async function exchangeCodeForToken(code) {
  const response = await fetch(config.strava.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.strava.clientId,
      client_secret: config.strava.clientSecret,
      code: code,
      grant_type: 'authorization_code'
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Erreur lors de l\'échange du code');
  }
  
  const data = await response.json();
  
  // Structure retournée par Strava:
  // {
  //   token_type: "Bearer",
  //   access_token: "xxx",
  //   refresh_token: "yyy",
  //   expires_at: 1234567890,
  //   athlete: { id, firstname, lastname, ... }
  // }
  
  return data;
}

/**
 * Rafraîchit un token expiré
 * Les tokens Strava expirent après 6 heures
 */
async function refreshAccessToken(refreshToken) {
  const response = await fetch(config.strava.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.strava.clientId,
      client_secret: config.strava.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Erreur lors du refresh du token');
  }
  
  return await response.json();
}

/**
 * Récupère un token valide pour un athlète
 * Rafraîchit automatiquement si expiré
 */
async function getValidToken(athleteId) {
  const tokenData = dataManager.getAthleteToken(athleteId);
  
  if (!tokenData) {
    return null; // Athlète pas encore connecté
  }
  
  // Vérifier si le token est expiré (avec 5 min de marge)
  const now = Math.floor(Date.now() / 1000);
  if (tokenData.expires_at < now + 300) {
    console.log(`🔄 Refresh token pour athlète ${athleteId}...`);
    
    try {
      const newToken = await refreshAccessToken(tokenData.refresh_token);
      
      // Sauvegarder le nouveau token
      dataManager.saveAthleteToken(athleteId, {
        ...tokenData,
        access_token: newToken.access_token,
        refresh_token: newToken.refresh_token,
        expires_at: newToken.expires_at
      });
      
      return newToken.access_token;
    } catch (error) {
      console.error(`❌ Erreur refresh token athlète ${athleteId}:`, error.message);
      return null;
    }
  }
  
  return tokenData.access_token;
}

/**
 * Appel générique à l'API Strava
 */
async function stravaApiCall(endpoint, accessToken, params = {}) {
  const url = new URL(`${config.strava.apiBase}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) url.searchParams.append(key, value);
  });
  
  const response = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `Erreur API Strava: ${response.status}`);
  }
  
  return await response.json();
}

/**
 * Récupère les activités d'un athlète sur une période
 */
async function getAthleteActivities(athleteId, options = {}) {
  const accessToken = await getValidToken(athleteId);
  if (!accessToken) {
    throw new Error(`Pas de token valide pour l'athlète ${athleteId}`);
  }
  
  const {
    after = Math.floor(new Date(config.sync.startDate).getTime() / 1000),
    before = Math.floor(new Date(config.sync.endDate).getTime() / 1000),
    perPage = 100
  } = options;
  
  const allActivities = [];
  let page = 1;
  let hasMore = true;
  
  while (hasMore) {
    console.log(`  📥 Page ${page} pour athlète ${athleteId}...`);
    
    const activities = await stravaApiCall('/athlete/activities', accessToken, {
      after,
      before,
      page,
      per_page: perPage
    });
    
    if (activities.length === 0) {
      hasMore = false;
    } else {
      // Enrichir chaque activité avec l'athlete_id
      activities.forEach(activity => {
        activity.athlete_id = String(athleteId);
      });
      allActivities.push(...activities);
      page++;
      
      // Pause pour respecter les rate limits (100 req/15min)
      await new Promise(r => setTimeout(r, 200));
    }
  }
  
  return allActivities;
}

/**
 * Récupère les streams (données GPS) d'une activité
 * Utile pour le calcul des pentes raides
 */
async function getActivityStreams(athleteId, activityId, keys = ['altitude', 'grade_smooth', 'distance']) {
  const accessToken = await getValidToken(athleteId);
  if (!accessToken) {
    throw new Error(`Pas de token valide pour l'athlète ${athleteId}`);
  }
  
  return await stravaApiCall(
    `/activities/${activityId}/streams`,
    accessToken,
    { keys: keys.join(','), key_by_type: true }
  );
}

/**
 * Synchronise les activités de tous les athlètes connectés
 */
async function syncAllActivities() {
  const tokens = dataManager.getTokens();
  const athleteIds = Object.keys(tokens);
  
  if (athleteIds.length === 0) {
    console.log('⚠️  Aucun athlète connecté');
    return { synced: 0, total: 0 };
  }
  
  console.log(`\n🔄 Synchronisation de ${athleteIds.length} athlète(s)...`);
  
  let totalActivities = 0;
  const results = [];
  
  for (const athleteId of athleteIds) {
    try {
      const activities = await getAthleteActivities(athleteId);
      const result = dataManager.mergeActivities(activities);
      
      console.log(`  ✅ Athlète ${athleteId}: ${activities.length} activités (${result.added} nouvelles)`);
      results.push({ athleteId, success: true, count: activities.length });
      totalActivities += activities.length;
      
    } catch (error) {
      console.error(`  ❌ Athlète ${athleteId}: ${error.message}`);
      results.push({ athleteId, success: false, error: error.message });
    }
    
    // Pause entre chaque athlète
    await new Promise(r => setTimeout(r, 1000));
  }
  
  console.log(`\n✅ Sync terminée: ${totalActivities} activités au total\n`);
  
  return { results, total: totalActivities };
}

/**
 * Vérifie si un athlète est dans la liste des participants autorisés
 */
function isAuthorizedAthlete(athleteId) {
  return config.participants.some(p => p.id === String(athleteId));
}

// ============================================
// EXPORT
// ============================================

module.exports = {
  getAuthorizationUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  getValidToken,
  getAthleteActivities,
  getActivityStreams,
  syncAllActivities,
  isAuthorizedAthlete
};
