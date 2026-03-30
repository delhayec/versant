/**
 * ============================================
 * VERSANT - FONCTIONS DE RENDU UI
 * ============================================
 * Toutes les fonctions qui génèrent du HTML.
 * AUCUNE logique métier ici.
 */

import { 
  CHALLENGE_CONFIG, JOKER_TYPES, BONUS_TYPES, ROUND_RULES, PARTICIPANTS,
  getSeasonDates, getRoundDates, getRoundInSeason, getParticipantById,
  getAthleteColor, getAthleteInitials, getRoundInfo
} from './config.js';

import { getJokerStock, getJokerStatusForRound, getActiveJokersForRound, getPendingJokersForNextRound } from './jokers.js';

// ============================================
// UTILITAIRES DE FORMATAGE
// ============================================

export function formatDate(date, opts = {}) {
  return new Date(date).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...opts
  });
}

export function formatDateShort(date) {
  return formatDate(date, { month: 'short', year: undefined });
}

export function formatElevation(value, showUnit = true) {
  const rounded = Math.round(value);
  const formatted = rounded.toLocaleString('fr-FR');
  return showUnit ? `${formatted} m` : formatted;
}

export function formatPosition(pos) {
  return `${pos}${pos === 1 ? 'er' : 'e'}`;
}

export function formatDateRange(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  if (s.getMonth() === e.getMonth()) {
    return `${s.getDate()} - ${formatDate(e, { day: 'numeric', month: 'long', year: undefined })}`;
  }
  return `${formatDateShort(s)} - ${formatDateShort(e)}`;
}

// ============================================
// RENDU DU BANNER SAISON/ROUND
// ============================================

export function renderCombinedBanner(container, data) {
  const { currentSeasonNumber, currentRoundNumber, seasonData, currentDate } = data;

  const seasonDates = getSeasonDates(currentSeasonNumber);
  const roundDates = getRoundDates(currentRoundNumber);
  const roundInSeason = getRoundInSeason(currentDate);

  const isRoundActive = currentDate >= roundDates.start && currentDate <= roundDates.end;

  // Calcul du jour actuel dans le round (1 à 5)
  const msPerDay = 24 * 60 * 60 * 1000;
  const dayInRound = Math.min(5, Math.max(1, Math.floor((currentDate - roundDates.start) / msPerDay) + 1));

  // Calcul du temps restant pour le countdown
  const timeRemaining = roundDates.end.getTime() - currentDate.getTime();
  const days = Math.floor(timeRemaining / (1000 * 60 * 60 * 24));
  const hours = Math.floor((timeRemaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((timeRemaining % (1000 * 60)) / 1000);

  // Formater avec zéros devant
  const pad = (n) => String(n).padStart(2, '0');

  container.innerHTML = `
    <div class="banner-unified">
      <div class="banner-block banner-season-block">
        <span class="banner-label">SAISON</span>
        <span class="banner-value">${currentSeasonNumber}</span>
      </div>

      <div class="banner-separator"></div>

      <div class="banner-block banner-round-block">
        <span class="banner-label">ROUND</span>
        <span class="banner-value">${roundInSeason}</span>
        ${isRoundActive ? `<span class="banner-day">J${dayInRound}/5</span>` : ''}
      </div>

      <div class="banner-separator"></div>

      <div class="banner-block banner-stats-block">
        <div class="banner-stat">
          <span class="banner-stat-value">${seasonData?.active?.length || 0}</span>
          <span class="banner-stat-label">en course</span>
        </div>
        <div class="banner-stat">
          <span class="banner-stat-value">${seasonData?.eliminated?.length || 0}</span>
          <span class="banner-stat-label">éliminés</span>
        </div>
      </div>

      ${isRoundActive && timeRemaining > 0 ? `
        <div class="banner-separator"></div>

        <div class="banner-block banner-countdown-block">
          <span class="banner-label">FIN DU ROUND</span>
          <div class="banner-countdown-timer" id="countdownTimer" data-end="${roundDates.end.getTime()}">
            <span class="countdown-unit"><span class="countdown-num">${pad(days)}</span>j</span>
            <span class="countdown-unit"><span class="countdown-num">${pad(hours)}</span>h</span>
            <span class="countdown-unit"><span class="countdown-num">${pad(minutes)}</span>m</span>
            <span class="countdown-unit"><span class="countdown-num">${pad(seconds)}</span>s</span>
          </div>
        </div>
      ` : ''}
    </div>
  `;

  // Démarrer le countdown en temps réel si le round est actif
  if (isRoundActive && timeRemaining > 0) {
    startCountdownTimer(roundDates.end.getTime());
  }
}

// Timer pour mise à jour en temps réel du countdown
let countdownInterval = null;

function startCountdownTimer(endTime) {
  // Arrêter l'ancien timer s'il existe
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }

  countdownInterval = setInterval(() => {
    const timerElement = document.getElementById('countdownTimer');
    if (!timerElement) {
      clearInterval(countdownInterval);
      return;
    }

    const now = Date.now();
    const timeRemaining = endTime - now;

    if (timeRemaining <= 0) {
      timerElement.innerHTML = `
        <span class="countdown-unit"><span class="countdown-num">00</span>j</span>
        <span class="countdown-unit"><span class="countdown-num">00</span>h</span>
        <span class="countdown-unit"><span class="countdown-num">00</span>m</span>
        <span class="countdown-unit"><span class="countdown-num">00</span>s</span>
      `;
      timerElement.classList.add('countdown-ended');
      clearInterval(countdownInterval);
      return;
    }

    const days = Math.floor(timeRemaining / (1000 * 60 * 60 * 24));
    const hours = Math.floor((timeRemaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((timeRemaining % (1000 * 60)) / 1000);

    const pad = (n) => String(n).padStart(2, '0');
    timerElement.innerHTML = `
      <span class="countdown-unit"><span class="countdown-num">${pad(days)}</span>j</span>
      <span class="countdown-unit"><span class="countdown-num">${pad(hours)}</span>h</span>
      <span class="countdown-unit"><span class="countdown-num">${pad(minutes)}</span>m</span>
      <span class="countdown-unit"><span class="countdown-num">${pad(seconds)}</span>s</span>
    `;
  }, 1000);
}

// ============================================
// RENDU DES JOKERS ACTIFS
// ============================================

export function renderActiveJokersSection(container, data) {
  const { currentRoundNumber, ranking } = data;

  const activeJokers = getActiveJokersForRound(currentRoundNumber);
  const pendingJokers = getPendingJokersForNextRound(currentRoundNumber);

  if (activeJokers.length === 0 && pendingJokers.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';

  let html = '<h3 class="section-title">🃏 Jokers en jeu ce round</h3><div class="jokers-grid">';

  activeJokers.forEach(joker => {
    const jokerType = JOKER_TYPES[joker.jokerId];
    if (!jokerType) return;

    let statusHtml = '';
    let statusClass = 'active';

    if (joker.jokerId === 'voleur') {
      statusHtml = `<div class="joker-effect">🦹 ${joker.participantName} vole la meilleure activité de ${joker.targetName}</div>`;
    } else if (joker.jokerId === 'multiplicateur') {
      statusHtml = `<div class="joker-effect">×1.5 sur tout le D+ de ${joker.participantName}</div>`;
    } else if (joker.jokerId === 'sabotage') {
      statusHtml = `<div class="joker-effect">-30% du D+ de ${joker.targetName}</div>`;
    } else if (joker.jokerId === 'bouclier') {
      statusHtml = `<div class="joker-effect">${joker.participantName} est protégé contre l'élimination</div>`;
    }

    html += `
      <div class="joker-card ${statusClass}">
        <div class="joker-card-header">
          <span class="joker-card-icon">${jokerType.icon}</span>
          <span class="joker-card-name">${jokerType.name}</span>
          <span class="joker-card-user">par ${joker.participantName}</span>
        </div>
        <div class="joker-card-body">${statusHtml}</div>
      </div>
    `;
  });

  // Jokers programmés pour le prochain round
  if (pendingJokers.length > 0) {
    const nextRound = getRoundInSeason(new Date()) + 1;
    html += `<div class="pending-jokers"><h4>⏰ Programmés pour le Round ${nextRound}</h4><div class="pending-list">`;

    pendingJokers.forEach(joker => {
      const jokerType = JOKER_TYPES[joker.jokerId];
      if (!jokerType) return;
      html += `<span class="pending-item">${jokerType.icon} ${joker.participantName}${joker.targetName ? ' → ' + joker.targetName : ''}</span>`;
    });

    html += '</div></div>';
  }

  html += '</div>';
  container.innerHTML = html;
}

// ============================================
// RENDU DU CLASSEMENT
// ============================================

export function renderRanking(container, data) {
  const { ranking, seasonData, currentSeasonNumber, seasonStats, eliminationsCount, rescapeId, ephemeralEffects } = data;

  if (seasonData?.seasonComplete) {
    container.innerHTML = `
      <div class="empty-state">
        <p>🏆 Saison terminée ! Champion : ${seasonData.winner?.name || 'N/A'}</p>
      </div>
    `;
    return;
  }

  if (!ranking || ranking.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>Aucune donnée disponible</p></div>';
    return;
  }

  let html = `
    <div class="ranking-header">
      <div>Pos.</div>
      <div>Athlète</div>
      <div>D+ Round</div>
      <div>D+ Saison</div>
      <div>Jokers</div>
    </div>
  `;

  ranking.forEach((entry, i) => {
    const posClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const rowClass = entry.isInDangerZone ? 'danger-zone' : (entry.isProtected ? 'protected' : '');
    const seasonElev = seasonStats?.[entry.participant.id]?.elevation || 0;
    const effects = entry.jokerEffects || { bonuses: {} };

    // Vérifier si c'est le Rescapé (basé sur le round précédent figé)
    const isRescape = rescapeId && String(entry.participant.id) === String(rescapeId);

    // Générer les indicateurs de bonus sur l'avatar (jokers + bonus éphémères)
    const ephemeral = ephemeralEffects?.[entry.participant.id];
    const bonusIndicators = renderAvatarBonusIndicators(effects.bonuses, ephemeral);

    // Générer les pilules pour les effets de bonus éphémères
    const ephemeralPills = renderEphemeralBonusPills(ephemeral);

    html += `
      <div class="ranking-row ${rowClass}" data-participant-id="${entry.participant.id}">
        <div class="position ${posClass}">
          ${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : entry.position}
        </div>
        <div class="athlete-info">
          <div class="athlete-avatar-wrapper">
            <div class="athlete-avatar" style="background: ${getAthleteColor(entry.participant.id)}">
              ${getAthleteInitials(entry.participant.id)}
            </div>
            ${bonusIndicators}
          </div>
          <div class="athlete-details">
            <span class="athlete-name">${entry.participant.name}</span>
            ${isRescape ? '<span class="athlete-status rescape" title="Rescapé du round précédent - Juste au-dessus de la zone d\'élimination">🎫 Rescapé</span>' : ''}
            ${entry.isInDangerZone ? '<span class="athlete-status danger">⚠️ Zone danger</span>' : ''}
            ${entry.isProtected ? '<span class="athlete-status protected">🛡️ Protégé</span>' : ''}
          </div>
        </div>
        <div class="elevation-cell">
          ${renderElevationWithBonuses(entry.totalElevation, effects.bonuses)}
          ${ephemeralPills}
        </div>
        <div class="elevation-secondary">${formatElevation(seasonElev)}</div>
        <div class="jokers-cell">
          ${renderJokerBadges(entry.participant.id, data.currentRoundNumber)}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// ============================================
// RENDU DES INDICATEURS DE BONUS SUR AVATAR
// ============================================

function renderAvatarBonusIndicators(bonuses = {}, ephemeral = null) {
  const indicators = [];

  // Multiplicateur (×1.5)
  if (bonuses.multiplier) {
    indicators.push({ icon: '✨', class: 'multiplier', title: 'Multiplicateur ×1.5' });
  }

  // Bouclier
  if (bonuses.shield) {
    indicators.push({ icon: '🛡️', class: 'shield', title: 'Bouclier actif' });
  }

  // Duel gagné
  if (bonuses.duelWon) {
    indicators.push({ icon: '⚔️', class: 'duel-won', title: 'Duel gagné' });
  }

  // Duel perdu
  if (bonuses.duelLost) {
    indicators.push({ icon: '⚔️', class: 'duel-lost', title: 'Duel perdu' });
  }

  // Saboté (victime)
  if (bonuses.sabotaged) {
    indicators.push({ icon: '💣', class: 'sabotaged', title: 'Saboté' });
  }

  // Sabotage appliqué (celui qui sabote)
  if (bonuses.sabotageApplied) {
    indicators.push({ icon: '💣', class: 'saboteur', title: 'Sabotage actif' });
  }

  // Voleur actif
  if (bonuses.thief) {
    indicators.push({ icon: '🦹', class: 'thief', title: 'Vol actif' });
  }

  // Victime du vol
  if (bonuses.stolen) {
    indicators.push({ icon: '🦹', class: 'stolen', title: 'Activité volée' });
  }

  // Kamikaze (celui qui l'active)
  if (bonuses.kamikaze) {
    indicators.push({ icon: '💣', class: 'kamikaze', title: 'Kamikaze - perd 25% de son D+' });
  }

  // Victime de Kamikaze
  if (bonuses.kamikazeTarget) {
    indicators.push({ icon: '💥', class: 'kamikaze-target', title: `Kamikaze par ${bonuses.kamikazeTarget.by}` });
  }

  // Maudit (victime de malédiction)
  if (bonuses.cursed) {
    indicators.push({ icon: '🪬', class: 'cursed', title: `Maudit par ${bonuses.cursed.by}` });
  }

  // Bonus éphémères (basés sur les détails)
  if (ephemeral?.details) {
    for (const detail of ephemeral.details) {
      if (detail.type === 'embuscade_victim') {
        indicators.push({ icon: '🏹', class: 'ephemeral-victim', title: `Embuscade par ${detail.by}` });
      } else if (detail.type === 'embuscade_gain') {
        indicators.push({ icon: '🏹', class: 'ephemeral-gain', title: `A volé ${detail.from}` });
      } else if (detail.type === 'ravitaillement') {
        indicators.push({ icon: '🍖', class: 'ephemeral-gain', title: `Ravitaillement de ${detail.from}` });
      } else if (detail.type === 'marquage') {
        indicators.push({ icon: '🎯', class: 'ephemeral-victim', title: `Marqué par ${detail.by}` });
      } else if (detail.type === 'malediction_victim') {
        indicators.push({ icon: '🪬', class: 'ephemeral-victim', title: `Maudit par ${detail.by}` });
      }
    }
  }

  if (indicators.length === 0) return '';

  return `
    <div class="avatar-bonus-indicators">
      ${indicators.map(ind => `
        <span class="avatar-bonus-icon ${ind.class}" title="${ind.title}">${ind.icon}</span>
      `).join('')}
    </div>
  `;
}

/**
 * Génère les pilules pour les effets de bonus éphémères
 */
function renderEphemeralBonusPills(ephemeral) {
  if (!ephemeral || (!ephemeral.gained && !ephemeral.lost)) return '';

  const pills = [];

  for (const detail of ephemeral.details || []) {
    const amount = detail.amount || 0;
    if (amount === 0) continue;

    switch (detail.type) {
      case 'embuscade_victim':
        pills.push(`<span class="bonus-tag ephemeral-stolen">${detail.icon} -${formatElevation(amount, false)} m volés</span>`);
        break;
      case 'embuscade_gain':
        pills.push(`<span class="bonus-tag ephemeral-gained">${detail.icon} +${formatElevation(amount, false)} m volés</span>`);
        break;
      case 'ravitaillement':
        pills.push(`<span class="bonus-tag ephemeral-bonus">${detail.icon} +${formatElevation(amount, false)} m</span>`);
        break;
      case 'marquage':
        pills.push(`<span class="bonus-tag ephemeral-mark">${detail.icon} -${formatElevation(amount, false)} m</span>`);
        break;
      case 'malediction_victim':
        pills.push(`<span class="bonus-tag ephemeral-curse">${detail.icon} -${formatElevation(amount, false)} m</span>`);
        break;
      case 'malediction_gain':
        pills.push(`<span class="bonus-tag ephemeral-gained">${detail.icon} +${formatElevation(amount, false)} m</span>`);
        break;
      case 'kamikaze_victim':
      case 'kamikaze_self':
        pills.push(`<span class="bonus-tag ephemeral-stolen">${detail.icon} -${formatElevation(amount, false)} m</span>`);
        break;
    }
  }

  if (pills.length === 0) return '';
  return `<div class="elevation-bonuses">${pills.join('')}</div>`;
}

// ============================================
// RENDU DES BADGES JOKERS
// ============================================

function renderJokerBadges(participantId, currentRoundNumber) {
  const status = getJokerStatusForRound(participantId, currentRoundNumber);
  const stock = status.stock;

  let html = '';

  Object.entries(JOKER_TYPES).forEach(([jokerId, jokerType]) => {
    const count = stock[jokerId] || 0;
    const isActive = status.active.some(j => j.jokerId === jokerId);
    const isPending = status.pending.some(j => j.jokerId === jokerId);

    let badgeClass = 'available';
    if (isActive) badgeClass = 'active';
    else if (isPending) badgeClass = 'pending';

    if (count > 0 || isActive || isPending) {
      html += `
        <span class="joker-badge ${badgeClass}" title="${jokerType.name}: ${count} restant(s)">
          ${jokerType.icon}${count > 0 ? `<sub>${count}</sub>` : ''}
        </span>
      `;
    }
  });

  return html || '<span class="no-jokers">-</span>';
}

// ============================================
// RENDU DU D+ AVEC BONUS
// ============================================

function renderElevationWithBonuses(totalElevation, bonuses = {}, ephemeralBonus = null) {
  let html = `<span class="elevation-primary">${formatElevation(totalElevation)}</span>`;

  const tags = [];

  // Jokers classiques
  if (bonuses.multiplier) {
    tags.push(`<span class="bonus-tag multiplier">×1.5 +${formatElevation(bonuses.multiplier.amount, false)} m</span>`);
  }
  if (bonuses.duelWon) {
    tags.push(`<span class="bonus-tag duel-won">⚔️ +${formatElevation(bonuses.duelWon.amount, false)} m</span>`);
  }
  if (bonuses.duelLost) {
    tags.push(`<span class="bonus-tag duel-lost">⚔️ -${formatElevation(bonuses.duelLost.amount, false)} m</span>`);
  }
  if (bonuses.sabotaged) {
    tags.push(`<span class="bonus-tag sabotage">💣 -${formatElevation(bonuses.sabotaged.amount, false)} m</span>`);
  }
  if (bonuses.sabotageApplied) {
    tags.push(`<span class="bonus-tag sabotage-done">💣 → ${bonuses.sabotageApplied.to}</span>`);
  }
  if (bonuses.thief) {
    tags.push(`<span class="bonus-tag thief">🦹 +${formatElevation(bonuses.thief.amount, false)} m volés</span>`);
  }
  if (bonuses.stolen) {
    tags.push(`<span class="bonus-tag stolen">🦹 -${formatElevation(bonuses.stolen.amount, false)} m volés</span>`);
  }
  // Kamikaze (perte personnelle)
  if (bonuses.kamikaze) {
    tags.push(`<span class="bonus-tag kamikaze">💣 -${formatElevation(bonuses.kamikaze.amount, false)} m (kamikaze)</span>`);
  }
  // Victime de Kamikaze
  if (bonuses.kamikazeTarget) {
    tags.push(`<span class="bonus-tag kamikaze-victim">💥 -${formatElevation(bonuses.kamikazeTarget.amount, false)} m</span>`);
  }
  // Maudit (victime de malédiction)
  if (bonuses.cursed) {
    tags.push(`<span class="bonus-tag cursed">🪬 -${formatElevation(bonuses.cursed.amount, false)} m</span>`);
  }

  // Bonus éphémères
  if (ephemeralBonus) {
    if (ephemeralBonus.embuscadeStolen) {
      tags.push(`<span class="bonus-tag ephemeral-stolen">🏹 -${formatElevation(ephemeralBonus.embuscadeStolen, false)} m volés</span>`);
    }
    if (ephemeralBonus.embuscadeGained) {
      tags.push(`<span class="bonus-tag ephemeral-gained">🏹 +${formatElevation(ephemeralBonus.embuscadeGained, false)} m volés</span>`);
    }
    if (ephemeralBonus.ravitaillement) {
      tags.push(`<span class="bonus-tag ephemeral-bonus">🍖 +${formatElevation(ephemeralBonus.ravitaillement, false)} m</span>`);
    }
    if (ephemeralBonus.marquage) {
      tags.push(`<span class="bonus-tag ephemeral-mark">🎯 -${formatElevation(ephemeralBonus.marquage, false)} m (-20%)</span>`);
    }
  }

  if (tags.length > 0) {
    html += `<div class="elevation-bonuses">${tags.join('')}</div>`;
  }

  return html;
}

// ============================================
// RENDU DES PARTICIPANTS (CARDS)
// ============================================

export function renderParticipants(container, data) {
  const { participants, stats, currentRoundNumber } = data;

  let html = '<div class="participants-grid">';

  participants.forEach(p => {
    const pStats = stats?.[p.id] || { elevation: 0, activities: 0 };
    const stock = getJokerStock(p.id);

    html += `
      <div class="participant-card" data-participant-id="${p.id}">
        <div class="card-header">
          <div class="avatar" style="background: ${getAthleteColor(p.id)}">
            ${getAthleteInitials(p.id)}
          </div>
          <div class="info">
            <span class="name">${p.name}</span>
            <span class="stats">${pStats.activities} activités</span>
          </div>
        </div>
        <div class="card-body">
          <div class="elevation">${formatElevation(pStats.elevation)}</div>
          <div class="jokers-row">
            ${Object.entries(JOKER_TYPES).map(([id, j]) =>
              `<span class="mini-joker" title="${j.name}">${j.icon}${stock[id] || 0}</span>`
            ).join('')}
          </div>
        </div>
      </div>
    `;
  });

  html += '</div>';
  container.innerHTML = html;
}

// ============================================
// RENDU DE LA SECTION ARSENAL (JOKERS & BONUS)
// ============================================

export function renderArsenal(container, data) {
  const {
    activeJokers = [],
    bonuses = [],
    currentRoundNumber,
    showPreviousRoundEffects = false,
    previousRoundEffects = { jokers: [], bonuses: [] },
    previousRoundNumber = 0
  } = data;

  let html = '';

  // === RÉCAP DU ROUND PRÉCÉDENT (affiché 1 jour après la fin) ===
  if (showPreviousRoundEffects && (previousRoundEffects.jokers.length > 0 || previousRoundEffects.bonuses.length > 0)) {
    html += `
      <div class="arsenal-card arsenal-recap">
        <div class="arsenal-card-title">
          <span class="icon">📜</span>
          Récap Round ${previousRoundNumber} (terminé)
        </div>
        <div class="recap-content">
    `;

    // Jokers du round précédent
    if (previousRoundEffects.jokers.length > 0) {
      html += '<div class="recap-section"><strong>Jokers utilisés :</strong><ul class="recap-list">';
      previousRoundEffects.jokers.forEach(joker => {
        const jokerType = JOKER_TYPES[joker.joker_id];
        if (!jokerType) return;
        html += `<li>${jokerType.icon} <strong>${joker.athlete_name}</strong>`;
        if (joker.target_athlete_name) {
          html += ` → ${joker.target_athlete_name}`;
        }
        html += ` (${jokerType.name})</li>`;
      });
      html += '</ul></div>';
    }

    // Bonus du round précédent
    if (previousRoundEffects.bonuses.length > 0) {
      html += '<div class="recap-section"><strong>Bonus éphémères :</strong><ul class="recap-list">';
      previousRoundEffects.bonuses.forEach(bonus => {
        html += `<li>${bonus.description}</li>`;
      });
      html += '</ul></div>';
    }

    html += `
        </div>
      </div>
    `;
  }

  // === JOKERS ACTIFS CE ROUND ===
  html += `
    <div class="arsenal-card">
      <div class="arsenal-card-title">
        <span class="icon">⚔️</span>
        Jokers en jeu ce round
      </div>
      <div class="active-jokers-list">
  `;

  if (activeJokers.length === 0) {
    html += '<div class="arsenal-empty">Aucun joker actif ce round</div>';
  } else {
    activeJokers.forEach(joker => {
      const jokerType = JOKER_TYPES[joker.joker_id];
      if (!jokerType) return;

      html += `
        <div class="active-joker-item">
          <span class="joker-icon">${jokerType.icon}</span>
          <span class="joker-source">${joker.athlete_name || 'Joueur'}</span>
          ${joker.target_athlete_name ? `
            <span class="joker-arrow">→</span>
            <span class="joker-target">${joker.target_athlete_name}</span>
          ` : ''}
          <span class="joker-type">${jokerType.name}</span>
        </div>
      `;
    });
  }

  html += `
      </div>
    </div>
  `;

  // === BONUS ÉPHÉMÈRES (seulement s'il y en a d'actifs/disponibles) ===
  if (bonuses.length > 0) {
    html += `
      <div class="arsenal-card">
        <div class="arsenal-card-title">
          <span class="icon">🎁</span>
          Bonus éphémères (Éliminés)
        </div>
        <div class="bonus-list">
    `;

    bonuses.forEach(bonus => {
      const statusClass = bonus.status === 'pending' ? 'pending' :
                          bonus.status === 'used' ? 'used' :
                          bonus.status === 'active' ? 'active' : 'available';

      const statusLabel = bonus.status === 'pending' ? '⏳ Choix en attente' :
                          bonus.status === 'used' ? '✓ Utilisé ce round' :
                          bonus.status === 'active' ? '🎯 Activé' : '💤 Disponible';

      // Construire les détails du bonus
      let bonusDetails = '';
      if (bonus.bonus_id && bonus.status !== 'pending') {
        const bonusType = BONUS_TYPES ? BONUS_TYPES[bonus.bonus_id] : null;

        // Afficher la cible si elle existe (sauf pour marquage)
        if (bonus.target_athlete_name && bonus.bonus_id !== 'marquage') {
          bonusDetails += `<div class="bonus-detail-target">🎯 Cible : <strong>${bonus.target_athlete_name}</strong></div>`;
        }

        // Afficher l'effet attendu selon le statut
        if (bonus.status === 'used' || bonus.status === 'active') {
          bonusDetails += `<div class="bonus-detail-effect">${getBonusEffectDescription(bonus)}</div>`;
        }
      }

      // Info au survol
      const hoverTitle = bonus.hoverInfo ? bonus.hoverInfo : '';

      html += `
        <div class="bonus-item ${statusClass}" ${hoverTitle ? `title="${hoverTitle}"` : ''}>
          <div class="bonus-item-header">
            <span class="bonus-icon">${bonus.icon || '🎁'}</span>
            <span class="bonus-owner">👻 ${bonus.athlete_name || 'Joueur'}</span>
            ${bonus.bonus_name ? `<span class="bonus-name">${bonus.bonus_name}</span>` : ''}
            <span class="bonus-status ${statusClass}">${statusLabel}</span>
          </div>
          ${bonusDetails ? `<div class="bonus-item-details">${bonusDetails}</div>` : ''}
          ${bonus.hoverInfo ? `<div class="bonus-hover-hint">ℹ️ Survoler pour plus d'infos</div>` : ''}
        </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
}

/**
 * Génère une description de l'effet du bonus en fonction de son statut et de sa cible
 */
function getBonusEffectDescription(bonus) {
  const bonusId = bonus.bonus_id;
  const target = bonus.target_athlete_name;
  const used_in_round = bonus.used_in_round;

  switch (bonusId) {
    case 'embuscade':
      return `⚡ À la fin du round, une activité aléatoire de ${target || 'la cible'} sera volée`;
    case 'ravitaillement':
      return `⚡ À la fin du round$, une activité sera donnée à ${target || 'la cible'}`;
    case 'duel':
      return `⚡ Duel en cours jusqu'à la fin de la saison. Le gagnant (plus de D+) obtient +1 point`;
    case 'brouillard':
      return `⚡ D+ masqué jusqu'à la révélation finale en fin de saison`;
    case 'marquage':
      return `⚡ Si ${target || 'la cible'} est éliminé(e) à la fin du round → +1 point`;
    case 'trap':
      return `⚡ Piège actif. Le prochain dernier éliminé donnera du D+`;
    case 'second_souffle':
      return `⚡ En fin de saison, la plus petite activité sera doublée`;
    case 'kamikaze':
      return `💣 -25% D+ pour toi ET -25% D+ pour ${target || 'la cible'} à la fin du round`;
    case 'malediction':
      return `🪬 Maudit ${target || 'la cible'} : -10% de son D+ volé à chaque fin de round`;
    default:
      return '';
  }
}

// ============================================
// RENDU DU GUIDE DES JOKERS
// ============================================

export function renderJokersGuide(container) {
  let html = `
    <div class="jokers-guide-section">
      <h2 class="section-title">🃏 Guide des Jokers</h2>
      <p class="guide-intro">Chaque participant dispose de jokers stratégiques. Clic droit sur un athlète pour les utiliser.</p>
      
      <div class="jokers-guide-grid">
  `;
  
  Object.entries(JOKER_TYPES).forEach(([id, joker]) => {
    html += `
      <div class="joker-guide-card ${id}">
        <div class="joker-guide-icon">${joker.icon}</div>
        <div class="joker-guide-content">
          <h3>${joker.name}</h3>
          <div class="joker-effect-desc">${joker.description}</div>
          <div class="joker-details">${joker.effect}</div>
          ${!joker.usableInFinal ? '<div class="joker-warning">⚠️ Non utilisable en finale</div>' : ''}
        </div>
      </div>
    `;
  });
  
  html += `
      </div>
      
      <div class="joker-tips">
        <h4>💡 Conseils stratégiques</h4>
        <ul>
          <li>Les jokers s'activent au round suivant leur utilisation</li>
          <li>Le Duel peut retourner une situation défavorable</li>
          <li>Le Bouclier est précieux - gardez-le pour les moments critiques</li>
          <li>Combinez Multiplicateur et effort intense pour maximiser l'impact</li>
        </ul>
      </div>
    </div>
  `;
  
  container.innerHTML = html;
}

// ============================================
// RENDU DES NOTIFICATIONS
// ============================================

let notificationTimeout = null;

export function showNotification(message, type = 'info') {
  let notification = document.getElementById('notification');
  
  if (!notification) {
    notification = document.createElement('div');
    notification.id = 'notification';
    notification.className = 'notification';
    document.body.appendChild(notification);
  }
  
  notification.textContent = message;
  notification.className = `notification notification-${type} visible`;
  
  if (notificationTimeout) clearTimeout(notificationTimeout);
  notificationTimeout = setTimeout(() => {
    notification.classList.remove('visible');
  }, 3000);
}

// ============================================
// RENDU DU MENU CONTEXTUEL JOKERS
// ============================================

let contextMenu = null;

export function createContextMenu() {
  if (contextMenu) return contextMenu;
  
  contextMenu = document.createElement('div');
  contextMenu.className = 'joker-context-menu';
  contextMenu.innerHTML = `
    <div class="context-menu-header">🃏 Utiliser un Joker</div>
    <div class="context-menu-items"></div>
  `;
  document.body.appendChild(contextMenu);
  
  // Fermer au clic ailleurs
  document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) {
      hideContextMenu();
    }
  });
  
  return contextMenu;
}

export function showContextMenu(e, participantId, participantName, options = {}) {
  e.preventDefault();
  const menu = createContextMenu();
  
  const stock = getJokerStock(participantId);
  const status = getJokerStatusForRound(participantId, options.currentRoundNumber || 1);
  const isAdmin = options.isAdmin || false;
  
  let itemsHtml = '';
  
  if (isAdmin) {
    itemsHtml += '<div class="context-menu-section">Modifier le stock :</div>';
    Object.entries(JOKER_TYPES).forEach(([jokerId, joker]) => {
      const count = stock[jokerId] || 0;
      itemsHtml += `
        <div class="context-menu-item admin-joker" data-joker="${jokerId}" data-participant="${participantId}">
          <span class="joker-icon">${joker.icon}</span>
          <span class="joker-name">${joker.name}</span>
          <span class="joker-controls">
            <button class="joker-minus" data-action="remove">−</button>
            <span class="joker-count">${count}</span>
            <button class="joker-plus" data-action="add">+</button>
          </span>
        </div>
      `;
    });
  } else {
    itemsHtml += '<div class="context-menu-info">⏰ Activé au prochain round</div>';
    Object.entries(JOKER_TYPES).forEach(([jokerId, joker]) => {
      const count = stock[jokerId] || 0;
      const alreadyPending = status.pending.some(j => j.jokerId === jokerId);
      const disabled = count <= 0 || alreadyPending;
      
      itemsHtml += `
        <div class="context-menu-item ${disabled ? 'disabled' : ''}" 
             data-joker="${jokerId}" 
             data-participant="${participantId}" 
             data-name="${participantName}">
          <span class="joker-icon">${joker.icon}</span>
          <span class="joker-name">${joker.name}</span>
          <span class="joker-count">${count}</span>
          <span class="joker-disabled-reason">
            ${alreadyPending ? '(programmé)' : count <= 0 ? '(épuisé)' : ''}
          </span>
        </div>
      `;
    });
  }
  
  itemsHtml += `
    <div class="context-menu-divider"></div>
    <div class="context-menu-item reset" data-action="reset" data-participant="${participantId}">
      <span class="joker-icon">🔄</span>
      <span class="joker-name">Reset jokers (démo)</span>
    </div>
  `;
  
  menu.querySelector('.context-menu-header').textContent = 
    '🃏 ' + (isAdmin ? 'Gérer' : 'Jokers de') + ' ' + participantName;
  menu.querySelector('.context-menu-items').innerHTML = itemsHtml;
  
  // Positionner le menu
  menu.style.left = Math.min(e.clientX, window.innerWidth - 280) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 300) + 'px';
  menu.classList.add('visible');
  
  return menu;
}

export function hideContextMenu() {
  if (contextMenu) {
    contextMenu.classList.remove('visible');
  }
}

// ============================================
// MODALE DE SÉLECTION DE CIBLE (DUEL/SABOTAGE)
// ============================================

export function showTargetSelectionModal(options = {}) {
  const { participantId, jokerId, participants, onSelect, onCancel } = options;
  
  const jokerType = JOKER_TYPES[jokerId];
  const currentParticipant = getParticipantById(participantId);
  
  const modal = document.createElement('div');
  modal.className = 'joker-modal';
  modal.innerHTML = `
    <div class="joker-modal-content">
      <div class="joker-modal-header">
        <span>${jokerType.icon} ${jokerType.name} - Choisir une cible</span>
        <button class="joker-modal-close">&times;</button>
      </div>
      <div class="joker-modal-body">
        <p>Sélectionnez l'adversaire à cibler :</p>
        <div class="target-list">
          ${participants
            .filter(p => p.id !== participantId)
            .map(p => `
              <div class="target-option" data-target-id="${p.id}" data-target-name="${p.name}">
                <div class="target-avatar" style="background: ${getAthleteColor(p.id)}">
                  ${getAthleteInitials(p.id)}
                </div>
                <span class="target-name">${p.name}</span>
              </div>
            `).join('')}
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Fermer
  modal.querySelector('.joker-modal-close').onclick = () => {
    document.body.removeChild(modal);
    if (onCancel) onCancel();
  };
  
  modal.onclick = (e) => {
    if (e.target === modal) {
      document.body.removeChild(modal);
      if (onCancel) onCancel();
    }
  };
  
  // Sélection de cible
  modal.querySelectorAll('.target-option').forEach(option => {
    option.onclick = () => {
      const targetId = option.dataset.targetId;
      const targetName = option.dataset.targetName;
      document.body.removeChild(modal);
      if (onSelect) onSelect({ targetId, targetName });
    };
  });
  
  return modal;
}