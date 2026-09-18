import { useSyncExternalStore } from 'react';

/**
 * Light or dark, as the `data-theme` attribute on <html> — every light rule in the CSS keys off it.
 * index.html sets it before the first paint (so the page never flashes the wrong theme); from then
 * on this module owns it. A viewer's own pick is remembered; until they pick, it follows the system.
 */

export type Theme = 'light' | 'dark';

const KEY = 'vy-theme';
const listeners = new Set<() => void>();
const systemLight = () => window.matchMedia?.('(prefers-color-scheme: light)');

function saved(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function apply(t: Theme) {
  if (getTheme() === t && document.documentElement.dataset.theme) return;
  document.documentElement.dataset.theme = t;
  listeners.forEach((l) => l());
}

export function setTheme(t: Theme) {
  try { localStorage.setItem(KEY, t); } catch { /* the pick just won't outlive the tab */ }
  apply(t);
}

// No pick yet: track the system theme live, as the page did before the toggle existed.
systemLight()?.addEventListener('change', (e) => { if (!saved()) apply(e.matches ? 'light' : 'dark'); });
if (!document.documentElement.dataset.theme) apply(saved() ?? (systemLight()?.matches ? 'light' : 'dark'));

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme);
}
