/**
 * ============================================
 * VERSANT - SIMULATEUR D'EFFETS (jokers + bonus)
 * ============================================
 *
 * Mode PREVIEW en lecture seule. Affiche l'effet des jokers et bonus
 * DEJA POSES sur le round courant.
 *
 * Deux modes selon le type de saison :
 *   - INDIVIDUEL : classement des joueurs (avant -> apres)
 *   - EQUIPE     : classement des equipes (D+ total) + detail des membres,
 *                  avec badge sur l'equipe qui serait eliminee (derniere).
 *
 * NE FIGE RIEN. NE MODIFIE AUCUN FICHIER. Tout est en memoire navigateur.
 */

import { getRoundDates, getParticipantById, getSeasonType, getSeasonNumber } from './config.js';
import { filterByPeriod, calculateRanking } from './standings-engine.js';
import { applyJokerEffects, getActiveJokersForRound, getBonusesUsedInRound } from './jokers.js';
import { formatElevation } from './ui.js';

// ============================================
// EXTRACTION DES EFFETS LISIBLES (commun aux 2 modes)
// ============================================

function extractEffects(entry, bonusByAthlete) {
  const effects = [];
  const je = entry.jokerEffects || {};
  const b = je.bonuses || {};

  if (b.stolen && b.stolen.amount > 0) {
    effects.push({ icon: '🦹', type: 'loss', text: `Volé par ${b.stolen.by}`, amount: -b.stolen.amount });
  }
  if (Array.isArray(b.thief) && b.thief.length > 0) {
    const gained = b.thief.reduce((s, t) => s + t.amount, 0);
    const victims = b.thief.map(t => t.from).join(', ');
    effects.push({ icon: '🦹', type: 'gain', text: `A volé ${victims}`, amount: gained });
  }
  if (b.sabotaged && b.sabotaged.amount > 0) {
    effects.push({ icon: '💥', type: 'loss', text: `Saboté par ${b.sabotaged.by}`, amount: -b.sabotaged.amount });
  }
  if (Array.isArray(b.sabotageApplied) && b.sabotageApplied.length > 0) {
    const targets = b.sabotageApplied.map(s => s.to).join(', ');
    effects.push({ icon: '💥', type: 'neutral', text: `A saboté ${targets}`, amount: 0 });
  }
  if (b.multiplier && b.multiplier.amount > 0) {
    effects.push({ icon: '✨', type: 'gain', text: `Multiplicateur ×${b.multiplier.factor}`, amount: b.multiplier.amount });
  }
  if (b.shield) {
    effects.push({ icon: '🛡️', type: 'neutral', text: 'Bouclier (protégé)', amount: 0 });
  }
  const bonus = bonusByAthlete[String(entry.participant.id)];
  if (bonus) {
    effects.push({
      icon: bonus.bonusIcon || '🎁', type: 'neutral',
      text: `Bonus : ${bonus.bonusName}${bonus.targetName ? ' → ' + bonus.targetName : ''}`,
      amount: 0
    });
  }
  return effects;
}

function getBonusByAthlete(roundNumber) {
  let bonusesUsed = [];
  try { bonusesUsed = getBonusesUsedInRound(roundNumber) || []; } catch (e) { bonusesUsed = []; }
  const map = {};
  bonusesUsed.forEach(b => { map[String(b.athlete_id)] = b; });
  return { map, count: bonusesUsed.length };
}

// ============================================
// MODE INDIVIDUEL
// ============================================

function buildIndividualSimulation(roundNumber, allActivities, activeParticipants) {
  const roundDates = getRoundDates(roundNumber);
  const today = new Date();
  const endDate = today < new Date(roundDates.end) ? today : roundDates.end;
  const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);

  const rawRanking = calculateRanking(roundActivities, activeParticipants);
  const rawById = {};
  rawRanking.forEach((entry, idx) => {
    rawById[String(entry.participant.id)] = { position: idx + 1, elevation: entry.totalElevation };
  });

  const baseForEffects = calculateRanking(roundActivities, activeParticipants);
  const withEffects = applyJokerEffects(baseForEffects, roundNumber, roundActivities);

  const { map: bonusByAthlete, count: bonusCount } = getBonusByAthlete(roundNumber);
  const activeJokers = getActiveJokersForRound(roundNumber);
  const hasEffects = activeJokers.length > 0 || bonusCount > 0;

  const rows = withEffects.map((entry, idx) => {
    const id = String(entry.participant.id);
    const raw = rawById[id] || { position: idx + 1, elevation: entry.totalElevation };
    const finalPos = idx + 1;
    return {
      id,
      name: entry.participant.name,
      rawPosition: raw.position,
      finalPosition: finalPos,
      movement: raw.position - finalPos,
      rawElevation: Math.round(raw.elevation),
      finalElevation: Math.round(entry.totalElevation),
      effects: extractEffects(entry, bonusByAthlete)
    };
  });

  return { mode: 'individual', roundNumber, rows, hasEffects };
}

// ============================================
// MODE EQUIPE
// ============================================

async function buildTeamSimulation(roundNumber, allActivities, activeParticipants) {
  const roundDates = getRoundDates(roundNumber);
  const today = new Date();
  const endDate = today < new Date(roundDates.end) ? today : roundDates.end;
  const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);

  const resp = await fetch(`/api/teams/round/${roundNumber}`);
  if (!resp.ok) throw new Error('Impossible de charger les équipes');
  const teamData = await resp.json();
  if (!Array.isArray(teamData.teams) || teamData.teams.length === 0) {
    throw new Error('Aucune équipe pour ce round');
  }

  const baseForEffects = calculateRanking(roundActivities, activeParticipants);
  const withEffects = applyJokerEffects(baseForEffects, roundNumber, roundActivities);

  const effById = {};
  withEffects.forEach(entry => { effById[String(entry.participant.id)] = entry; });

  const rawElevById = {};
  for (const a of roundActivities) {
    if (a.excluded) continue;
    const aid = String(a.athlete?.id || a.athlete_id);
    rawElevById[aid] = (rawElevById[aid] || 0) + (a.total_elevation_gain || 0);
  }

  const { map: bonusByAthlete, count: bonusCount } = getBonusByAthlete(roundNumber);
  const activeJokers = getActiveJokersForRound(roundNumber);
  const hasEffects = activeJokers.length > 0 || bonusCount > 0;

  const teams = teamData.teams.map(team => {
    const members = team.members.map(m => {
      const id = String(m.id);
      const entry = effById[id];
      const finalElev = entry ? Math.round(entry.totalElevation) : Math.round(rawElevById[id] || 0);
      const rawElev = Math.round(rawElevById[id] || 0);
      return {
        id,
        name: m.name || getParticipantById(id)?.name || 'Inconnu',
        rawElevation: rawElev,
        finalElevation: finalElev,
        effects: entry ? extractEffects(entry, bonusByAthlete) : []
      };
    });
    return {
      animal: team.animal,
      color: team.color,
      members,
      rawTotal: members.reduce((s, m) => s + m.rawElevation, 0),
      finalTotal: members.reduce((s, m) => s + m.finalElevation, 0)
    };
  });

  const rawOrder = [...teams].sort((a, b) => b.rawTotal - a.rawTotal);
  const rawRankByAnimal = {};
  rawOrder.forEach((t, idx) => { rawRankByAnimal[t.animal.id || t.animal.name] = idx + 1; });

  teams.sort((a, b) => b.finalTotal - a.finalTotal);
  teams.forEach((t, idx) => {
    const key = t.animal.id || t.animal.name;
    t.finalRank = idx + 1;
    t.rawRank = rawRankByAnimal[key] || idx + 1;
    t.movement = t.rawRank - t.finalRank;
    t.isEliminated = (idx === teams.length - 1);
    t.members.sort((a, b) => b.finalElevation - a.finalElevation);
  });

  return { mode: 'team', roundNumber, teams, hasEffects, isFrozen: !!teamData.frozen };
}

// ============================================
// RENDU HTML
// ============================================

function movementBadge(mvt) {
  if (mvt > 0) return `<span class="sim-mvt sim-mvt-up">▲ ${mvt}</span>`;
  if (mvt < 0) return `<span class="sim-mvt sim-mvt-down">▼ ${Math.abs(mvt)}</span>`;
  return `<span class="sim-mvt sim-mvt-same">=</span>`;
}

function effectsHTML(effects) {
  if (!effects.length) return '<span class="sim-no-effect">—</span>';
  return effects.map(e => {
    const amountStr = e.amount > 0
      ? `<span class="sim-eff-gain">+${formatElevation(e.amount, false)}</span>`
      : e.amount < 0
      ? `<span class="sim-eff-loss">−${formatElevation(Math.abs(e.amount), false)}</span>`
      : '';
    return `<div class="sim-effect">
      <span class="sim-eff-icon">${e.icon}</span>
      <span class="sim-eff-text">${e.text}</span>
      ${amountStr}
    </div>`;
  }).join('');
}

function deltaElev(raw, final) {
  const d = final - raw;
  if (d === 0) return '';
  const cls = d > 0 ? 'sim-delta-gain' : 'sim-delta-loss';
  const sign = d > 0 ? '+' : '−';
  return `<span class="sim-delta ${cls}">${sign}${formatElevation(Math.abs(d), false)}</span>`;
}

function renderIndividualHTML(sim) {
  const rowsHTML = sim.rows.map(r => `
    <tr class="${r.movement !== 0 ? 'sim-row-moved' : ''}">
      <td class="sim-pos">
        <span class="sim-pos-final">${r.finalPosition}</span>
        ${movementBadge(r.movement)}
      </td>
      <td class="sim-name">${r.name}</td>
      <td class="sim-elev">
        <span class="sim-elev-final">${formatElevation(r.finalElevation, false)} m</span>
        ${deltaElev(r.rawElevation, r.finalElevation)}
      </td>
      <td class="sim-effects">${effectsHTML(r.effects)}</td>
    </tr>
  `).join('');

  return `
    <table class="sim-table">
      <thead>
        <tr><th>Pos.</th><th>Joueur</th><th>D+ final</th><th>Effets appliqués</th></tr>
      </thead>
      <tbody>${rowsHTML}</tbody>
    </table>
  `;
}

function renderTeamHTML(sim) {
  return sim.teams.map(team => {
    const membersHTML = team.members.map(m => `
      <div class="sim-team-member">
        <span class="sim-tm-name">${m.name}</span>
        <span class="sim-tm-elev">
          ${formatElevation(m.finalElevation, false)} m
          ${deltaElev(m.rawElevation, m.finalElevation)}
        </span>
        <div class="sim-tm-effects">${effectsHTML(m.effects)}</div>
      </div>
    `).join('');

    const animalEmoji = team.animal.emoji || '';
    const animalName = team.animal.name || 'Équipe';

    return `
      <div class="sim-team ${team.isEliminated ? 'sim-team-eliminated' : ''}"
           style="--team-color: ${team.color || '#888'}">
        <div class="sim-team-header">
          <span class="sim-team-rank">${team.finalRank}</span>
          <span class="sim-team-animal">${animalEmoji} ${animalName}</span>
          ${movementBadge(team.movement)}
          <span class="sim-team-total">
            ${formatElevation(team.finalTotal, false)} m
            ${deltaElev(team.rawTotal, team.finalTotal)}
          </span>
          ${team.isEliminated ? '<span class="sim-team-elim-badge">ÉLIMINÉE</span>' : ''}
        </div>
        <div class="sim-team-members">${membersHTML}</div>
      </div>
    `;
  }).join('');
}

function renderSimulationHTML(sim) {
  const banner = `
    <div class="sim-banner">
      🧪 <strong>SIMULATION</strong> —
      ${sim.mode === 'team' ? 'Classement par équipe' : 'Classement individuel'},
      effets jokers &amp; bonus du round ${sim.roundNumber}.
      Aucune donnée n'est enregistrée.
    </div>
  `;

  if (!sim.hasEffects) {
    return banner + `<div class="sim-empty">Aucun joker ni bonus actif sur ce round pour le moment.</div>`;
  }

  return banner + (sim.mode === 'team' ? renderTeamHTML(sim) : renderIndividualHTML(sim));
}

// ============================================
// POINT D'ENTREE
// ============================================

export async function toggleSimulator(roundNumber, allActivities, activeParticipants) {
  const panel = document.getElementById('simulatorPanel');
  if (!panel) return;

  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
    panel.innerHTML = '';
    return;
  }

  panel.innerHTML = '<div class="sim-banner">🧪 Calcul de la simulation…</div>';
  panel.classList.add('open');

  try {
    const seasonNumber = getSeasonNumber(roundNumber);
    const seasonType = getSeasonType(seasonNumber);
    const isTeam = !!seasonType?.isTeamBased;

    const sim = isTeam
      ? await buildTeamSimulation(roundNumber, allActivities, activeParticipants || [])
      : buildIndividualSimulation(roundNumber, allActivities, activeParticipants || []);

    panel.innerHTML = renderSimulationHTML(sim);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    console.error('❌ Erreur simulation:', e);
    panel.innerHTML = `<div class="sim-banner sim-error">Erreur lors de la simulation : ${e.message}</div>`;
  }
}