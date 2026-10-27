/**
 * ============================================
 * VERSANT - INSCRIPTION
 * ============================================
 * Parcours en 3 étapes (L55) :
 *   1. code de la ligue, obligatoire, vérifié par le serveur ;
 *   2. connexion Strava, possible seulement avec un code valide ;
 *   3. compte Versant : nom, e-mail, mot de passe.
 * Le compte est créé, puis la ligue rejointe avec le code.
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
let validCode = null;   // code de ligue vérifié
let leagueName = null;

// Code d'invitation : lien inscription.html?invitation=ABCD-EFGH ou saisi.
// Gardé le temps de l'aller-retour vers Strava, qui ne renvoie que ses paramètres.
const INVITE_KEY = 'versant_invite_code';
const storage = {
  get() { try { return sessionStorage.getItem(INVITE_KEY) || ''; } catch { return ''; } },
  set(code) { try { sessionStorage.setItem(INVITE_KEY, code); } catch { /* sans stockage */ } },
  clear() { try { sessionStorage.removeItem(INVITE_KEY); } catch { /* sans stockage */ } }
};

const $ = id => document.getElementById(id);
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normalizeCode = code => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const formatCode = code => {
  const n = normalizeCode(code).slice(0, 8);
  return n.length > 4 ? `${n.slice(0, 4)}-${n.slice(4)}` : n;
};

// ============================================
// INITIALISATION
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const response = await fetch('/api/strava-client-id');
    if (response.ok) STRAVA_CONFIG.clientId = (await response.json()).clientId;
  } catch (e) {
    console.warn('⚠️ Impossible de charger le client ID Strava');
  }

  setupEventListeners();

  const params = new URLSearchParams(window.location.search);
  const initialCode = params.get('invitation') || storage.get();
  if (initialCode) $('inviteCode').value = formatCode(initialCode);
  setStep('code');

  if (params.get('error')) {
    showError('Connexion Strava annulée ou refusée');
  }
  if (initialCode) await checkCode();
  if (params.get('code')) await handleStravaCallback(params.get('code'));
});

// ============================================
// ÉTAPES
// ============================================
// code : seule l'étape 1 est ouverte (Strava si le code est valide)
// account : code et Strava faits, formulaire du compte ouvert
function setStep(step) {
  const account = step === 'account';
  $('stepCode').classList.toggle('done', account || !!validCode);
  $('stepStrava').classList.toggle('locked', !validCode && !account);
  $('stepStrava').classList.toggle('done', account);
  $('stepAccount').classList.toggle('locked', !account);
  $('registrationForm').classList.toggle('active', account);
  $('inviteCode').disabled = account;
  $('stravaConnectBtn').hidden = account;
  $('stravaConnectBtn').disabled = !validCode || !STRAVA_CONFIG.clientId;
  $('stravaLock').hidden = !!validCode || account;
}

// ============================================
// ÉTAPE 1 : CODE DE LA LIGUE
// ============================================
let checkTimer = null;
let checkSeq = 0;

async function checkCode() {
  const input = $('inviteCode');
  const status = $('codeStatus');
  const code = normalizeCode(input.value);
  const seq = ++checkSeq;
  validCode = null;
  leagueName = null;
  input.classList.remove('valid', 'invalid');
  status.className = 'code-status';
  status.textContent = '';
  if (code.length < 8) {
    setStep('code');
    return false;
  }
  status.textContent = 'Vérification…';
  try {
    const response = await fetch(`${API_BASE_URL}/leagues/invite/${encodeURIComponent(code)}`);
    const data = await response.json().catch(() => ({}));
    if (seq !== checkSeq) return false; // une saisie plus récente a pris le relais
    if (!response.ok) throw new Error(data.error || 'Code d\'invitation inconnu');
    validCode = code;
    leagueName = data.league?.name || '';
    storage.set(code);
    input.classList.add('valid');
    status.classList.add('ok');
    status.textContent = `✓ Ligue ${leagueName}`;
  } catch (error) {
    if (seq !== checkSeq) return false;
    input.classList.add('invalid');
    status.classList.add('ko');
    status.textContent = error.message;
  }
  setStep(athleteData ? 'account' : 'code');
  return !!validCode;
}

// ============================================
// ÉTAPE 2 : STRAVA
// ============================================
function connectStrava() {
  if (!validCode || !STRAVA_CONFIG.clientId) return;
  storage.set(validCode);
  window.location.href = 'https://www.strava.com/oauth/authorize?' +
    `client_id=${STRAVA_CONFIG.clientId}&` +
    `redirect_uri=${encodeURIComponent(STRAVA_CONFIG.redirectUri)}&` +
    'response_type=code&' +
    'approval_prompt=auto&' +
    `scope=${STRAVA_CONFIG.scope}`;
}

async function handleStravaCallback(code) {
  // Sans code de ligue valide, pas d'inscription : retour à l'étape 1
  if (!validCode) {
    showError('Entre le code de ta ligue, puis reconnecte-toi à Strava.');
    window.history.replaceState({}, document.title, window.location.pathname);
    return;
  }
  const btn = $('stravaConnectBtn');
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Connexion en cours...';
  try {
    const response = await fetch(`${API_BASE_URL}/auth/strava/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    if (!response.ok) throw new Error('Échec de l\'authentification Strava');
    const data = await response.json();
    stravaTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at
    };
    athleteData = data.athlete;
    // Le code Strava ne sert qu'une fois : on le retire de l'adresse
    window.history.replaceState({}, document.title, window.location.pathname);
    showAthlete();
    setStep('account');
  } catch (error) {
    console.error('Erreur d\'authentification:', error);
    showError('Erreur lors de la connexion à Strava. Réessaie.');
    btn.innerHTML = label;
    setStep('code');
  }
}

function showAthlete() {
  const preview = $('athletePreview');
  preview.innerHTML = `
    <img src="${escapeHtml(athleteData.profile || '')}" alt="" class="athlete-avatar">
    <div class="athlete-info">
      <h4>${escapeHtml(`${athleteData.firstname} ${athleteData.lastname}`)}</h4>
      <p>✓ Compte Strava connecté</p>
    </div>
  `;
  preview.hidden = false;
  $('athleteName').value = `${athleteData.firstname} ${(athleteData.lastname || '').charAt(0)}`.trim();
}

// ============================================
// GESTION DES ÉVÉNEMENTS
// ============================================
function setupEventListeners() {
  const input = $('inviteCode');
  input.addEventListener('input', () => {
    const formatted = formatCode(input.value);
    if (formatted !== input.value) input.value = formatted;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(checkCode, 300);
  });

  $('stravaConnectBtn').addEventListener('click', connectStrava);

  const submitBtn = $('submitBtn');
  $('acceptTerms').addEventListener('change', e => { submitBtn.disabled = !e.target.checked; });

  const password = $('athletePassword');
  const passwordConfirm = $('athletePasswordConfirm');
  passwordConfirm.addEventListener('input', () => {
    passwordConfirm.setCustomValidity(password.value !== passwordConfirm.value ? 'Les mots de passe ne correspondent pas' : '');
  });

  submitBtn.addEventListener('click', handleSubmit);
}

// ============================================
// ÉTAPE 3 : CRÉATION DU COMPTE
// ============================================
async function handleSubmit() {
  const athleteName = $('athleteName').value.trim();
  const athleteEmail = $('athleteEmail').value.trim();
  const password = $('athletePassword').value;
  const passwordConfirm = $('athletePasswordConfirm').value;

  if (!athleteName) return showError('Entre ton nom d\'affichage');
  if (!athleteEmail) return showError('L\'adresse e-mail est obligatoire');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(athleteEmail)) return showError('Format d\'e-mail invalide');
  if (!password || password.length < 6) return showError('Le mot de passe doit contenir au moins 6 caractères');
  if (password !== passwordConfirm) return showError('Les mots de passe ne correspondent pas');
  if (!$('acceptTerms').checked) return showError('Accepte les conditions pour continuer');
  if (!athleteData || !stravaTokens) return showError('Données Strava manquantes : reconnecte-toi à Strava.');

  const submitBtn = $('submitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Inscription en cours...';
  try {
    // Le code peut avoir été changé par l'admin depuis l'étape 1
    if (!(await checkCode())) throw new Error('Le code de ta ligue n\'est plus valide : demande le nouveau code à son admin.');

    const response = await fetch(`${API_BASE_URL}/athletes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        athlete_id: String(athleteData.id),
        name: athleteName,
        email: athleteEmail,
        password,
        strava_data: athleteData,
        access_token: stravaTokens.access_token,
        refresh_token: stravaTokens.refresh_token,
        expires_at: stravaTokens.expires_at
      })
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Erreur lors de l\'inscription');
    }
    const result = await response.json();
    if (result.token) {
      localStorage.setItem('versant_token', result.token);
      localStorage.setItem('versant_athlete_id', result.athlete_id);
    }

    // Adhésion à la ligue avec le code vérifié
    let joined = null;
    let joinError = null;
    try {
      const joinResponse = await fetch(`${API_BASE_URL}/leagues/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${result.token}` },
        body: JSON.stringify({ code: validCode })
      });
      const joinData = await joinResponse.json().catch(() => ({}));
      if (joinResponse.ok) joined = joinData;
      else joinError = joinData.error || `Erreur ${joinResponse.status}`;
    } catch (e) {
      joinError = e.message;
    }
    storage.clear();

    // Saison d'entrée : calculée sur le calendrier de versant-2026 (édition historique)
    showSuccess(joined?.edition?.legacyId ? result.active_from_season : null, { joined, joinError });
  } catch (error) {
    console.error('Erreur d\'inscription:', error);
    showError(error.message || 'Erreur lors de l\'inscription. Réessaie.');
    submitBtn.disabled = !$('acceptTerms').checked;
    submitBtn.textContent = 'Créer mon compte';
  }
}

// ============================================
// AFFICHAGE DES MESSAGES
// ============================================
function showError(message) {
  const errorDiv = $('errorMessage');
  errorDiv.textContent = message;
  errorDiv.classList.add('active');
  errorDiv.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  setTimeout(() => errorDiv.classList.remove('active'), 6000);
}

function showSuccess(seasonNumber, { joined = null, joinError = null } = {}) {
  $('signupCard').style.display = 'none';
  let html = '<h3>🎉 Inscription réussie !</h3><p>Ton compte Versant est créé et ton Strava est connecté.</p>';
  if (joined?.league) {
    html += `<p style="margin-top: 16px;">Tu fais maintenant partie de la ligue <strong>${escapeHtml(joined.league.name)}</strong>.</p>`;
  } else if (joinError) {
    html += `<p style="margin-top: 16px; color: #f87171;">La ligue n'a pas pu être rejointe : ${escapeHtml(joinError)}. Tu pourras saisir le code à nouveau sur la page suivante.</p>`;
  }
  if (seasonNumber > 1) {
    html += `
      <p style="margin-top: 16px; padding: 12px; background: rgba(249,115,22,0.1); border-radius: 8px; border: 1px solid rgba(249,115,22,0.3);">
        ℹ️ La saison est déjà en cours : tu entreras en jeu à la <strong>Saison ${seasonNumber}</strong>.
        D'ici là tes sorties sont enregistrées, mais elles ne comptent pas encore au classement.
      </p>`;
  }
  html += `
    <p style="margin-top: 24px;">
      <a href="${joined?.league ? 'dashboard.html' : 'index.html'}" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #f97316, #f43f5e); color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">
        ${joined?.league ? 'Accéder à mon dashboard' : 'Continuer'}
      </a>
    </p>`;
  const successDiv = $('successMessage');
  successDiv.innerHTML = html;
  successDiv.classList.add('active');
  successDiv.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
