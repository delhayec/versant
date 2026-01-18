/**
 * ============================================
 * VERSANT - INSCRIPTION AVEC MOT DE PASSE
 * ============================================
 */

const API_BASE_URL = '/api';

// Configuration Strava OAuth
const STRAVA_CONFIG = {
  clientId: '195975', // ← Remplacer par votre Client ID
  redirectUri: window.location.origin + '/inscription.html',
  scope: 'read,activity:read_all'
};

// État de l'inscription
let athleteData = null;
let stravaTokens = null;

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

    const response = await fetch(`${API_BASE_URL}/auth/strava/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });

    if (!response.ok) {
      throw new Error('Échec de l\'authentification Strava');
    }

    const data = await response.json();
    stravaTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at
    };
    athleteData = data.athlete;

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
  document.querySelector('.strava-connect-section').style.display = 'none';
  
  const form = document.getElementById('registrationForm');
  form.classList.add('active');

  const preview = document.getElementById('athletePreview');
  preview.innerHTML = `
    <img src="${athleteData.profile}" alt="${athleteData.firstname} ${athleteData.lastname}" class="athlete-avatar">
    <div class="athlete-info">
      <h4>${athleteData.firstname} ${athleteData.lastname}</h4>
      <p>ID Strava: ${athleteData.id}</p>
    </div>
  `;

  document.getElementById('athleteName').value = `${athleteData.firstname} ${athleteData.lastname.charAt(0)}`;
}

// ============================================
// GESTION DES ÉVÉNEMENTS
// ============================================
function setupEventListeners() {
  const submitBtn = document.getElementById('submitBtn');
  const acceptTerms = document.getElementById('acceptTerms');
  const password = document.getElementById('athletePassword');
  const passwordConfirm = document.getElementById('athletePasswordConfirm');

  // Activation du bouton
  acceptTerms?.addEventListener('change', (e) => {
    submitBtn.disabled = !e.target.checked;
  });

  // Validation du mot de passe
  passwordConfirm?.addEventListener('input', () => {
    if (password.value !== passwordConfirm.value) {
      passwordConfirm.setCustomValidity('Les mots de passe ne correspondent pas');
    } else {
      passwordConfirm.setCustomValidity('');
    }
  });

  // Soumission
  submitBtn?.addEventListener('click', handleSubmit);
}

// ============================================
// SOUMISSION DE L'INSCRIPTION
// ============================================
async function handleSubmit() {
  const athleteName = document.getElementById('athleteName').value.trim();
  const athleteEmail = document.getElementById('athleteEmail').value.trim();
  const password = document.getElementById('athletePassword').value;
  const passwordConfirm = document.getElementById('athletePasswordConfirm').value;
  const acceptTerms = document.getElementById('acceptTerms').checked;

  // Validations
  if (!athleteName) {
    showError('Veuillez entrer votre nom d\'affichage');
    return;
  }

  if (!athleteEmail) {
    showError('L\'adresse e-mail est obligatoire');
    return;
  }

  // Validation format email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(athleteEmail)) {
    showError('Format d\'email invalide');
    return;
  }

  if (!password || password.length < 6) {
    showError('Le mot de passe doit contenir au moins 6 caractères');
    return;
  }

  if (password !== passwordConfirm) {
    showError('Les mots de passe ne correspondent pas');
    return;
  }

  if (!acceptTerms) {
    showError('Veuillez accepter les conditions');
    return;
  }

  if (!athleteData || !stravaTokens) {
    showError('Erreur: données Strava manquantes. Veuillez vous reconnecter à Strava.');
    return;
  }

  try {
    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Inscription en cours...';

    // Envoyer au backend
    const response = await fetch(`${API_BASE_URL}/athletes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        athlete_id: String(athleteData.id),
        name: athleteName,
        email: athleteEmail,
        password: password,
        strava_data: athleteData,
        access_token: stravaTokens.access_token,
        refresh_token: stravaTokens.refresh_token,
        expires_at: stravaTokens.expires_at,
        league_id: 'versant-2026'
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Erreur lors de l\'inscription');
    }

    const result = await response.json();
    
    // Sauvegarder le token de session
    if (result.token) {
      localStorage.setItem('versant_token', result.token);
      localStorage.setItem('versant_athlete_id', result.athlete_id);
    }
    
    // Afficher succès
    showSuccess(result.message, result.active_from_season);

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

function showSuccess(message, seasonNumber) {
  document.getElementById('registrationForm').style.display = 'none';
  
  const successDiv = document.getElementById('successMessage');
  
  let html = `
    <h3>🎉 Inscription réussie !</h3>
    <p>${message}</p>
  `;
  
  if (seasonNumber > 1) {
    html += `
      <p style="margin-top: 16px; padding: 12px; background: rgba(249,115,22,0.1); border-radius: 8px; border: 1px solid rgba(249,115,22,0.3);">
        ℹ️ La saison est déjà en cours. Vous rejoindrez la ligue à la <strong>Saison ${seasonNumber}</strong>
      </p>
    `;
  }
  
  html += `
    <p style="margin-top: 24px;">
      <a href="dashboard.html" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #f97316, #f43f5e); color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">
        Accéder à mon dashboard
      </a>
    </p>
  `;
  
  successDiv.innerHTML = html;
  successDiv.classList.add('active');
  
  window.history.replaceState({}, document.title, window.location.pathname);
}
