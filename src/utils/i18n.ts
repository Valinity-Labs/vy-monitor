/**
 * English or Spanish, decided once when the page opens:
 *
 *   1. `?lang=es` / `?lang=en` in the URL — how the Valinity web app passes the language its user
 *      picked (the monitor is embedded from another origin, so it cannot read the app's setting);
 *   2. otherwise the browser's own language — any `es-*` gets Spanish.
 *
 * Fixed for the life of the page, so `tr` is a plain function: it works in render code and in the
 * data code that builds row labels alike, and nothing has to re-render on a switch. The web app
 * changes the language by reloading the frame with a new `lang`.
 *
 * Spanish follows the web app's own wording (Préstamo, Deuda, Garantía, Suministro Circulante,
 * Pool de Liquidez, Billetera, informal "tú"). Numbers keep the en-US format everywhere — the
 * figures read the same as on-chain tools and the web app's balances; dates are localized.
 */

export type Lang = 'en' | 'es';

function detect(): Lang {
  try {
    const q = new URLSearchParams(window.location.search).get('lang')?.toLowerCase();
    if (q?.startsWith('es')) return 'es';
    if (q?.startsWith('en')) return 'en';
  } catch { /* no URL to read */ }
  const nav = typeof navigator !== 'undefined' ? (navigator.languages?.[0] ?? navigator.language) : '';
  return nav?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export const LANG: Lang = detect();

if (typeof document !== 'undefined') document.documentElement.lang = LANG;

/** The text in the page's language: `tr('Price', 'Precio')`. */
export const tr = (en: string, es: string): string => (LANG === 'es' ? es : en);

/** Locale for DATES (month names). Numbers stay en-US — see the module header. */
export const DATE_LOCALE = LANG === 'es' ? 'es-CO' : 'en-US';
