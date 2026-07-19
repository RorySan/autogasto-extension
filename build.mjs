/* Produce a loadable/packable extension from the tracked source by injecting the real
 * expenses-portal origin into the __PORTAL_ORIGIN__ placeholder.
 *
 * The tracked source is deliberately origin-free so the repo can be public. The origin
 * comes from (in order) the PORTAL_ORIGIN env var, or the gitignored `portal-origin.local`
 * file next to this script. Output goes to ./build, which is what you load unpacked and
 * zip for the store.
 *
 *   node build.mjs                 # origin from portal-origin.local
 *   PORTAL_ORIGIN=https://… node build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'build');
const PLACEHOLDER = '__PORTAL_ORIGIN__';

function resolveOrigin() {
  let origin = process.env.PORTAL_ORIGIN;
  if (!origin) {
    try {
      origin = readFileSync(join(HERE, 'portal-origin.local'), 'utf8').trim();
    } catch {
      throw new Error(
        'No portal origin: set PORTAL_ORIGIN or create extension-min/portal-origin.local');
    }
  }
  origin = origin.trim().replace(/\/+$/, ''); // no trailing slash
  if (!/^https:\/\/[^/*\s]+$/.test(origin)) {
    throw new Error(`Portal origin must be a bare https origin, got: ${origin}`);
  }
  return origin;
}

function inject(name, origin) {
  const src = readFileSync(join(HERE, name), 'utf8');
  writeFileSync(join(OUT, name), src.split(PLACEHOLDER).join(origin));
}

const origin = resolveOrigin();
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'icons'), { recursive: true });

// Files that carry the placeholder — substituted.
inject('manifest.json', origin);
inject('background.js', origin);
// Files copied verbatim.
for (const f of ['dom-inject.js', 'README.md']) copyFileSync(join(HERE, f), join(OUT, f));
for (const f of ['pwa-192.png', 'pwa-512.png']) {
  copyFileSync(join(HERE, 'icons', f), join(OUT, 'icons', f));
}

console.log(`Built extension-min/build with origin ${origin}`);
