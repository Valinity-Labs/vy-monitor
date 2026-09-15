#!/usr/bin/env node
/**
 * TRADINGVIEW LIBRARY — downloads Advanced Charts into public/charting_library/ for the build.
 *
 * The library is licensed to Valinity and this repository is PUBLIC, so it is never committed
 * here. app.valinity.io already serves the exact same files (the web app's deploy-prod build), so
 * the build copies them from there — no credentials involved — and checks EVERY file against the
 * SHA-256 list in scripts/charting_library.sha256. Anything missing or different fails the build,
 * so a changed or tampered file can never reach the monitor. Files are written to a temporary
 * folder and only moved into place once all of them have verified.
 *
 * When the web app upgrades TradingView, regenerate the list from its public/charting_library:
 *   node scripts/fetch-charting-library.mjs --write-manifest <path-to-charting_library>
 *
 *   node scripts/fetch-charting-library.mjs [--out <dir>]
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'scripts/charting_library.sha256');
const SOURCE = 'https://app.valinity.io/charting_library/';
const CONCURRENCY = 16;

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ── Regenerate the list (maintainers only) ──────────────────────────────────
if (argv.includes('--write-manifest')) {
  const dir = resolve(arg('--write-manifest'));
  const walk = (d) => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const lines = walk(dir)
    .map((p) => ({ hash: sha256(readFileSync(p)), path: relative(dir, p).split('\\').join('/') }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((e) => `${e.hash}  ${e.path}`);
  writeFileSync(MANIFEST, lines.join('\n') + '\n');
  console.log(`wrote ${MANIFEST} — ${lines.length} files`);
  process.exit(0);
}

// ── Download and verify ─────────────────────────────────────────────────────
const OUT = resolve(ROOT, arg('--out') ?? 'public/charting_library');
const TMP = `${OUT}.partial`;
const entries = readFileSync(MANIFEST, 'utf8').trim().split('\n')
  .map((line) => ({ hash: line.slice(0, 64), path: line.slice(66) }));

rmSync(TMP, { recursive: true, force: true });
const failed = [];
let next = 0;

await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (;;) {
    const e = entries[next++];
    if (!e) return;
    const url = SOURCE + e.path.split('/').map(encodeURIComponent).join('/');
    let body;
    for (let attempt = 0; attempt < 4 && !body; attempt++) {
      try {
        const res = await fetch(url);
        if (res.ok) body = Buffer.from(await res.arrayBuffer());
        else if (res.status === 404) break;
      } catch { /* network blip — retried */ }
      if (!body) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    if (!body) { failed.push(`missing  ${e.path}`); continue; }
    if (sha256(body) !== e.hash) { failed.push(`CHANGED  ${e.path}`); continue; }
    mkdirSync(dirname(join(TMP, e.path)), { recursive: true });
    writeFileSync(join(TMP, e.path), body);
  }
}));

if (failed.length) {
  rmSync(TMP, { recursive: true, force: true });
  console.error(`TradingView library NOT installed — ${failed.length} of ${entries.length} files failed verification:`);
  for (const f of failed.slice(0, 20)) console.error(`  ${f}`);
  console.error('If the web app upgraded TradingView, regenerate scripts/charting_library.sha256 (see header).');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
renameSync(TMP, OUT);
console.log(`TradingView library installed: ${entries.length} files from ${SOURCE}, every SHA-256 verified`);
