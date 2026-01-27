/**
 * VERSANT - ROUTES JOKERS/BONUS
 * Module Express Router
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;

const JOKER_CONFIG = {
  duel: { id: "duel", name: "Duel", initialStock: 2, stealPercentage: 25, notOnLastDay: true },
  multiplicateur: { id: "multiplicateur", name: "Multiplicateur", initialStock: 2, multiplier: 2 },
  bouclier: { id: "bouclier", name: "Bouclier", initialStock: 2, usableInFinal: false },
  sabotage: { id: "sabotage", name: "Sabotage", initialStock: 2, fixedAmount: 250 }
};

function createInitialJokersStock() {
  return {
    duel: JOKER_CONFIG.duel.initialStock,
    multiplicateur: JOKER_CONFIG.multiplicateur.initialStock,
    bouclier: JOKER_CONFIG.bouclier.initialStock,
    sabotage: JOKER_CONFIG.sabotage.initialStock
  };
}

function createJokersRoutes({ ATHLETES_FILE, JOKERS_FILE, ADMIN_PASSWORD, requireAuth }) {

  // GET /api/admin/jokers/:leagueId
  router.get('/admin/jokers/:leagueId', async (req, res) => {
    try {
      const password = req.headers['x-admin-password'];
      if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Non autorisé' });
      }

      const { leagueId } = req.params;
      let athletes = [], jokerUsage = [];
      
      try { athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8')); } catch (e) {}
      try { jokerUsage = JSON.parse(await fs.readFile(JOKERS_FILE, 'utf8')); } catch (e) {}

      const leagueAthletes = athletes.filter(a => a.league_id === leagueId);
      const leagueUsage = jokerUsage.filter(j => leagueAthletes.find(a => a.id === j.athlete_id));

      const athletesWithJokers = leagueAthletes.map(athlete => ({
        id: athlete.id,
        firstname: athlete.firstname || athlete.name?.split(' ')[0] || 'Inconnu',
        lastname: athlete.lastname || athlete.name?.split(' ').slice(1).join(' ') || '',
        name: athlete.name,
        jokerStock: athlete.jokers_stock || createInitialJokersStock()
      }));

      const usage = leagueUsage.map(u => ({
        id: u.id, athleteId: u.athlete_id, type: u.joker_id, targetId: u.target_athlete_id,
        round: u.round_number, resolved: u.resolved || false, result: u.result
      }));

      res.json({ athletes: athletesWithJokers, usage, config: JOKER_CONFIG });
    } catch (error) {
      console.error('Erreur jokers admin:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // PUT /api/admin/jokers/:athleteId
  router.put('/admin/jokers/:athleteId', async (req, res) => {
    try {
      const password = req.headers['x-admin-password'];
      if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });

      const { athleteId } = req.params;
      const { jokerStock } = req.body;

      if (!jokerStock || typeof jokerStock !== 'object') {
        return res.status(400).json({ error: 'jokerStock invalide' });
      }

      const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
      const athleteIndex = athletes.findIndex(a => a.id === athleteId || a.id === parseInt(athleteId));
      if (athleteIndex < 0) return res.status(404).json({ error: 'Athlète non trouvé' });

      for (const [key, value] of Object.entries(jokerStock)) {
        if (!JOKER_CONFIG[key]) return res.status(400).json({ error: `Joker inconnu: ${key}` });
        if (typeof value !== 'number' || value < 0 || value > 5) {
          return res.status(400).json({ error: `Valeur invalide pour ${key}` });
        }
      }

      athletes[athleteIndex].jokers_stock = jokerStock;
      await fs.writeFile(ATHLETES_FILE, JSON.stringify(athletes, null, 2));
      console.log(`🃏 Admin: Stock jokers modifié pour ${athletes[athleteIndex].name}`);

      res.json({ success: true, athlete_id: athleteId, jokers_stock: jokerStock });
    } catch (error) {
      console.error('Erreur modification jokers:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // POST /api/admin/jokers/reset/:leagueId
  router.post('/admin/jokers/reset/:leagueId', async (req, res) => {
    try {
      const password = req.headers['x-admin-password'];
      if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });

      const { leagueId } = req.params;
      const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));

      let resetCount = 0;
      athletes.forEach(athlete => {
        if (athlete.league_id === leagueId) {
          athlete.jokers_stock = createInitialJokersStock();
          resetCount++;
        }
      });

      await fs.writeFile(ATHLETES_FILE, JSON.stringify(athletes, null, 2));
      console.log(`🃏 Admin: Reset jokers pour ${resetCount} athlètes`);

      res.json({ success: true, count: resetCount });
    } catch (error) {
      console.error('Erreur reset jokers:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // POST /api/jokers/use-v2
  router.post('/jokers/use-v2', requireAuth, async (req, res) => {
    try {
      const { joker_id, target_athlete_id, round_number, criteria_id, day_index } = req.body;
      const athleteId = req.athleteId;

      if (!joker_id || !round_number) {
        return res.status(400).json({ error: 'joker_id et round_number requis' });
      }

      const jokerConfig = JOKER_CONFIG[joker_id];
      if (!jokerConfig) return res.status(400).json({ error: 'Joker inconnu' });

      const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
      const athleteIndex = athletes.findIndex(a => a.id === athleteId);
      if (athleteIndex < 0) return res.status(404).json({ error: 'Athlète non trouvé' });

      const athlete = athletes[athleteIndex];
      if (!athlete.jokers_stock) athlete.jokers_stock = createInitialJokersStock();

      if (!athlete.jokers_stock[joker_id] || athlete.jokers_stock[joker_id] <= 0) {
        return res.status(400).json({ error: 'Joker non disponible', stock: athlete.jokers_stock[joker_id] || 0 });
      }

      let jokerUsage = [];
      try { jokerUsage = JSON.parse(await fs.readFile(JOKERS_FILE, 'utf8')); } catch (e) {}

      const alreadyUsed = jokerUsage.find(j => 
        j.athlete_id === athleteId && j.joker_id === joker_id && 
        j.round_number === round_number && j.status !== 'cancelled'
      );
      if (alreadyUsed) return res.status(400).json({ error: `${jokerConfig.name} déjà utilisé ce round` });

      if (joker_id === 'duel' && (!target_athlete_id || !criteria_id)) {
        return res.status(400).json({ error: 'target_athlete_id et criteria_id requis pour duel' });
      }
      if (joker_id === 'sabotage' && !target_athlete_id) {
        return res.status(400).json({ error: 'target_athlete_id requis pour sabotage' });
      }
      if (joker_id === 'multiplicateur' && (day_index === undefined || day_index < 0 || day_index > 4)) {
        return res.status(400).json({ error: 'day_index invalide (0-4)' });
      }

      const usage = {
        id: `${athleteId}-${joker_id}-${round_number}-${Date.now()}`,
        athlete_id: athleteId, athlete_name: athlete.name,
        joker_id, joker_name: jokerConfig.name,
        target_athlete_id: target_athlete_id || null,
        target_athlete_name: target_athlete_id ? athletes.find(a => a.id === target_athlete_id)?.name : null,
        round_number, criteria_id: criteria_id || null, day_index: day_index ?? null,
        used_at: new Date().toISOString(), status: 'active', resolved: false, result: null
      };

      jokerUsage.push(usage);
      await fs.writeFile(JOKERS_FILE, JSON.stringify(jokerUsage, null, 2));

      athlete.jokers_stock[joker_id] -= 1;
      athletes[athleteIndex] = athlete;
      await fs.writeFile(ATHLETES_FILE, JSON.stringify(athletes, null, 2));

      console.log(`🃏 Joker utilisé: ${joker_id} par ${athlete.name}`);
      res.json({ success: true, usage, remaining_stock: athlete.jokers_stock[joker_id] });
    } catch (error) {
      console.error('Erreur utilisation joker:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // GET /api/jokers/active/:roundNumber
  router.get('/jokers/active/:roundNumber', async (req, res) => {
    try {
      const { roundNumber } = req.params;
      let jokerUsage = [];
      try { jokerUsage = JSON.parse(await fs.readFile(JOKERS_FILE, 'utf8')); } catch (e) {}

      const activeJokers = jokerUsage.filter(j => j.round_number === parseInt(roundNumber) && j.status === 'active');

      res.json({
        round_number: parseInt(roundNumber),
        total_active: activeJokers.length,
        duels: activeJokers.filter(j => j.joker_id === 'duel'),
        multiplicateurs: activeJokers.filter(j => j.joker_id === 'multiplicateur'),
        boucliers: activeJokers.filter(j => j.joker_id === 'bouclier'),
        sabotages: activeJokers.filter(j => j.joker_id === 'sabotage')
      });
    } catch (error) {
      console.error('Erreur jokers actifs:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // POST /api/admin/jokers/resolve/:usageId
  router.post('/admin/jokers/resolve/:usageId', async (req, res) => {
    try {
      const password = req.headers['x-admin-password'];
      if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });

      const { usageId } = req.params;
      const { result } = req.body;

      const jokerUsage = JSON.parse(await fs.readFile(JOKERS_FILE, 'utf8'));
      const usageIndex = jokerUsage.findIndex(j => j.id === usageId);
      if (usageIndex < 0) return res.status(404).json({ error: 'Usage non trouvé' });

      jokerUsage[usageIndex].resolved = true;
      jokerUsage[usageIndex].resolved_at = new Date().toISOString();
      jokerUsage[usageIndex].result = result;

      await fs.writeFile(JOKERS_FILE, JSON.stringify(jokerUsage, null, 2));
      res.json({ success: true, usage: jokerUsage[usageIndex] });
    } catch (error) {
      console.error('Erreur résolution joker:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  return router;
}

async function applyJokerEffects(ranking, activeJokers) {
  const effects = [];
  const modifiedRanking = [...ranking];

  for (const duel of activeJokers.filter(j => j.joker_id === 'duel')) {
    const challenger = modifiedRanking.find(r => r.participant.id === duel.athlete_id);
    const target = modifiedRanking.find(r => r.participant.id === duel.target_athlete_id);
    if (challenger && target && challenger.totalElevation > target.totalElevation) {
      const stolenAmount = Math.round(target.totalElevation * 0.25);
      challenger.totalElevation += stolenAmount;
      target.totalElevation -= stolenAmount;
      effects.push({ type: 'duel_won', winner_id: duel.athlete_id, loser_id: duel.target_athlete_id, stolen_amount: stolenAmount });
    }
  }

  for (const sab of activeJokers.filter(j => j.joker_id === 'sabotage')) {
    const target = modifiedRanking.find(r => r.participant.id === sab.target_athlete_id);
    if (target) {
      target.totalElevation = Math.max(0, target.totalElevation - 250);
      effects.push({ type: 'sabotage', target_id: sab.target_athlete_id, amount: 250 });
    }
  }

  modifiedRanking.sort((a, b) => b.totalElevation - a.totalElevation);
  modifiedRanking.forEach((e, i) => e.position = i + 1);

  return { modifiedRanking, effects };
}

module.exports = { JOKER_CONFIG, createInitialJokersStock, applyJokerEffects, createJokersRoutes };
