/**
 * ============================================
 * VERSANT - GESTION DES INSCRIPTIONS
 * ============================================
 */

const API_BASE_URL = '/api';

// Configuration Strava OAuth
const STRAVA_CONFIG = {
  clientId: '195975', //
  redirectUri: window.location.origin + '/inscription.html',
  scope: 'read,activity:read_all'
};

// État de l'inscription
let athleteData = null;
let accessToken = null;

// ============================================
// INITIALISATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  checkStravaCallback();
  setupEventListeners();
});

// ============================================
// GESTION DU CALLBACK STRAVA
// ============================================
function checkStravaCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const error = urlParams.get('error');

  if (error) {
    showError('Connexion Strava annulée ou refusée');
    return;
  }

  if (code) {
    // Code d'autorisation reçu, échanger contre un token
    exchangeTokenAndLoadAthlete(code);
  }
}

// ============================================
// CONNEXION STRAVA
// ============================================
document.getElementById('stravaConnectBtn')?.addEventListener('click', () => {
  const authUrl = `https://www.strava.com/oauth/authorize?` +
    `client_id=${STRAVA_CONFIG.clientId}&` +
    `redirect_uri=${encodeURIComponent(STRAVA_CONFIG.redirectUri)}&` +
    `response_type=code&` +
    `approval_prompt=auto&` +
    `scope=${STRAVA_CONFIG.scope}`;
  
  window.location.href = authUrl;
});

// ============================================
// ÉCHANGE DU CODE CONTRE UN TOKEN
// ============================================
async function exchangeTokenAndLoadAthlete(code) {
  try {
    const btn = document.getElementById('stravaConnectBtn');
    btn.disabled = true;
    btn.textContent = 'Connexion en cours...';

    // Appel API backend pour échanger le code
    const response = await fetch(`${API_BASE_URL}/auth/strava/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });

    if (!response.ok) {
      throw new Error('Échec de l\'authentification Strava');
    }

    const data = await response.json();
    accessToken = data.access_token;
    athleteData = data.athlete;

    // Afficher le formulaire d'inscription
    displayRegistrationForm();

  } catch (error) {
    console.error('Erreur d\'authentification:', error);
    showError('Erreur lors de la connexion à Strava. Veuillez réessayer.');
    
    const btn = document.getElementById('stravaConnectBtn');
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
        <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/>
      </svg>
      Se connecter avec Strava
    `;
  }
}

// ============================================
// AFFICHAGE DU FORMULAIRE
// ============================================
function displayRegistrationForm() {
  // Masquer la section de connexion
  document.querySelector('.strava-connect-section').style.display = 'none';
  
  // Afficher le formulaire
  const form = document.getElementById('registrationForm');
  form.classList.add('active');

  // Remplir les données de l'athlète
  const preview = document.getElementById('athletePreview');
  preview.innerHTML = `
    <img src="${athleteData.profile}" alt="${athleteData.firstname} ${athleteData.lastname}" class="athlete-avatar">
    <div class="athlete-info">
      <h4>${athleteData.firstname} ${athleteData.lastname}</h4>
      <p>ID Strava: ${athleteData.id}</p>
    </div>
  `;

  // Pré-remplir le nom
  document.getElementById('athleteName').value = `${athleteData.firstname} ${athleteData.lastname.charAt(0)}`;
}

// ============================================
// GESTION DES ÉVÉNEMENTS
// ============================================
function setupEventListeners() {
  const submitBtn = document.getElementById('submitBtn');
  const acceptTerms = document.getElementById('acceptTerms');

  // Activation du bouton selon la checkbox
  acceptTerms?.addEventListener('change', (e) => {
    submitBtn.disabled = !e.target.checked;
  });

  // Soumission du formulaire
  submitBtn?.addEventListener('click', handleSubmit);
}

// ============================================
// SOUMISSION DE L'INSCRIPTION
// ============================================
async function handleSubmit() {
  const athleteName = document.getElementById('athleteName').value.trim();
  const athleteEmail = document.getElementById('athleteEmail').value.trim();
  const acceptTerms = document.getElementById('acceptTerms').checked;

  if (!athleteName) {
    showError('Veuillez entrer votre nom d\'affichage');
    return;
  }

  if (!acceptTerms) {
    showError('Veuillez accepter les conditions');
    return;
  }

  try {
    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Inscription en cours...';

    // Envoyer les données au backend
    const response = await fetch(`${API_BASE_URL}/athletes/register`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        athlete_id: athleteData.id,
        name: athleteName,
        email: athleteEmail,
        strava_data: athleteData,
        access_token: accessToken,
        league_id: 'versant-2026' // ID de la ligue
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Erreur lors de l\'inscription');
    }

    const result = await response.json();
    
    // Afficher le message de succès
    showSuccess();

  } catch (error) {
    console.error('Erreur d\'inscription:', error);
    showError(error.message || 'Erreur lors de l\'inscription. Veuillez réessayer.');
    
    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Confirmer mon inscription';
  }
}

// ============================================
// AFFICHAGE DES MESSAGES
// ============================================
function showError(message) {
  const errorDiv = document.getElementById('errorMessage');
  errorDiv.textContent = message;
  errorDiv.classList.add('active');
  
  setTimeout(() => {
    errorDiv.classList.remove('active');
  }, 5000);
}

function showSuccess() {
  // Masquer le formulaire
  document.getElementById('registrationForm').style.display = 'none';
  
  // Afficher le message de succès
  const successDiv = document.getElementById('successMessage');
  successDiv.classList.add('active');
  
  // Nettoyer l'URL
  window.history.replaceState({}, document.title, window.location.pathname);
}
