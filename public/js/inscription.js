/**
 * ============================================
 * VERSANT - INSCRIPTION
 * ============================================
 * Parcours en 3 étapes (L55) :
 *   1. code de la ligue, obligatoire, vérifié par le serveur ;
 *   2. connexion Strava, possible seulement avec un code valide ;
 *   3. compte Versant : nom, e-mail validé par un code (L58), mot de passe.
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
let codeSentTo = null;  // e-mail auquel le code de validation a été envoyé

// Code d'invitation : lien inscription.html?invitation=ABCD-EFGH ou saisi.
// Gardé le temps de l'aller-retour vers Strava, qui ne renvoie que ses paramètres.
const INVITE_KEY = 'versant_invite_code';
const storage = {
  get() { try { return sessionStorage.getItem(INVITE_KEY) || ''; } catch { return ''; } },
  set(code) { try { sessionStorage.setItem(INVITE_KEY, code); } catch { /* sans stockage */ } },
  clear() { try { sessionStorage.removeItem(INVITE_KEY); } catch { /* sans stockage */ } }
};

// Lien admin (L59) : inscription.html?invitation=…#admin=…, gardé le temps de
// l'aller-retour vers Strava (ou vers la page de connexion, qui le lit aussi)
const ADMIN_KEY = 'versant_admin_code';
const adminStore = {
  get() { try { return sessionStorage.getItem(ADMIN_KEY) || ''; } catch { return ''; } },
  set(code) { try { sessionStorage.setItem(ADMIN_KEY, code); } catch { /* sans stockage */ } },
  clear() { try { sessionStorage.removeItem(ADMIN_KEY); } catch { /* sans stockage */ } }
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

  const adminCode = new URLSearchParams(window.location.hash.slice(1)).get('admin');
  if (adminCode) {
    adminStore.set(adminCode);
    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
  }
  if (adminStore.get()) await setupAdminNotice();

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
    // Ligue en préparation (L59) : on la rejoint déjà, elle démarre plus tard
    status.textContent = `✓ Ligue ${leagueName}${data.waiting ? ' (en préparation)' : ''}`;
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
// LIEN ADMIN (L59)
// ============================================
/** Devient admin de la ligue du lien admin. Renvoie la ligue ; lève l'erreur du serveur. */
async function claimAdmin(token) {
  const response = await fetch(`${API_BASE_URL}/leagues/claim-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ code: adminStore.get() })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Erreur ${response.status}`);
  adminStore.clear();
  return data.league;
}

/** Avis « lien admin » ; déjà connecté : bouton pour devenir admin sans s'inscrire. */
async function setupAdminNotice() {
  $('adminNotice').hidden = false;
  const token = localStorage.getItem('versant_token');
  if (!token) return;
  try {
    const response = await fetch(`${API_BASE_URL}/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return;
    const me = await response.json();
    $('adminNoticeName').textContent = me.athlete?.name || '';
    $('adminNoticeLogged').hidden = false;
    $('adminNoticeLogin').hidden = true;
    $('claimAdminBtn').addEventListener('click', async () => {
      $('claimAdminBtn').disabled = true;
      try {
        await claimAdmin(token);
        window.location.href = 'admin.html';
      } catch (error) {
        showError(error.message);
        $('claimAdminBtn').disabled = false;
      }
    });
  } catch {
    // hors ligne : l'avis reste, l'inscription aussi
  }
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

  $('sendEmailCodeBtn').addEventListener('click', sendEmailCode);
  // Adresse modifiée après l'envoi : le code reçu ne vaut que pour l'ancienne
  $('athleteEmail').addEventListener('input', () => {
    if (codeSentTo && $('athleteEmail').value.trim().toLowerCase() !== codeSentTo) {
      codeSentTo = null;
      $('emailCodeGroup').hidden = true;
      $('emailCode').value = '';
      clearInterval(resendTimer);
      $('sendEmailCodeBtn').textContent = 'Recevoir le code';
      $('sendEmailCodeBtn').disabled = false;
    }
  });
  $('emailCode').addEventListener('input', e => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
    if (digits !== e.target.value) e.target.value = digits;
  });
}

// ============================================
// ÉTAPE 3 : VALIDATION DE L'E-MAIL (L58)
// ============================================
let resendTimer = null;

async function sendEmailCode() {
  const email = $('athleteEmail').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('Format d\'e-mail invalide');
  const btn = $('sendEmailCodeBtn');
  const status = $('emailCodeStatus');
  btn.disabled = true;
  btn.textContent = 'Envoi…';
  try {
    const response = await fetch(`${API_BASE_URL}/auth/email-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'L\'e-mail n\'a pas pu être envoyé');
    codeSentTo = email.toLowerCase();
    $('emailCodeGroup').hidden = false;
    status.className = 'code-status ok';
    status.textContent = `Code envoyé à ${email}. Pense à regarder dans les spams.`;
    $('emailCode').focus();
    // Renvoi possible au bout d'une minute
    let left = 60;
    clearInterval(resendTimer);
    btn.textContent = `Renvoyer (${left} s)`;
    resendTimer = setInterval(() => {
      left -= 1;
      if (left > 0) { btn.textContent = `Renvoyer (${left} s)`; return; }
      clearInterval(resendTimer);
      btn.textContent = 'Renvoyer le code';
      btn.disabled = false;
    }, 1000);
  } catch (error) {
    showError(error.message);
    btn.textContent = codeSentTo ? 'Renvoyer le code' : 'Recevoir le code';
    btn.disabled = false;
  }
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
  if (codeSentTo !== athleteEmail.toLowerCase()) return showError('Clique sur « Recevoir le code » pour valider ton e-mail');
  const emailCode = $('emailCode').value.trim();
  if (!/^\d{6}$/.test(emailCode)) return showError('Entre le code à 6 chiffres reçu par e-mail');
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
        email_code: emailCode,
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

    // Lien admin (L59) : le nouveau compte devient admin de la ligue
    let adminOf = null;
    let adminError = null;
    if (adminStore.get()) {
      try {
        adminOf = await claimAdmin(result.token);
      } catch (e) {
        adminError = e.message;
      }
    }

    // Saison d'entrée : calculée sur le calendrier de versant-2026 (édition historique)
    showSuccess(joined?.edition?.legacyId ? result.active_from_season : null, { joined, joinError, adminOf, adminError });
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

function showSuccess(seasonNumber, { joined = null, joinError = null, adminOf = null, adminError = null } = {}) {
  $('signupCard').style.display = 'none';
  $('adminNotice').hidden = true;
  let html = '<h3>🎉 Inscription réussie !</h3><p>Ton compte Versant est créé et ton Strava est connecté.</p>';
  if (joined?.league) {
    html += `<p style="margin-top: 16px;">Tu fais maintenant partie de la ligue <strong>${escapeHtml(joined.league.name)}</strong>.</p>`;
    // Ligue en préparation (L59)
    if (joined.waiting && !adminOf) html += '<p style="margin-top: 8px;">Elle démarrera quand son admin aura fixé la date de début : tu y seras inscrit automatiquement.</p>';
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
  if (adminOf) {
    html += `<p style="margin-top: 16px;">Tu es l'admin de la ligue <strong>${escapeHtml(adminOf.name)}</strong> : choisis ses dates, lance sa première édition et partage son code d'invitation.</p>
      <p style="margin-top: 24px;">
        <a href="admin.html" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #f97316, #f43f5e); color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">Régler ma ligue</a>
      </p>`;
    const successDiv = $('successMessage');
    successDiv.innerHTML = html;
    successDiv.classList.add('active');
    successDiv.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  if (adminError) {
    html += `<p style="margin-top: 16px; color: #f87171;">Le lien admin n'a pas fonctionné : ${escapeHtml(adminError)}.</p>`;
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
