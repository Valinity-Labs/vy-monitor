/**
 * The longest the page stays behind its loading screen. Past this it shows what it has — the price
 * chart from the bundled snapshot, the balance sheet's own progress — rather than covering a slow
 * or failed RPC forever.
 */
export const LOAD_LIMIT_MS = 20_000;
