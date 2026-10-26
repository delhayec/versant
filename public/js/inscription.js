/**
 * ============================================
 * VERSANT - INSCRIPTION AVEC MOT DE PASSE
 * ============================================
 */

const API_BASE_URL = '/api';

// Configuration Strava OAuth (clientId chargé dynamiquement)
const STRAVA_CONFIG = {
  clientId: null, // Chargé depuis /api/strava-client-id
  redirectUri: window.location.origin + '/inscription.html',
  scope: 'read,activity:read_all'
};

// État de l'inscription
let athleteData = null;
let stravaTokens = null;

// Code d'invitation (L51) : lien inscription.html?invitation=ABCD-EFGH. Gardé
// le temps de l'aller-retour vers Strava, qui ne renvoie que ses paramètres.
const INVITE_KEY = 'versant_invite_code';
function rememberInviteCode() {
  const code = new URLSearchParams(window.location.search).get('invitation');
  try {
    if (code) sessionStorage.setItem(INVITE_KEY, code);
    return sessionStorage.getItem(INVITE_KEY) || '';
  } catch {
    return code || '';
  }
}
const pendingInviteCode = rememberInviteCode();

// ============================================
// INITIALISATION
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  // Charger le client ID Strava depuis le serveur
  try {
    const response = await fetch('/api/strava-client-id');
    if (response.ok) {
      const data = await response.json();
      STRAVA_CONFIG.clientId = data.clientId;
    }
  } catch (e) {
    console.warn('⚠️ Impossible de charger le client ID Strava');
  }
  
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
  document.getElementById('inviteCode').value = pendingInviteCode;
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
  const inviteCode = document.getElementById('inviteCode').value.trim();

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
        expires_at: stravaTokens.expires_at
        // Plus de ligue imposée (L51) : la ligue se rejoint avec son code
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
    
    // Ligue rejointe avec le code d'invitation, s'il y en a un
    let joined = null;
    let joinError = null;
    if (inviteCode && result.token) {
      try {
        const joinResponse = await fetch(`${API_BASE_URL}/leagues/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${result.token}` },
          body: JSON.stringify({ code: inviteCode })
        });
        const joinData = await joinResponse.json().catch(() => ({}));
        if (joinResponse.ok) joined = joinData;
        else joinError = joinData.error || `Erreur ${joinResponse.status}`;
      } catch (e) {
        joinError = e.message;
      }
    }
    try { sessionStorage.removeItem(INVITE_KEY); } catch { /* sans stockage */ }

    // Afficher succès. Le backend ne renvoie pas de `message` : on garde un
    // texte par défaut plutôt que d'afficher « undefined ».
    showSuccess(
      result.message || 'Votre compte Versant est créé et votre Strava est connecté.',
      // Saison d'entrée : calculée sur le calendrier de versant-2026 (édition historique)
      joined?.edition?.legacyId ? result.active_from_season : null,
      { joined, joinError }
    );

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

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showSuccess(message, seasonNumber, { joined = null, joinError = null } = {}) {
  document.getElementById('registrationForm').style.display = 'none';
  
  const successDiv = document.getElementById('successMessage');
  
  let html = `
    <h3>🎉 Inscription réussie !</h3>
    <p>${message}</p>
  `;

  if (joined?.league) {
    html += `<p style="margin-top: 16px;">Tu fais maintenant partie de la ligue <strong>${escapeHtml(joined.league.name)}</strong>.</p>`;
  } else if (joinError) {
    html += `<p style="margin-top: 16px; color: #f87171;">Le code d'invitation n'a pas fonctionné : ${escapeHtml(joinError)}. Tu pourras le saisir à nouveau sur la page suivante.</p>`;
  } else {
    html += `<p style="margin-top: 16px;">Il te reste à rejoindre une ligue : sur la page suivante, entre le code d'invitation que t'a donné son admin.</p>`;
  }
  
  if (seasonNumber > 1) {
    html += `
      <p style="margin-top: 16px; padding: 12px; background: rgba(249,115,22,0.1); border-radius: 8px; border: 1px solid rgba(249,115,22,0.3);">
        ℹ️ La saison est déjà en cours : vous entrerez en jeu à la <strong>Saison ${seasonNumber}</strong>.
        D'ici là vos sorties sont enregistrées, mais elles ne comptent pas encore au classement.
      </p>
    `;
  }
  
  html += `
    <p style="margin-top: 24px;">
      <a href="${joined?.league ? 'dashboard.html' : 'index.html'}" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #f97316, #f43f5e); color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">
        ${joined?.league ? 'Accéder à mon dashboard' : 'Continuer'}
      </a>
    </p>
  `;
  
  successDiv.innerHTML = html;
  successDiv.classList.add('active');
  
  window.history.replaceState({}, document.title, window.location.pathname);
}
