/**
 * ============================================
 * VERSANT API - CONFIGURATION
 * ============================================
 * 
 * ⚠️  IMPORTANT: Ne jamais commiter ce fichier avec le CLIENT_SECRET rempli !
 *     En production, utilise des variables d'environnement.
 */

module.exports = {
  // === STRAVA API ===
  strava: {
    clientId: '195975',
    clientSecret: process.env.STRAVA_CLIENT_SECRET || 'REMPLACE_PAR_TON_SECRET',
    
    // URLs de l'API Strava
    authUrl: 'https://www.strava.com/oauth/authorize',
    tokenUrl: 'https://www.strava.com/oauth/token',
    apiBase: 'https://www.strava.com/api/v3',
    
    // Permissions demandées (scopes)
    // - read: infos basiques
    // - activity:read_all: toutes les activités (même privées)
    scopes: 'read,activity:read_all'
  },
  
  // === SERVEUR ===
  server: {
    port: process.env.PORT || 3000,
    // Change cette URL quand tu auras un domaine
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:8000'
  },
  
  // === PARTICIPANTS VERSANT ===
  // Liste des athlete_id Strava autorisés
  participants: [
    { id: '3953180', name: 'Clement D' },
    { id: '6635902', name: 'Bapt I' },
    { id: '3762537', name: 'Bapt M' },
    { id: '68391361', name: 'Elo F' },
    { id: '5231535', name: 'Franck P' },
    { id: '87904944', name: 'Guillaume B' },
    { id: '1841009', name: 'Mana S' },
    { id: '106477520', name: 'Matt X' },
    { id: '119310419', name: 'Max 2Peuf' },
    { id: '19523416', name: 'Morguy D' },
    { id: '110979265', name: 'Pef B' },
    { id: '84388438', name: 'Remi S' },
    { id: '25332977', name: 'Thomas G' }
  ],
  
  // === CHEMINS DES FICHIERS DE DONNÉES ===
  paths: {
    tokens: './data/tokens.json',       // Tokens OAuth des athlètes
    activities: './data/activities.json', // Activités synchronisées
    jokers: './data/jokers.json',        // État des bonus/jokers
    participants: './data/participants.json' // Participants inscrits
  },
  
  // === SYNCHRONISATION ===
  sync: {
    // Intervalle de synchronisation automatique (en minutes)
    intervalMinutes: 60,
    
    // Année des données à récupérer
    year: 2025,
    
    // Date de début du challenge
    startDate: '2025-01-01',
    endDate: '2025-12-31'
  }
};
