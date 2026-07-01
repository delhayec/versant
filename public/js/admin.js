const API_BASE = '/api';
const LEAGUE_ID = 'versant-2026';
let adminPassword = null;
let allActivities = [];
let athletesCache = {}; // Cache pour résoudre les noms d'athlètes

// ============================================
// AUTHENTIFICATION
// ============================================
function checkAuth() {
  const stored = localStorage.getItem('versant_admin_password');
  if (stored) {
    try {
      // Essayer de d\u00e9coder en base64 (nouveau format)
      adminPassword = atob(stored);
    } catch (e) {
      // Si \u00e7a plante, c'est l'ancien format (clair) - on migre
      adminPassword = stored;
      localStorage.setItem('versant_admin_password', btoa(stored));
    }
  } else {
    adminPassword = null;
  }

  if (adminPassword) {
    showDashboard();
  } else {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('loginSection').style.display = 'block';
  document.getElementById('adminDashboard').style.display = 'none';
}

// Charger les athlètes pour le dropdown reset password
async function loadAthletesForReset() {
  try {
    const response = await fetch(`${API_BASE}/athletes/${LEAGUE_ID}`);
    if (!response.ok) throw new Error('Erreur chargement');

    const athletes = await response.json();
    const select = document.getElementById('resetPasswordAthlete');

    if (!select) return;

    select.innerHTML = '<option value="">-- Choisir un athlète --</option>';
    athletes.forEach(athlete => {
      const option = document.createElement('option');
      option.value = athlete.id;
      option.textContent = `${athlete.name} (${athlete.email || 'pas d\'email'})`;
      select.appendChild(option);
    });

    console.log(`✅ ${athletes.length} athlètes chargés pour reset password`);
  } catch (error) {
    console.error('Erreur chargement athlètes pour reset:', error);
  }
}

function showDashboard() {
  document.getElementById('loginSection').style.display = 'none';
  document.getElementById('adminDashboard').style.display = 'block';
  loadDashboardData();
  checkWebhookStatus(); // Vérifier le statut du webhook
  loadAthletesForReset(); // Charger la liste pour le reset password
  loadSpecialRules(); // Charger les règles spéciales
}

// Fonction pour vérifier le statut du webhook
async function checkWebhookStatus() {
  const status = document.getElementById('webhookStatus');
  status.innerHTML = `Statut: <span style="color: #fbbf24;">⏳ Vérification...</span>`;

  try {
    const response = await fetch(`${API_BASE}/admin/strava/subscribe/status`, {
      headers: { 'X-Admin-Password': adminPassword }
    });

    const data = await response.json();

    if (response.ok) {
      if (data.active) {
        status.innerHTML = `Statut: <span style="color: #10b981;">✅ Actif</span> (ID: ${data.subscription?.id || 'N/A'})`;
        addLog(`📡 Webhook Strava actif (ID: ${data.subscription?.id})`);
      } else {
        status.innerHTML = `Statut: <span style="color: #ef4444;">❌ Inactif</span> - Cliquez sur Activer`;
      }
    } else {
      status.innerHTML = `Statut: <span style="color: #fbbf24;">⚠️ Erreur vérification</span>`;
    }
  } catch (error) {
    status.innerHTML = `Statut: <span style="color: #ef4444;">❌ Erreur réseau</span>`;
  }
}

document.getElementById('adminLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('adminPassword').value;

  try {
    const response = await fetch(`${API_BASE}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    if (!response.ok) {
      throw new Error('Mot de passe incorrect');
    }

adminPassword = password;
    // Stocker en base64 (obfuscation, pas s\u00e9curit\u00e9 forte) pour \u00e9viter
    // l'affichage en clair dans le devtools localStorage.
    localStorage.setItem('versant_admin_password', btoa(password));
    showDashboard();
    addLog('✅ Connexion admin réussie');

  } catch (error) {
    document.getElementById('loginError').textContent = error.message;
    document.getElementById('loginError').style.display = 'block';
  }
});

document.getElementById('logoutBtn').addEventListener('click', (e) => {
  e.preventDefault();
  localStorage.removeItem('versant_admin_password');
  adminPassword = null;
  showLogin();
});

// ============================================
// CHARGEMENT DES DONNÉES
// ============================================
async function loadDashboardData() {
  try {
    // Charger les athlètes
    const athletesRes = await fetch(`${API_BASE}/athletes/${LEAGUE_ID}`);
    const athletes = await athletesRes.json();

    // Créer le cache des athlètes (id -> objet complet)
    athletesCache = {};
    athletes.forEach(a => {
      athletesCache[a.id] = a;
    });

    // Charger les activités
    const activitiesRes = await fetch(`${API_BASE}/activities/${LEAGUE_ID}`);
    allActivities = await activitiesRes.json();

    // Compter les exclues
    const excludedCount = allActivities.filter(a => a.excluded).length;

    // Mettre à jour les stats
    document.getElementById('statAthletes').textContent = athletes.length;
    document.getElementById('statActivities').textContent = allActivities.length;
    document.getElementById('statExcluded').textContent = excludedCount;

    // Afficher les listes
    renderAthletesList(athletes);
    renderActivitiesList();

    // Charger les données des jokers
    loadJokersData();

    // Charger le statut des résultats figés
    loadFrozenStatus();

    // Définir les dates par défaut pour la sync
    const today = new Date();
    const weekAgo = new Date(today - 7 * 24 * 60 * 60 * 1000);
    document.getElementById('syncEndDate').value = today.toISOString().split('T')[0];
    document.getElementById('syncStartDate').value = weekAgo.toISOString().split('T')[0];

    addLog(`📊 Données chargées: ${athletes.length} athlètes, ${allActivities.length} activités (${excludedCount} exclues)`);

  } catch (error) {
    console.error('Erreur chargement:', error);
    addLog(`❌ Erreur: ${error.message}`);
  }
}

// Fonction pour obtenir le nom d'un athlète (pour les activités)
function getAthleteName(activity) {
  // Priorité: athlete_name dans l'activité, sinon chercher dans le cache
  if (activity.athlete_name) return activity.athlete_name;
  if (activity.athlete_id && athletesCache[activity.athlete_id]) {
    const a = athletesCache[activity.athlete_id];
    return a.name || `${a.firstname || ''} ${a.lastname || ''}`.trim() || `#${activity.athlete_id}`;
  }
  return 'Inconnu';
}

// Fonction pour obtenir le nom court d'un athlète par ID (pour les jokers)
function getAthleteShortName(id) {
  if (athletesCache[id]) {
    const a = athletesCache[id];
    if (a.firstname && a.lastname) {
      return `${a.firstname} ${a.lastname.charAt(0)}.`;
    }
    return a.name || `#${id}`;
  }
  return `#${id}`;
}

function renderAthletesList(athletes) {
  const container = document.getElementById('athletesList');

  if (athletes.length === 0) {
    container.innerHTML = '<p style="color: rgba(255,255,255,0.5);">Aucun athlète inscrit</p>';
    return;
  }

  container.innerHTML = `
    <table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">
          <th style="text-align: left; padding: 12px 8px; color: rgba(255,255,255,0.6); font-size: 13px;">Nom</th>
          <th style="text-align: left; padding: 12px 8px; color: rgba(255,255,255,0.6); font-size: 13px;">Email</th>
          <th style="text-align: left; padding: 12px 8px; color: rgba(255,255,255,0.6); font-size: 13px;">ID Strava</th>
          <th style="text-align: left; padding: 12px 8px; color: rgba(255,255,255,0.6); font-size: 13px;">Inscrit le</th>
        </tr>
      </thead>
      <tbody>
        ${athletes.map(a => `
          <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
            <td style="padding: 12px 8px; font-weight: 500;">${a.name}</td>
            <td style="padding: 12px 8px; color: rgba(255,255,255,0.7);">${a.email || '-'}</td>
            <td style="padding: 12px 8px; font-family: 'Space Mono', monospace; font-size: 13px;">${a.id}</td>
            <td style="padding: 12px 8px; color: rgba(255,255,255,0.6); font-size: 13px;">${new Date(a.registered_at).toLocaleDateString('fr-FR')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// ============================================
// GESTION DES ACTIVITÉS
// ============================================
function renderActivitiesList() {
  const container = document.getElementById('activitiesList');
  const search = document.getElementById('activitySearch').value.toLowerCase();
  const filter = document.getElementById('activityFilter').value;

  let filtered = allActivities;

  // Filtrer par recherche
  if (search) {
    filtered = filtered.filter(a =>
      a.name?.toLowerCase().includes(search) ||
      a.athlete_name?.toLowerCase().includes(search)
    );
  }

  // Filtrer par statut
  if (filter === 'active') {
    filtered = filtered.filter(a => !a.excluded);
  } else if (filter === 'excluded') {
    filtered = filtered.filter(a => a.excluded);
  }

  // Trier par date (plus récent en premier)
  filtered.sort((a, b) => new Date(b.start_date) - new Date(a.start_date));

  if (filtered.length === 0) {
    container.innerHTML = '<p style="color: rgba(255,255,255,0.5);">Aucune activité trouvée</p>';
    return;
  }

  container.innerHTML = `
    <table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">
          <th style="text-align: left; padding: 12px 8px; color: rgba(255,255,255,0.6); font-size: 13px;">Date</th>
          <th style="text-align: left; padding: 12px 8px; color: rgba(255,255,255,0.6); font-size: 13px;">Athlète</th>
          <th style="text-align: left; padding: 12px 8px; color: rgba(255,255,255,0.6); font-size: 13px;">Activité</th>
          <th style="text-align: right; padding: 12px 8px; color: rgba(255,255,255,0.6); font-size: 13px;">Distance</th>
          <th style="text-align: right; padding: 12px 8px; color: rgba(255,255,255,0.6); font-size: 13px;">D+</th>
          <th style="text-align: center; padding: 12px 8px; color: rgba(255,255,255,0.6); font-size: 13px;">Statut</th>
          <th style="text-align: center; padding: 12px 8px; color: rgba(255,255,255,0.6); font-size: 13px;">Action</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.slice(0, 100).map(a => `
          <tr style="border-bottom: 1px solid rgba(255,255,255,0.05); ${a.excluded ? 'opacity: 0.5;' : ''}">
            <td style="padding: 12px 8px; font-size: 13px;">${new Date(a.start_date).toLocaleDateString('fr-FR')}</td>
            <td style="padding: 12px 8px; font-weight: 500;">${getAthleteName(a)}</td>
            <td style="padding: 12px 8px; color: rgba(255,255,255,0.8);">
              <a href="https://www.strava.com/activities/${a.id}" target="_blank" style="color: #22d3ee; text-decoration: none;">
                ${a.name || 'Sans nom'}
              </a>
            </td>
            <td style="padding: 12px 8px; text-align: right; font-family: 'Space Mono', monospace;">${(a.distance / 1000).toFixed(2)} km</td>
            <td style="padding: 12px 8px; text-align: right; font-family: 'Space Mono', monospace;">+${Math.round(a.total_elevation_gain)} m</td>
            <td style="padding: 12px 8px; text-align: center;">
              ${a.excluded
                ? '<span style="color: #ef4444; font-size: 12px;">❌ Exclue</span>'
                : '<span style="color: #10b981; font-size: 12px;">✅ Active</span>'}
            </td>
            <td style="padding: 12px 8px; text-align: center;">
              <button onclick="toggleActivityExclusion(${a.id}, ${!a.excluded})" style="padding: 6px 12px; background: ${a.excluded ? '#10b981' : '#ef4444'}; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
                ${a.excluded ? '↩️ Réintégrer' : '🚫 Exclure'}
              </button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${filtered.length > 100 ? `<p style="color: rgba(255,255,255,0.5); padding: 12px; text-align: center;">Affichage limité à 100 activités sur ${filtered.length}</p>` : ''}
  `;
}

async function toggleActivityExclusion(activityId, exclude) {
  try {
    const response = await fetch(`${API_BASE}/admin/activities/${LEAGUE_ID}/${activityId}/exclude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Password': adminPassword
      },
      body: JSON.stringify({ exclude })
    });

    if (!response.ok) {
      throw new Error('Erreur lors de la modification');
    }

    const data = await response.json();

    // Mettre à jour localement
    const activity = allActivities.find(a => a.id === activityId);
    if (activity) {
      activity.excluded = exclude;
      activity.excluded_at = exclude ? new Date().toISOString() : null;
      activity.excluded_reason = exclude ? 'Exclu par admin' : null;
    }

    renderActivitiesList();

    // Mettre à jour le compteur
    const excludedCount = allActivities.filter(a => a.excluded).length;
    document.getElementById('statExcluded').textContent = excludedCount;

    addLog(`${exclude ? '🚫' : '↩️'} Activité ${activityId}: ${exclude ? 'exclue' : 'réintégrée'}`);

  } catch (error) {
    addLog(`❌ Erreur: ${error.message}`);
    alert('Erreur: ' + error.message);
  }
}

// Event listeners pour les filtres
document.getElementById('activitySearch').addEventListener('input', renderActivitiesList);
document.getElementById('activityFilter').addEventListener('change', renderActivitiesList);
document.getElementById('refreshActivitiesBtn').addEventListener('click', loadDashboardData);

// ============================================
// WEBHOOK STRAVA
// ============================================
document.getElementById('enableWebhookBtn').addEventListener('click', async () => {
  const btn = document.getElementById('enableWebhookBtn');
  const status = document.getElementById('webhookStatus');

  btn.disabled = true;
  btn.textContent = 'Activation...';

  try {
    const response = await fetch(`${API_BASE}/admin/strava/subscribe`, {
      method: 'POST',
      headers: { 'X-Admin-Password': adminPassword }
    });

    const data = await response.json();

    if (response.ok) {
      status.innerHTML = `Statut: <span style="color: #10b981;">✅ Actif</span> (ID: ${data.subscription?.id || 'existant'})`;
      addLog(`✅ Webhook Strava: ${data.message}`);
    } else {
      status.innerHTML = `Statut: <span style="color: #ef4444;">❌ ${data.error}</span>`;
      addLog(`❌ Webhook erreur: ${JSON.stringify(data.details || data.error)}`);
    }
  } catch (error) {
    status.innerHTML = `Statut: <span style="color: #ef4444;">❌ Erreur réseau</span>`;
    addLog(`❌ Erreur: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '✅ Activer';
  }
});

document.getElementById('disableWebhookBtn').addEventListener('click', async () => {
  if (!confirm('Désactiver le webhook ? Vous ne recevrez plus les activités en temps réel.')) return;

  const btn = document.getElementById('disableWebhookBtn');
  const status = document.getElementById('webhookStatus');

  btn.disabled = true;

  try {
    const response = await fetch(`${API_BASE}/admin/strava/subscribe`, {
      method: 'DELETE',
      headers: { 'X-Admin-Password': adminPassword }
    });

    const data = await response.json();
    status.innerHTML = `Statut: <span style="color: #fbbf24;">⚠️ Désactivé</span>`;
    addLog(`🗑️ Webhook désactivé`);
  } catch (error) {
    addLog(`❌ Erreur: ${error.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ============================================
// SYNCHRONISATION
// ============================================
document.getElementById('syncBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncBtn');
  const result = document.getElementById('syncResult');
  const startDate = document.getElementById('syncStartDate').value;
  const endDate = document.getElementById('syncEndDate').value;

  btn.disabled = true;
  btn.textContent = 'Synchronisation...';
  result.innerHTML = '<span style="color: #fbbf24;">⏳ En cours...</span>';

  try {
    const response = await fetch(`${API_BASE}/sync/${LEAGUE_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Password': adminPassword
      },
      body: JSON.stringify({ startDate, endDate })
    });

    const data = await response.json();

    if (!response.ok) throw new Error(data.error);

    // Afficher nouvelles + mises à jour
    const newCount = data.totalNew || 0;
    const updatedCount = data.totalUpdated || 0;

    let message = '';
    if (newCount > 0 && updatedCount > 0) {
      message = `✅ ${newCount} nouvelle(s) + ${updatedCount} mise(s) à jour`;
    } else if (newCount > 0) {
      message = `✅ ${newCount} nouvelle(s) activité(s)`;
    } else if (updatedCount > 0) {
      message = `🔄 ${updatedCount} activité(s) mise(s) à jour`;
    } else {
      message = `✓ Aucune modification`;
    }

    result.innerHTML = `<span style="color: #10b981;">${message}</span>`;
    addLog(`🔄 Sync: ${newCount} nouvelles, ${updatedCount} MAJ`);

    loadDashboardData();

  } catch (error) {
    result.innerHTML = `<span style="color: #ef4444;">❌ ${error.message}</span>`;
    addLog(`❌ Sync erreur: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Lancer la synchronisation';
  }
});

// ============================================
// EXPORT CLASSEMENT
// ============================================
document.getElementById('exportRankingBtn').addEventListener('click', async () => {
  const btn = document.getElementById('exportRankingBtn');
  btn.disabled = true;
  btn.textContent = 'Génération...';

  try {
    const response = await fetch(`${API_BASE}/admin/ranking/${LEAGUE_ID}/export`, {
      headers: { 'X-Admin-Password': adminPassword }
    });

    if (!response.ok) throw new Error('Erreur export');

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `classement-${LEAGUE_ID}-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    window.URL.revokeObjectURL(url);

    addLog(`📥 Classement exporté`);

  } catch (error) {
    addLog(`❌ Erreur export: ${error.message}`);
    alert('Erreur: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '📥 Télécharger le classement (JSON)';
  }
});

// ============================================
// TÉLÉCHARGEMENTS
// ============================================
document.querySelectorAll('.download-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const fileType = btn.dataset.file;

    try {
      let url, filename;

      if (fileType === 'athletes') {
        url = `${API_BASE}/admin/athletes/download`;
        filename = 'athletes.json';
      } else if (fileType === 'activities') {
        url = `${API_BASE}/admin/activities/${LEAGUE_ID}/download`;
        filename = `${LEAGUE_ID}_activities.json`;
      } else if (fileType === 'jokers') {
        url = `${API_BASE}/admin/jokers/download`;
        filename = 'jokers_usage.json';
      } else if (fileType === 'frozen') {
        url = `${API_BASE}/frozen-results`;
        filename = 'frozen_results.json';
      }

      const response = await fetch(url, {
        headers: { 'X-Admin-Password': adminPassword }
      });

      if (!response.ok) throw new Error('Erreur téléchargement');

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = filename;
      a.click();
      window.URL.revokeObjectURL(downloadUrl);

      addLog(`📥 ${filename} téléchargé`);

    } catch (error) {
      addLog(`❌ Erreur: ${error.message}`);
    }
  });
});

// ============================================
// LOGS
// ============================================
function addLog(message) {
  const container = document.getElementById('logsContainer');
  const time = new Date().toLocaleTimeString('fr-FR');
  const logEntry = document.createElement('div');
  logEntry.style.marginBottom = '8px';
  logEntry.innerHTML = `<span style="color: rgba(255,255,255,0.4);">[${time}]</span> ${message}`;

  if (container.children.length === 1 && container.children[0].textContent.includes('En attente')) {
    container.innerHTML = '';
  }

  container.insertBefore(logEntry, container.firstChild);
}

// ============================================
// GESTION DES JOKERS
// ============================================
let jokersData = {};

async function loadJokersData() {
  const container = document.getElementById('jokersManagement');
  try {
    const response = await fetch(`${API_BASE}/admin/jokers/${LEAGUE_ID}`, {
      headers: { 'X-Admin-Password': adminPassword }
    });

    if (!response.ok) throw new Error('Erreur chargement jokers');

    jokersData = await response.json();
    renderJokersManagement();
    addLog('🃏 Données jokers chargées');
  } catch (error) {
    container.innerHTML = `<p style="color: #ef4444;">❌ ${error.message}</p>`;
    addLog(`❌ Erreur jokers: ${error.message}`);
  }
}

function renderJokersManagement() {
  // Utiliser le nouveau conteneur si disponible, sinon l'ancien
  const container = document.getElementById('jokersManagementTable') || document.getElementById('jokersManagement');
  const { athletes, usage } = jokersData;

  if (!athletes || athletes.length === 0) {
    container.innerHTML = '<p style="color: rgba(255,255,255,0.5);">Aucun athlète trouvé</p>';
    return;
  }

  const jokerTypes = [
    { id: 'voleur', icon: '🦹', label: 'Voleur' },
    { id: 'multiplicateur', icon: '✖️', label: '×1.5' },
    { id: 'bouclier', icon: '🛡️', label: 'Bouclier' },
    { id: 'sabotage', icon: '💣', label: 'Sabotage' }
  ];

  let html = `
    <table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">
          <th style="text-align: left; padding: 12px; color: rgba(255,255,255,0.6);">Athlète</th>
          ${jokerTypes.map(j => `<th style="text-align: center; padding: 12px; color: rgba(255,255,255,0.6);">${j.icon} ${j.label}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
  `;

  athletes.forEach(athlete => {
    const stock = athlete.jokerStock || { voleur: 2, multiplicateur: 2, bouclier: 2, sabotage: 2 };
    const athleteName = athlete.name || `${athlete.firstname || ''} ${athlete.lastname || ''}`.trim();

    html += `
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);" data-athlete-id="${athlete.id}">
        <td style="padding: 12px;">
          <div style="font-weight: 600;">${athleteName}</div>
          <div style="font-size: 0.7rem; color: rgba(255,255,255,0.4);">ID: ${athlete.id}</div>
        </td>
        ${jokerTypes.map(j => `
          <td style="text-align: center; padding: 8px;">
            <div style="display: flex; align-items: center; justify-content: center; gap: 6px;">
              <button onclick="adjustJoker('${athlete.id}', '${j.id}', -1)"
                      style="width: 28px; height: 28px; background: rgba(239,68,68,0.2); color: #ef4444; border: 1px solid rgba(239,68,68,0.3); border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 16px; line-height: 1;">
                −
              </button>
              <span id="joker-${athlete.id}-${j.id}"
                    style="min-width: 24px; font-family: 'Space Mono', monospace; font-size: 1.1rem; font-weight: 600; color: ${(stock[j.id] || 0) > 0 ? '#22d3ee' : '#ef4444'};">
                ${stock[j.id] || 0}
              </span>
              <button onclick="adjustJoker('${athlete.id}', '${j.id}', 1)"
                      style="width: 28px; height: 28px; background: rgba(16,185,129,0.2); color: #10b981; border: 1px solid rgba(16,185,129,0.3); border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 16px; line-height: 1;">
                +
              </button>
            </div>
          </td>
        `).join('')}
      </tr>
    `;
  });

  html += '</tbody></table>';
  container.innerHTML = html;
}

function getJokerIcon(type) {
  const icons = { voleur: '🦹', multiplicateur: '✖️', bouclier: '🛡️', sabotage: '💣' };
  return icons[type] || '🃏';
}

function getJokerTargetName(id) {
  if (athletesCache[id]) {
    const a = athletesCache[id];
    if (a.firstname && a.lastname) {
      return `${a.firstname} ${a.lastname.charAt(0)}.`;
    }
    return a.name || `#${id}`;
  }
  return `#${id}`;
}

async function saveAthleteJokers(athleteId) {
  const row = document.querySelector(`tr[data-athlete-id="${athleteId}"]`);
  const inputs = row.querySelectorAll('.joker-input');

  const jokerStock = {};
  inputs.forEach(input => {
    jokerStock[input.dataset.type] = parseInt(input.value) || 0;
  });

  try {
    const response = await fetch(`${API_BASE}/admin/jokers/${athleteId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Password': adminPassword
      },
      body: JSON.stringify({ jokerStock })
    });

    if (!response.ok) throw new Error('Erreur sauvegarde');

    addLog(`✅ Jokers mis à jour pour athlète ${athleteId}`);

    // Flash vert pour confirmer
    row.style.background = 'rgba(16,185,129,0.1)';
    setTimeout(() => { row.style.background = ''; }, 1000);

  } catch (error) {
    addLog(`❌ Erreur: ${error.message}`);
    alert('Erreur: ' + error.message);
  }
}

// Ajuster un joker avec boutons +/-
async function adjustJoker(athleteId, jokerType, delta) {
  const spanId = `joker-${athleteId}-${jokerType}`;
  const span = document.getElementById(spanId);
  if (!span) return;

  const currentValue = parseInt(span.textContent) || 0;
  const newValue = Math.max(0, Math.min(5, currentValue + delta));

  if (newValue === currentValue) return;

  // Mise à jour visuelle immédiate
  span.textContent = newValue;
  span.style.color = newValue > 0 ? '#22d3ee' : '#ef4444';

  // Récupérer tous les jokers actuels de cet athlète
  const jokerStock = {
    voleur: parseInt(document.getElementById(`joker-${athleteId}-voleur`)?.textContent) || 0,
    multiplicateur: parseInt(document.getElementById(`joker-${athleteId}-multiplicateur`)?.textContent) || 0,
    bouclier: parseInt(document.getElementById(`joker-${athleteId}-bouclier`)?.textContent) || 0,
    sabotage: parseInt(document.getElementById(`joker-${athleteId}-sabotage`)?.textContent) || 0
  };

  try {
    const response = await fetch(`${API_BASE}/admin/jokers/${athleteId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Password': adminPassword
      },
      body: JSON.stringify({ jokerStock })
    });

    if (!response.ok) throw new Error('Erreur sauvegarde');

    addLog(`🃏 ${jokerType} ${delta > 0 ? '+1' : '-1'} pour athlète ${athleteId} (total: ${newValue})`);

    // Flash de confirmation
    span.style.transform = 'scale(1.3)';
    setTimeout(() => { span.style.transform = ''; }, 200);

  } catch (error) {
    // Annuler le changement visuel
    span.textContent = currentValue;
    span.style.color = currentValue > 0 ? '#22d3ee' : '#ef4444';
    addLog(`❌ Erreur: ${error.message}`);
  }
}

async function resetAllJokers() {
  if (!confirm('⚠️ Réinitialiser TOUS les jokers à 2 de chaque pour tous les athlètes ?\n\nCette action est irréversible.')) {
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/admin/jokers/reset/${LEAGUE_ID}`, {
      method: 'POST',
      headers: { 'X-Admin-Password': adminPassword }
    });

    if (!response.ok) throw new Error('Erreur reset');

    const data = await response.json();
    addLog(`🔄 ${data.count || 'Tous les'} athlètes réinitialisés (2 jokers de chaque)`);
    loadJokersData();

  } catch (error) {
    addLog(`❌ Erreur reset: ${error.message}`);
    alert('Erreur: ' + error.message);
  }
}

// Event listeners jokers
document.getElementById('refreshJokersBtn')?.addEventListener('click', loadJokersData);
document.getElementById('resetJokersBtn')?.addEventListener('click', resetAllJokers);
document.getElementById('resetAllJokersBtn')?.addEventListener('click', resetAllJokers);

// ============================================
// RÉSULTATS FIGÉS
// ============================================
async function loadFrozenStatus() {
  const statusDiv = document.getElementById('frozenStatus');
  try {
    const response = await fetch(`${API_BASE}/frozen-results`);
    const data = await response.json();

    const frozenRounds = Object.keys(data.rounds || {}).length;
    const roundsList = Object.keys(data.rounds || {}).sort((a, b) => parseInt(a) - parseInt(b)).join(', ');

    if (frozenRounds > 0) {
      statusDiv.innerHTML = `
        <div style="color: #22d3ee;">❄️ ${frozenRounds} round(s) figé(s)</div>
        <div style="font-size: 12px; color: rgba(255,255,255,0.5); margin-top: 4px;">Rounds: ${roundsList}</div>
      `;
    } else {
      statusDiv.innerHTML = `<span style="color: #fbbf24;">⚠️ Aucun round figé</span>`;
    }

    addLog(`❄️ ${frozenRounds} round(s) figé(s)`);
  } catch (error) {
    statusDiv.innerHTML = `<span style="color: #ef4444;">❌ Erreur chargement</span>`;
  }
}

async function autoFreezeRounds() {
  const btn = document.getElementById('autoFreezeBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Figement en cours...';

  try {
    const response = await fetch(`${API_BASE}/admin/auto-freeze`, {
      method: 'POST',
      headers: { 'X-Admin-Password': adminPassword }
    });

    if (!response.ok) throw new Error('Erreur auto-freeze');

    const data = await response.json();
    addLog(`❄️ Auto-freeze: ${data.frozenCount || 0} round(s) figé(s)`);

    if (data.frozenCount > 0) {
      alert(`✅ ${data.frozenCount} round(s) figé(s) avec succès !`);
    } else {
      alert('ℹ️ Aucun nouveau round à figer.');
    }

    loadFrozenStatus();
  } catch (error) {
    addLog(`❌ Erreur auto-freeze: ${error.message}`);
    alert('Erreur: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '❄️ Auto-figer tous les rounds terminés';
  }
}

async function freezeRound() {
  const roundNumber = parseInt(document.getElementById('freezeRoundNumber').value);
  if (!roundNumber || roundNumber < 1) {
    alert('Veuillez entrer un numéro de round valide');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/admin/freeze-round/${roundNumber}`, {
      method: 'POST',
      headers: { 'X-Admin-Password': adminPassword }
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Erreur');
    }

    const data = await response.json();
    addLog(`❄️ Round ${roundNumber} figé: ${data.eliminations?.length || 0} éliminé(s)`);
    alert(`✅ Round ${roundNumber} figé avec succès !`);
    loadFrozenStatus();
  } catch (error) {
    addLog(`❌ Erreur: ${error.message}`);
    alert('Erreur: ' + error.message);
  }
}

async function unfreezeRound() {
  const roundNumber = parseInt(document.getElementById('freezeRoundNumber').value);
  if (!roundNumber || roundNumber < 1) {
    alert('Veuillez entrer un numéro de round valide');
    return;
  }

  if (!confirm(`⚠️ Défiger le round ${roundNumber} ?\n\nCela permettra de recalculer ses résultats.`)) {
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/admin/unfreeze-round/${roundNumber}`, {
      method: 'POST',
      headers: { 'X-Admin-Password': adminPassword }
    });

    if (!response.ok) throw new Error('Erreur unfreeze');

    addLog(`🔓 Round ${roundNumber} défigé`);
    alert(`✅ Round ${roundNumber} défigé`);
    loadFrozenStatus();
  } catch (error) {
    addLog(`❌ Erreur: ${error.message}`);
    alert('Erreur: ' + error.message);
  }
}

async function resetAllFrozen() {
  if (!confirm('⚠️ ATTENTION !\n\nRéinitialiser TOUS les résultats figés ?\n\nCette action est IRRÉVERSIBLE et supprimera l\'historique de tous les rounds.')) {
    return;
  }

  if (!confirm('🚨 DERNIÈRE CONFIRMATION\n\nÊtes-vous VRAIMENT sûr ? Tous les résultats seront perdus.')) {
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/admin/reset-frozen`, {
      method: 'POST',
      headers: { 'X-Admin-Password': adminPassword }
    });

    if (!response.ok) throw new Error('Erreur reset');

    addLog(`🗑️ Tous les résultats figés supprimés`);
    alert('✅ Tous les résultats ont été réinitialisés');
    loadFrozenStatus();
  } catch (error) {
    addLog(`❌ Erreur: ${error.message}`);
    alert('Erreur: ' + error.message);
  }
}

// ============================================
// IMPORT FROZEN RESULTS (NOUVEAU)
// ============================================

document.getElementById('importFrozenBtn')?.addEventListener('click', () => {
  document.getElementById('importFrozenFile').click();
});

document.getElementById('importFrozenFile')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    // Valider le format
    if (!data.rounds || typeof data.rounds !== 'object') {
      alert('❌ Format invalide: le fichier doit contenir un objet "rounds"');
      return;
    }

    const roundCount = Object.keys(data.rounds).length;
    const mode = document.getElementById('importMode').value;
    const modeText = mode === 'merge' ? 'fusionner avec' : 'remplacer';

    if (!confirm(`📥 Importer ${roundCount} round(s) ?\n\nMode: ${modeText} les données existantes\n\nCette action va ${mode === 'replace' ? 'ÉCRASER toutes les données existantes' : 'ajouter les rounds manquants'}.`)) {
      return;
    }

    addLog(`📥 Import de ${roundCount} rounds en mode "${mode}"...`);

    const response = await fetch(`${API_BASE}/admin/import-frozen-results`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Password': adminPassword
      },
      body: JSON.stringify({
        data: data,
        merge: mode === 'merge'
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Erreur import');
    }

    const result = await response.json();

    addLog(`✅ Import réussi: ${result.imported} round(s) importé(s), ${result.skipped} ignoré(s)`);
    alert(`✅ Import réussi !\n\n• ${result.imported} round(s) importé(s)\n• ${result.skipped} round(s) ignoré(s) (déjà existants)\n• Total: ${result.totalRounds} round(s)`);

    loadFrozenStatus();

  } catch (error) {
    addLog(`❌ Erreur import: ${error.message}`);
    alert('❌ Erreur: ' + error.message);
  }

  // Reset le input file
  e.target.value = '';
});

// Event listeners frozen
document.getElementById('autoFreezeBtn')?.addEventListener('click', autoFreezeRounds);
document.getElementById('freezeRoundBtn')?.addEventListener('click', freezeRound);
document.getElementById('unfreezeRoundBtn')?.addEventListener('click', unfreezeRound);
document.getElementById('resetFrozenBtn')?.addEventListener('click', resetAllFrozen);

// ============================================
// RESET MOT DE PASSE
// ============================================

document.getElementById('resetPasswordBtn')?.addEventListener('click', async () => {
  const athleteId = document.getElementById('resetPasswordAthlete').value;
  const newPassword = document.getElementById('resetPasswordNew').value;
  const resultDiv = document.getElementById('resetPasswordResult');

  if (!athleteId) {
    resultDiv.innerHTML = '<span style="color: #ef4444;">❌ Veuillez sélectionner un athlète</span>';
    return;
  }

  if (!newPassword || newPassword.length < 6) {
    resultDiv.innerHTML = '<span style="color: #ef4444;">❌ Le mot de passe doit contenir au moins 6 caractères</span>';
    return;
  }

  const athleteName = document.getElementById('resetPasswordAthlete').selectedOptions[0].textContent;

  if (!confirm(`⚠️ Réinitialiser le mot de passe de ${athleteName} ?\n\nNouveau mot de passe: ${newPassword}`)) {
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/admin/reset-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Password': adminPassword
      },
      body: JSON.stringify({
        athleteId: athleteId,
        newPassword: newPassword
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Erreur serveur');
    }

    const data = await response.json();
    resultDiv.innerHTML = `<span style="color: #10b981;">✅ ${data.message}</span>`;
    addLog(`🔑 Mot de passe réinitialisé pour ${athleteName}`);

    // Clear le formulaire
    document.getElementById('resetPasswordNew').value = '';
    document.getElementById('resetPasswordAthlete').value = '';

  } catch (error) {
    resultDiv.innerHTML = `<span style="color: #ef4444;">❌ ${error.message}</span>`;
    addLog(`❌ Erreur reset password: ${error.message}`);
  }
});

// ============================================
// GESTION DES RÈGLES SPÉCIALES
// ============================================

const RULE_LABELS = {
  standard: 'Standard',
  handicap: 'Handicap',
  no_bonus: 'Sans bonus (D+ pur)'
};

async function loadSpecialRules() {
  const listDiv = document.getElementById('specialRulesList');
  if (!listDiv) return;

  try {
    const response = await fetch(`${API_BASE}/special-rules`);
    const rules = await response.json();

    const entries = Object.entries(rules);
    if (entries.length === 0) {
      listDiv.innerHTML = '<p style="color: rgba(255,255,255,0.5); margin: 0;">Aucune règle spéciale définie. Tous les rounds sont en mode Standard.</p>';
      return;
    }

    // Trier par numéro de round
    entries.sort((a, b) => Number(a[0]) - Number(b[0]));

    let html = '<div style="display: grid; gap: 8px;">';
    for (const [roundNum, rule] of entries) {
      const label = RULE_LABELS[rule] || rule;
      html += `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: rgba(255,255,255,0.05); border-radius: 8px; border-left: 3px solid #f97316;">
          <div>
            <span style="color: #f97316; font-weight: 600;">Round ${roundNum}</span>
            <span style="color: rgba(255,255,255,0.7); margin-left: 12px;">${label}</span>
          </div>
          <button onclick="removeSpecialRuleForRound('${roundNum}')" style="padding: 4px 10px; background: rgba(239,68,68,0.2); color: #ef4444; border: 1px solid rgba(239,68,68,0.3); border-radius: 4px; cursor: pointer; font-size: 12px;">✕</button>
        </div>
      `;
    }
    html += '</div>';
    listDiv.innerHTML = html;
  } catch (error) {
    listDiv.innerHTML = '<p style="color: #ef4444;">Erreur de chargement</p>';
  }
}

async function setSpecialRule(roundNumber, rule) {
  const resultDiv = document.getElementById('specialRulesResult');
  try {
    const response = await fetch(`${API_BASE}/admin/special-rules`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Password': adminPassword
      },
      body: JSON.stringify({ roundNumber, rule })
    });

    if (!response.ok) throw new Error('Erreur serveur');

    const data = await response.json();
    const label = RULE_LABELS[rule] || rule;
    resultDiv.innerHTML = `<span style="color: #10b981;">✅ Round ${roundNumber} → ${label}</span>`;
    addLog(`⚖️ Règle spéciale Round ${roundNumber} → ${label}`);
    await loadSpecialRules();
  } catch (error) {
    resultDiv.innerHTML = `<span style="color: #ef4444;">❌ ${error.message}</span>`;
  }
}

async function removeSpecialRuleForRound(roundNumber) {
  if (!confirm(`Supprimer la règle spéciale du Round ${roundNumber} ?`)) return;
  await setSpecialRule(roundNumber, 'standard');
}

// Expose pour le onclick inline
window.removeSpecialRuleForRound = removeSpecialRuleForRound;

// Boutons
document.getElementById('setSpecialRuleBtn')?.addEventListener('click', () => {
  const roundNum = document.getElementById('specialRuleRound')?.value;
  const rule = document.getElementById('specialRuleSelect')?.value;
  if (!roundNum) {
    document.getElementById('specialRulesResult').innerHTML = '<span style="color: #ef4444;">⚠️ Entrez un numéro de round</span>';
    return;
  }
  setSpecialRule(Number(roundNum), rule);
});

document.getElementById('removeSpecialRuleBtn')?.addEventListener('click', () => {
  const roundNum = document.getElementById('specialRuleRound')?.value;
  if (!roundNum) {
    document.getElementById('specialRulesResult').innerHTML = '<span style="color: #ef4444;">⚠️ Entrez un numéro de round</span>';
    return;
  }
  setSpecialRule(Number(roundNum), 'standard');
});
// ============================================
// VISUALISATEUR DE SAISON
// ============================================

const ROUND_TYPE_LABELS = {
  standard: 'Standard',
  finale: 'Finale',
  bonus_round: 'Round bonus',
  no_eliminations: 'Sans élimination'
};


async function loadSeasonVisualizer() {
  const container = document.getElementById('seasonVisualizerContent');
  if (!container) return;

  try {
    container.innerHTML = '<p style="color: rgba(255,255,255,0.5);">Chargement...</p>';

    // Charger les configs de rounds
    const configsRes = await fetch(`${API_BASE}/round-configs`);
    const configs = await configsRes.json();

    // Charger les frozen_results pour connaître l'état des rounds
    const frozenRes = await fetch(`${API_BASE}/frozen-results`);
    const frozenData = await frozenRes.json();

    // Charger les special-rules pour la pré-config
    const rulesRes = await fetch(`${API_BASE}/special-rules`);
    const specialRules = await rulesRes.json();

    // Déterminer la saison courante et ses rounds
    const seasonInfo = computeCurrentSeasonInfo(frozenData, configs);
    if (!seasonInfo) {
      container.innerHTML = '<p style="color: #ef4444;">Impossible de déterminer la saison en cours</p>';
      return;
    }

    const { seasonNumber, startRound, endRound } = seasonInfo;

    // Construire le tableau
    let html = `
      <p style="color: rgba(255,255,255,0.6); font-size: 13px; margin-bottom: 12px;">
        Saison ${seasonNumber} — Rounds R${startRound} à R${endRound}
      </p>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="border-bottom: 2px solid rgba(255,255,255,0.15);">
            <th style="text-align: left; padding: 10px 8px; color: rgba(255,255,255,0.6);">Round</th>
            <th style="text-align: left; padding: 10px 8px; color: rgba(255,255,255,0.6);">Dates</th>
            <th style="text-align: center; padding: 10px 8px; color: rgba(255,255,255,0.6);">Statut</th>
            <th style="text-align: center; padding: 10px 8px; color: rgba(255,255,255,0.6);">Actifs<br>début</th>
            <th style="text-align: center; padding: 10px 8px; color: rgba(255,255,255,0.6);">Nb élim</th>
            <th style="text-align: left; padding: 10px 8px; color: rgba(255,255,255,0.6);">Type</th>
            <th style="text-align: left; padding: 10px 8px; color: rgba(255,255,255,0.6);">Règle spéciale</th>
            <th style="text-align: center; padding: 10px 8px; color: rgba(255,255,255,0.6);">Actions</th>
          </tr>
        </thead>
        <tbody>
    `;

    let activesBeforeRound = 15;

    for (let r = startRound; r <= endRound; r++) {
      const frozenRound = frozenData.rounds?.[String(r)];
      const config = configs[String(r)] || {};
      const isFrozen = !!frozenRound?.frozen;
      const elimCount = isFrozen ? (frozenRound.eliminations?.length || 0) : null;

      const today = new Date();
      const roundStart = frozenRound?.dates?.start ? new Date(frozenRound.dates.start) : null;
      const roundEnd = frozenRound?.dates?.end ? new Date(frozenRound.dates.end) : null;
      const isOngoing = roundStart && roundEnd && today >= roundStart && today <= roundEnd;
      const isToCome = roundStart && today < roundStart;

      let statusHtml;
      if (isFrozen) {
        statusHtml = '<span style="color: #10b981;">❄️ Figé</span>';
      } else if (isOngoing) {
        statusHtml = '<span style="color: #fbbf24;">⏳ En cours</span>';
      } else if (isToCome) {
        statusHtml = '<span style="color: rgba(255,255,255,0.5);">📅 À venir</span>';
      } else {
        statusHtml = '<span style="color: rgba(255,255,255,0.5);">—</span>';
      }

      const datesHtml = roundStart && roundEnd
        ? `${roundStart.toLocaleDateString('fr-FR')} → ${roundEnd.toLocaleDateString('fr-FR')}`
        : '—';

      // Champs éditables uniquement si pas figé
      const nbElimInput = isFrozen
        ? `<span style="color: rgba(255,255,255,0.7);">${elimCount}</span>`
        : `<input type="number" id="config-nbElim-${r}" min="0" max="15" value="${config.nbEliminations ?? 2}" style="width: 60px; padding: 4px 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; text-align: center;">`;

      const currentType = config.type || 'standard';
      const typeSelect = isFrozen
        ? `<span style="color: rgba(255,255,255,0.7);">${ROUND_TYPE_LABELS[frozenRound.isFinalePrincipale ? 'finale' : 'standard'] || 'standard'}</span>`
        : `<select id="config-type-${r}" style="padding: 4px 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white;">
            ${Object.entries(ROUND_TYPE_LABELS).map(([val, label]) =>
              `<option value="${val}" ${currentType === val ? 'selected' : ''}>${label}</option>`
            ).join('')}
          </select>`;

      const currentRule = config.specialRule || specialRules[String(r)] || 'standard';
      const ruleSelect = isFrozen
        ? '—'
        : `<select id="config-rule-${r}" style="padding: 4px 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white;">
            ${Object.entries(RULE_LABELS).map(([val, label]) =>
              `<option value="${val}" ${currentRule === val ? 'selected' : ''}>${label}</option>`
            ).join('')}
          </select>`;

      const actionsHtml = isFrozen
        ? '<span style="color: rgba(255,255,255,0.4); font-size: 11px;">verrouillé</span>'
        : `<button onclick="saveRoundConfigFromUI(${r})" style="padding: 6px 10px; background: #22d3ee; color: #0a0a0f; border: none; border-radius: 4px; font-size: 12px; font-weight: 600; cursor: pointer;">💾</button>
           ${configs[String(r)] ? `<button onclick="deleteRoundConfigFromUI(${r})" style="margin-left: 4px; padding: 6px 10px; background: rgba(239,68,68,0.2); color: #ef4444; border: 1px solid rgba(239,68,68,0.3); border-radius: 4px; font-size: 12px; cursor: pointer;">✕</button>` : ''}`;

      html += `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05); ${isFrozen ? 'opacity: 0.7;' : ''}">
          <td style="padding: 10px 8px; font-weight: 600;">R${r}</td>
          <td style="padding: 10px 8px; font-size: 12px;">${datesHtml}</td>
          <td style="padding: 10px 8px; text-align: center;">${statusHtml}</td>
          <td style="padding: 10px 8px; text-align: center; font-family: 'Space Mono', monospace;">${activesBeforeRound}</td>
          <td style="padding: 10px 8px; text-align: center;">${nbElimInput}</td>
          <td style="padding: 10px 8px;">${typeSelect}</td>
          <td style="padding: 10px 8px;">${ruleSelect}</td>
          <td style="padding: 10px 8px; text-align: center;">${actionsHtml}</td>
        </tr>
      `;

      // Mettre à jour le nombre d'actifs pour le round suivant
      if (isFrozen) {
        activesBeforeRound -= elimCount;
      } else {
        const projectedElim = config.nbEliminations ?? 2;
        activesBeforeRound -= projectedElim;
      }
    }

    html += '</tbody></table>';
    container.innerHTML = html;

  } catch (error) {
    console.error('Erreur loadSeasonVisualizer:', error);
    container.innerHTML = `<p style="color: #ef4444;">❌ ${error.message}</p>`;
    addLog(`❌ Erreur visualisateur: ${error.message}`);
  }
}

function computeCurrentSeasonInfo(frozenData, configs = {}) {
  if (!frozenData?.rounds) return null;

  const rounds = Object.entries(frozenData.rounds)
    .map(([key, r]) => ({ roundNumber: parseInt(key), ...r }))
    .filter(r => r.frozen)
    .sort((a, b) => a.roundNumber - b.roundNumber);

  if (rounds.length === 0) return null;

  const lastRound = rounds[rounds.length - 1];
  const currentSeasonNumber = lastRound.seasonNumber || 1;

  // Trouver le premier round de cette saison
  const seasonRounds = rounds.filter(r => (r.seasonNumber || 1) === currentSeasonNumber);
  const startRound = seasonRounds[0].roundNumber;

  // Déterminer endRound :
  // 1. Si un round est configuré comme 'finale' (via round_configs.json), c'est lui qui ferme la saison
  // 2. Sinon, on extrapole "7 rounds par défaut" depuis startRound
  let endRound = null;
  for (let r = startRound; r <= startRound + 15; r++) {
    if (configs[String(r)]?.type === 'finale') {
      endRound = r;
      break;
    }
  }
  if (endRound === null) {
    endRound = startRound + 6; // Fallback : estimation 7 rounds
  }

  return {
    seasonNumber: currentSeasonNumber,
    startRound,
    endRound
  };
}

async function saveRoundConfigFromUI(roundNumber) {
  const nbElim = parseInt(document.getElementById(`config-nbElim-${roundNumber}`)?.value);
  const type = document.getElementById(`config-type-${roundNumber}`)?.value;
  const specialRule = document.getElementById(`config-rule-${roundNumber}`)?.value;

  if (isNaN(nbElim) || nbElim < 0) {
    alert('Nombre d\'éliminations invalide');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/admin/round-configs/${roundNumber}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Password': adminPassword
      },
      body: JSON.stringify({
        nbEliminations: nbElim,
        type: type || 'standard',
        specialRule: specialRule || 'standard'
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Erreur sauvegarde');
    }

    addLog(`💾 Config R${roundNumber} sauvegardée (nbElim=${nbElim}, type=${type})`);
    loadSeasonVisualizer();
  } catch (error) {
    addLog(`❌ Erreur sauvegarde config: ${error.message}`);
    alert('Erreur: ' + error.message);
  }
}

async function deleteRoundConfigFromUI(roundNumber) {
  if (!confirm(`Supprimer la config personnalisée du R${roundNumber} ?`)) return;

  try {
    const response = await fetch(`${API_BASE}/admin/round-configs/${roundNumber}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Password': adminPassword }
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Erreur suppression');
    }

    addLog(`🗑️ Config R${roundNumber} supprimée`);
    loadSeasonVisualizer();
  } catch (error) {
    addLog(`❌ Erreur suppression: ${error.message}`);
  }
}

// Expose pour onclick inline
window.saveRoundConfigFromUI = saveRoundConfigFromUI;
window.deleteRoundConfigFromUI = deleteRoundConfigFromUI;

// Bouton refresh
document.getElementById('refreshSeasonVisualizerBtn')?.addEventListener('click', loadSeasonVisualizer);

// Charger au démarrage du dashboard admin
const originalShowDashboard = showDashboard;
showDashboard = function() {
  originalShowDashboard();
  setTimeout(loadSeasonVisualizer, 500); // Petit délai pour s'assurer que les autres données sont chargées
};




// ============================================
// INIT
// ============================================
checkAuth();