/**
 * ============================================
 * VERSANT API - SERVEUR PRINCIPAL
 * ============================================
 * 
 * API Express pour:
 * - Authentification OAuth Strava
 * - Synchronisation des activités
 * - Gestion des jokers
 * - Endpoints pour le frontend
 */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const config = require('./config');
const dataManager = require('./data-manager');
const strava = require('./strava');

const app = express();

// ============================================
// MIDDLEWARE
// ============================================

// Parser JSON
app.use(express.json());

// CORS - Autoriser le frontend
app.use(cors({
  origin: [
    config.server.frontendUrl,
    'http://localhost:8000',
    'http://localhost:3000',
    'http://127.0.0.1:8000'
  ],
  credentials: true
}));

// Logger les requêtes
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} | ${req.method} ${req.path}`);
  next();
});

// ============================================
// ROUTES - AUTHENTIFICATION STRAVA
// ============================================

/**
 * GET /auth/strava
 * Redirige vers la page d'autorisation Strava
 */
app.get('/auth/strava', (req, res) => {
  const state = req.query.state || ''; // Optionnel: pour identifier l'utilisateur
  const authUrl = strava.getAuthorizationUrl(state);
  console.log('🔗 Redirection vers Strava OAuth...');
  res.redirect(authUrl);
});

/**
 * GET /auth/callback
 * Callback appelé par Strava après autorisation
 */
app.get('/auth/callback', async (req, res) => {
  const { code, error, state } = req.query;
  
  if (error) {
    console.error('❌ Erreur OAuth:', error);
    return res.redirect(`${config.server.frontendUrl}/login.html?error=${error}`);
  }
  
  if (!code) {
    return res.redirect(`${config.server.frontendUrl}/login.html?error=no_code`);
  }
  
  try {
    // Échanger le code contre un token
    const tokenData = await strava.exchangeCodeForToken(code);
    const athleteId = tokenData.athlete.id;
    
    console.log(`✅ Athlète connecté: ${tokenData.athlete.firstname} ${tokenData.athlete.lastname} (ID: ${athleteId})`);
    
    // Vérifier si l'athlète est autorisé
    if (!strava.isAuthorizedAthlete(athleteId)) {
      console.warn(`⚠️  Athlète ${athleteId} non autorisé`);
      return res.redirect(`${config.server.frontendUrl}/login.html?error=unauthorized`);
    }
    
    // Sauvegarder le token
    dataManager.saveAthleteToken(athleteId, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: tokenData.expires_at,
      athlete: {
        id: athleteId,
        firstname: tokenData.athlete.firstname,
        lastname: tokenData.athlete.lastname,
        profile: tokenData.athlete.profile
      }
    });
    
    // Rediriger vers le frontend avec succès
    res.redirect(`${config.server.frontendUrl}/dashboard.html?strava=connected&athlete=${athleteId}`);
    
    // Synchroniser les activités en arrière-plan
    setTimeout(async () => {
      try {
        console.log(`🔄 Sync initiale pour athlète ${athleteId}...`);
        const activities = await strava.getAthleteActivities(athleteId);
        const result = dataManager.mergeActivities(activities);
        console.log(`✅ ${result.added} nouvelles activités ajoutées`);
      } catch (err) {
        console.error('❌ Erreur sync initiale:', err.message);
      }
    }, 1000);
    
  } catch (err) {
    console.error('❌ Erreur callback OAuth:', err.message);
    res.redirect(`${config.server.frontendUrl}/login.html?error=token_error`);
  }
});

/**
 * GET /auth/status
 * Vérifie le statut de connexion d'un athlète
 */
app.get('/auth/status/:athleteId', (req, res) => {
  const { athleteId } = req.params;
  const token = dataManager.getAthleteToken(athleteId);
  
  if (token) {
    res.json({
      connected: true,
      athlete: token.athlete,
      expires_at: token.expires_at
    });
  } else {
    res.json({ connected: false });
  }
});

/**
 * GET /auth/connected
 * Liste tous les athlètes connectés
 */
app.get('/auth/connected', (req, res) => {
  const tokens = dataManager.getTokens();
  const connected = Object.entries(tokens).map(([id, data]) => ({
    id,
    name: `${data.athlete?.firstname || ''} ${data.athlete?.lastname || ''}`.trim(),
    profile: data.athlete?.profile
  }));
  
  res.json({ count: connected.length, athletes: connected });
});

// ============================================
// ROUTES - ACTIVITÉS
// ============================================

/**
 * GET /activities
 * Récupère toutes les activités stockées
 */
app.get('/activities', (req, res) => {
  const activities = dataManager.getActivities();
  res.json({
    count: activities.length,
    activities
  });
});

/**
 * GET /activities/:athleteId
 * Récupère les activités d'un athlète spécifique
 */
app.get('/activities/:athleteId', (req, res) => {
  const { athleteId } = req.params;
  const activities = dataManager.getActivities()
    .filter(a => String(a.athlete_id || a.athlete?.id) === String(athleteId));
  
  res.json({
    athleteId,
    count: activities.length,
    activities
  });
});

/**
 * POST /sync
 * Déclenche une synchronisation manuelle
 */
app.post('/sync', async (req, res) => {
  try {
    const result = await strava.syncAllActivities();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /sync/:athleteId
 * Synchronise un athlète spécifique
 */
app.post('/sync/:athleteId', async (req, res) => {
  const { athleteId } = req.params;
  
  try {
    const activities = await strava.getAthleteActivities(athleteId);
    const result = dataManager.mergeActivities(activities);
    res.json({ success: true, athleteId, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ROUTES - JOKERS
// ============================================

/**
 * GET /jokers
 * Récupère tous les jokers
 */
app.get('/jokers', (req, res) => {
  const jokers = dataManager.getJokers();
  res.json(jokers);
});

/**
 * GET /jokers/:athleteId
 * Récupère les jokers d'un athlète
 */
app.get('/jokers/:athleteId', (req, res) => {
  const { athleteId } = req.params;
  const jokers = dataManager.getAthleteJokers(athleteId);
  res.json(jokers);
});

/**
 * POST /jokers/:athleteId
 * Met à jour les jokers d'un athlète
 */
app.post('/jokers/:athleteId', (req, res) => {
  const { athleteId } = req.params;
  const data = req.body;
  
  if (!data) {
    return res.status(400).json({ error: 'Données manquantes' });
  }
  
  dataManager.saveAthleteJokers(athleteId, data);
  res.json({ success: true, athleteId });
});

// ============================================
// ROUTES - UTILITAIRES
// ============================================

/**
 * GET /health
 * Health check pour monitoring
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

/**
 * GET /stats
 * Statistiques générales
 */
app.get('/stats', (req, res) => {
  const tokens = dataManager.getTokens();
  const activities = dataManager.getActivities();
  
  res.json({
    connectedAthletes: Object.keys(tokens).length,
    totalActivities: activities.length,
    lastActivity: activities.length > 0 
      ? activities.sort((a, b) => new Date(b.start_date) - new Date(a.start_date))[0]?.start_date
      : null
  });
});

// ============================================
// ROUTES - PARTICIPANTS / INSCRIPTIONS
// ============================================

/**
 * GET /api/participants
 * Liste tous les participants inscrits
 */
app.get('/api/participants', (req, res) => {
  const participants = dataManager.getParticipants();
  res.json({
    count: participants.length,
    participants: participants.map(p => ({
      id: p.id,
      name: p.name,
      status: p.status || 'active',
      registered_at: p.registered_at
    }))
  });
});

/**
 * POST /api/athletes/register
 * Inscription d'un nouvel athlète
 */
app.post('/api/athletes/register', async (req, res) => {
  try {
    const { 
      athlete_id, 
      name, 
      email, 
      password,
      strava_data,
      access_token,
      refresh_token,
      expires_at,
      league_id 
    } = req.body;
    
    // Validation
    if (!athlete_id || !name || !email) {
      return res.status(400).json({ error: 'Champs obligatoires manquants' });
    }
    
    // Vérifier si déjà inscrit
    const existing = dataManager.getParticipants().find(p => p.id === String(athlete_id));
    if (existing) {
      return res.status(409).json({ error: 'Cet athlète est déjà inscrit' });
    }
    
    // Enregistrer le participant
    const participant = dataManager.registerParticipant({
      id: String(athlete_id),
      name,
      email,
      strava_data,
      league_id: league_id || 'versant-2026'
    });
    
    // Sauvegarder les tokens Strava si fournis
    if (access_token && refresh_token) {
      dataManager.saveAthleteToken(athlete_id, {
        access_token,
        refresh_token,
        expires_at,
        athlete: strava_data
      });
    }
    
    console.log(`✅ Nouvel inscrit: ${name} (${athlete_id})`);
    
    res.json({
      success: true,
      message: `Bienvenue ${name} ! Votre inscription est confirmée.`,
      athlete_id: String(athlete_id),
      token: `session_${athlete_id}_${Date.now()}` // Token de session simple
    });
    
  } catch (error) {
    console.error('❌ Erreur inscription:', error);
    res.status(500).json({ error: 'Erreur lors de l\'inscription' });
  }
});

/**
 * POST /api/auth/strava/exchange
 * Échange un code OAuth contre un token (pour inscription)
 */
app.post('/api/auth/strava/exchange', async (req, res) => {
  const { code } = req.body;
  
  if (!code) {
    return res.status(400).json({ error: 'Code manquant' });
  }
  
  try {
    const tokenData = await strava.exchangeCodeForToken(code);
    res.json(tokenData);
  } catch (error) {
    console.error('❌ Erreur échange token:', error);
    res.status(500).json({ error: 'Échec de l\'échange de token' });
  }
});

/**
 * DELETE /api/participants/:athleteId
 * Supprime un participant (admin)
 */
app.delete('/api/participants/:athleteId', (req, res) => {
  const { athleteId } = req.params;
  
  try {
    dataManager.removeParticipant(athleteId);
    console.log(`🗑️ Participant supprimé: ${athleteId}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

// ============================================
// SYNCHRONISATION AUTOMATIQUE (CRON)
// ============================================

// Toutes les heures: synchroniser les activités
cron.schedule('0 * * * *', async () => {
  console.log('\n⏰ [CRON] Synchronisation automatique...');
  try {
    await strava.syncAllActivities();
  } catch (error) {
    console.error('❌ [CRON] Erreur:', error.message);
  }
});

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================

app.listen(config.server.port, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   🏔️  VERSANT API                                     ║
║                                                       ║
║   Serveur démarré sur le port ${config.server.port}                  ║
║   URL: ${config.server.baseUrl}                       
║                                                       ║
║   Endpoints:                                          ║
║   - GET  /auth/strava      → Connexion Strava         ║
║   - GET  /auth/callback    → Callback OAuth           ║
║   - GET  /activities       → Toutes les activités     ║
║   - POST /sync             → Synchronisation          ║
║   - GET  /jokers           → Tous les jokers          ║
║   - GET  /health           → Health check             ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
  `);
  
  // Afficher les athlètes déjà connectés
  const tokens = dataManager.getTokens();
  const count = Object.keys(tokens).length;
  if (count > 0) {
    console.log(`📊 ${count} athlète(s) déjà connecté(s)`);
  } else {
    console.log('⚠️  Aucun athlète connecté. Utilisez /auth/strava pour commencer.');
  }
});
