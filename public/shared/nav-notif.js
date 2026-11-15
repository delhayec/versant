/**
 * Pastille du lien Dashboard (#dashboardBadge), pour le joueur connecté
 * seulement : bonus des éliminés à choisir ou à jouer, ou nouvelle édition
 * à confirmer. Lecture seule.
 */
(function () {
  async function check() {
    const badge = document.getElementById('dashboardBadge');
    let token = null;
    try { token = localStorage.getItem('versant_token'); } catch { /* stockage bloqué */ }
    if (!badge || !token) return;
    const show = (text, title) => {
      badge.textContent = text;
      badge.title = title;
      badge.setAttribute('aria-label', title);
      badge.style.display = 'inline-flex';
    };
    const get = async url => {
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      return res.ok ? res.json() : null;
    };
    try {
      const [choices, my, me] = await Promise.all([
        get('/api/bonuses/choices').catch(() => null),
        get('/api/bonuses/my').catch(() => null),
        get('/api/me').catch(() => null)
      ]);
      if (choices?.hasChoice) return show('🎁', 'Tu as un bonus à choisir !');
      if (my?.bonus?.status === 'available') return show('!', 'Tu as un bonus à jouer !');
      if ((me?.editionsToConfirm?.length || 0) > 0) return show('!', 'Nouvelle édition : confirme ta participation !');
      badge.style.display = 'none';
    } catch (err) {
      console.warn('Erreur vérification notifications:', err);
      badge.style.display = 'none';
    }
  }
  window.versantDashboardNotif = check;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else check();
})();
