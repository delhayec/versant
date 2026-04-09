/**
 * VERSANT - ROUTES JOKERS/BONUS
 * Module Express Router
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;

const JOKER_CONFIG = {
  voleur: { id: "voleur", name: "Voleur", initialStock: 2, requiresTarget: true },
  multiplicateur: { id: "multiplicateur", name: "Multiplicateur", initialStock: 2, multiplier: 1.5 },
  bouclier: { id: "bouclier", name: "Bouclier", initialStock: 2, usableInFinal: false },
  sabotage: { id: "sabotage", name: "Sabotage", initialStock: 2, percentagePenalty: 30 }
};

function createInitialJokersStock() {
  return {
    voleur: JOKER_CONFIG.voleur.initialStock,
    multiplicateur: JOKER_CONFIG.multiplicateur.initialStock,
    bouclier: JOKER_CONFIG.bouclier.initialStock,
    sabotage: JOKER_CONFIG.sabotage.initialStock
  };
}

function createJokersRoutes({ ATHLETES_FILE, JOKERS_FILE, ADMIN_PASSWORD, requireAuth }) {

  // GET /api/admin/jokers/:leagueId
  // Retourne le stock calculé depuis les utilisations (comme le frontend)
  router.get('/admin/jokers/:leagueId', async (req, res) => {
    try {
      const password = req.headers['x-admin-password'];
      if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Non autorisé' });
      }

      const { leagueId } = req.params;
      let athletes = [], jokerUsageRaw = [];

      try { athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8')); } catch (e) {}
      try { jokerUsageRaw = JSON.parse(await fs.readFile(JOKERS_FILE, 'utf8')); } catch (e) {}

      // Normaliser: gérer le format objet {athletes, usage, config} ET le format tableau []
      const jokerUsage = Array.isArray(jokerUsageRaw) ? jokerUsageRaw :
        (jokerUsageRaw && Array.isArray(jokerUsageRaw.usage)) ? jokerUsageRaw.usage : [];

      const leagueAthletes = athletes.filter(a => a.league_id === leagueId);

      const INITIAL_STOCK = 2;

      // Calculer le stock depuis les utilisations (comme le frontend)
      const athletesWithJokers = leagueAthletes.map(athlete => {
        const athleteId = String(athlete.id);

        // Compter les utilisations par type de joker
        const jokerStock = {};
        Object.keys(JOKER_CONFIG).forEach(jokerId => {
          const usedCount = jokerUsage.filter(
            u => String(u.athlete_id) === athleteId && u.joker_id === jokerId
          ).length;
          jokerStock[jokerId] = Math.max(0, INITIAL_STOCK - usedCount);
        });

        return {
          id: athlete.id,
          firstname: athlete.firstname || athlete.name?.split(' ')[0] || 'Inconnu',
          lastname: athlete.lastname || athlete.name?.split(' ').slice(1).join(' ') || '',
          name: athlete.name,
          jokerStock
        };
      });

      // Filtrer les usages de cette ligue
      const leagueUsage = jokerUsage.filter(j =>
        leagueAthletes.find(a => String(a.id) === String(j.athlete_id))
      );

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
  // Modifie le stock de jokers en ajoutant/supprimant des entrées dans jokers_usage.json
  router.put('/admin/jokers/:athleteId', async (req, res) => {
    try {
      const password = req.headers['x-admin-password'];
      if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });

      const { athleteId } = req.params;
      const { jokerStock } = req.body;

      if (!jokerStock || typeof jokerStock !== 'object') {
        return res.status(400).json({ error: 'jokerStock invalide' });
      }

      // Valider les valeurs
      for (const [key, value] of Object.entries(jokerStock)) {
        if (!JOKER_CONFIG[key]) return res.status(400).json({ error: `Joker inconnu: ${key}` });
        if (typeof value !== 'number' || value < 0 || value > 5) {
          return res.status(400).json({ error: `Valeur invalide pour ${key}` });
        }
      }

      // Charger les données
      const athletes = JSON.parse(await fs.readFile(ATHLETES_FILE, 'utf8'));
      const athlete = athletes.find(a => String(a.id) === String(athleteId));
      if (!athlete) return res.status(404).json({ error: 'Athlète non trouvé' });

      let jokerUsageRaw = [];
      try { jokerUsageRaw = JSON.parse(await fs.readFile(JOKERS_FILE, 'utf8')); } catch (e) {}
      let jokerUsage = Array.isArray(jokerUsageRaw) ? jokerUsageRaw :
        (jokerUsageRaw && Array.isArray(jokerUsageRaw.usage)) ? jokerUsageRaw.usage : [];

      const INITIAL_STOCK = 2;
      const changes = [];

      // Pour chaque type de joker, ajuster les utilisations
      for (const [jokerId, desiredStock] of Object.entries(jokerStock)) {
        // Compter les utilisations actuelles
        const currentUsages = jokerUsage.filter(
          u => String(u.athlete_id) === String(athleteId) && u.joker_id === jokerId
        );
        const currentStock = Math.max(0, INITIAL_STOCK - currentUsages.length);

        if (desiredStock === currentStock) continue; // Pas de changement

        if (desiredStock > currentStock) {
          // Augmenter le stock = supprimer des utilisations (les plus récentes d'abord)
          const toRemove = currentStock - desiredStock; // nombre négatif
          const usagesToRemove = currentUsages
            .sort((a, b) => new Date(b.used_at) - new Date(a.used_at))
            .slice(0, Math.abs(toRemove));

          usagesToRemove.forEach(u => {
            const idx = jokerUsage.findIndex(j => j.id === u.id);
            if (idx >= 0) {
              jokerUsage.splice(idx, 1);
              changes.push(`${jokerId}: supprimé usage ${u.id}`);
            }
          });
        } else {
          // Diminuer le stock = ajouter des utilisations fictives
          const toAdd = currentStock - desiredStock;
          for (let i = 0; i < toAdd; i++) {
            const fakeUsage = {
              id: `admin-${athleteId}-${jokerId}-${Date.now()}-${i}`,
              athlete_id: String(athleteId),
              athlete_name: athlete.name,
              joker_id: jokerId,
              joker_name: JOKER_CONFIG[jokerId].name,
              target_athlete_id: null,
              target_athlete_name: null,
              round_number: 0, // Round 0 = ajustement admin
              used_at: new Date().toISOString(),
              status: 'admin_adjustment',
              resolved: true,
              result: 'Ajustement admin'
            };
            jokerUsage.push(fakeUsage);
            changes.push(`${jokerId}: ajouté usage fictif`);
          }
        }
      }

      // Sauvegarder
      await fs.writeFile(JOKERS_FILE, JSON.stringify(jokerUsage, null, 2));
      console.log(`🃏 Admin: Stock jokers modifié pour ${athlete.name}: ${changes.join(', ')}`);

      res.json({ success: true, athlete_id: athleteId, jokers_stock: jokerStock, changes });
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
      const leagueAthletes = athletes.filter(a => a.league_id === leagueId);

      // Vider les usages de jokers pour cette ligue
      let jokerUsageRaw = [];
      try { jokerUsageRaw = JSON.parse(await fs.readFile(JOKERS_FILE, 'utf8')); } catch (e) {}
      const jokerUsage = Array.isArray(jokerUsageRaw) ? jokerUsageRaw :
        (jokerUsageRaw && Array.isArray(jokerUsageRaw.usage)) ? jokerUsageRaw.usage : [];

      const leagueAthleteIds = new Set(leagueAthletes.map(a => String(a.id)));
      const remaining = jokerUsage.filter(u => !leagueAthleteIds.has(String(u.athlete_id)));

      await fs.writeFile(JOKERS_FILE, JSON.stringify(remaining, null, 2));
      console.log(`🃏 Admin: Reset jokers pour ${leagueAthletes.length} athlètes (${jokerUsage.length - remaining.length} usages supprimés)`);

      res.json({ success: true, count: leagueAthletes.length, usagesRemoved: jokerUsage.length - remaining.length });
    } catch (error) {
      console.error('Erreur reset jokers:', error);
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

      const jokerUsageRaw = JSON.parse(await fs.readFile(JOKERS_FILE, 'utf8'));
      const jokerUsage = Array.isArray(jokerUsageRaw) ? jokerUsageRaw :
        (jokerUsageRaw && Array.isArray(jokerUsageRaw.usage)) ? jokerUsageRaw.usage : [];
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

module.exports = { JOKER_CONFIG, createInitialJokersStock, createJokersRoutes };