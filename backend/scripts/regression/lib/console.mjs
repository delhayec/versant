/**
 * ============================================
 * VERSANT - HARNAIS : CAPTURE DE LA CONSOLE
 * ============================================
 * Le code testé journalise beaucoup (gel, moteur). Ces messages ne font pas
 * partie du résultat comparé : on les met de côté pour le journal d'exécution.
 */

const LEVELS = ['log', 'info', 'warn', 'error', 'debug', 'group', 'groupCollapsed', 'groupEnd', 'table'];

export function captureConsole(prefix) {
  const original = {};
  const lines = [];
  for (const level of LEVELS) {
    original[level] = console[level];
    console[level] = (...args) => {
      const text = args.map(a => (typeof a === 'string' ? a : safeJson(a))).join(' ');
      lines.push(`[${prefix}] ${level}: ${text}`);
    };
  }
  return {
    lines,
    restore() {
      for (const level of LEVELS) console[level] = original[level];
    }
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
