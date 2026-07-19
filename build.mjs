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

// Store packaging: drop the http://localhost + http://127.0.0.1 dev channels from
// externally_connectable, so a *published* item can only be driven by https://autogasto.app
// and never by an arbitrary local page. Source keeps them for `node build.mjs` dev loads.
const STORE = process.env.STORE === '1' || process.argv.includes('--store');

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

/* Build the manifest: substitute the origin, then in STORE mode keep only https
 * externally_connectable matches (drops the localhost/127.0.0.1 dev origins). */
function buildManifest(origin) {
  const src = readFileSync(join(HERE, 'manifest.json'), 'utf8').split(PLACEHOLDER).join(origin);
  const manifest = JSON.parse(src);
  if (STORE) {
    const matches = manifest.externally_connectable?.matches || [];
    manifest.externally_connectable.matches = matches.filter((m) => m.startsWith('https://'));
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

const origin = resolveOrigin();
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'icons'), { recursive: true });

// Files that carry the placeholder — substituted.
buildManifest(origin);
inject('background.js', origin);
// Files copied verbatim.
for (const f of ['dom-inject.js', 'README.md']) copyFileSync(join(HERE, f), join(OUT, f));
for (const f of ['pwa-16.png', 'pwa-32.png', 'pwa-48.png', 'pwa-128.png', 'pwa-192.png', 'pwa-512.png']) {
  copyFileSync(join(HERE, 'icons', f), join(OUT, 'icons', f));
}

console.log(`Built extension-min/build with origin ${origin}${STORE ? ' (store: localhost stripped)' : ' (dev)'}`);
