import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { execSync } from 'node:child_process';
import { createReadStream, readFileSync } from 'node:fs';
import { extname } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
let sha = 'dev';
try {
  sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {}
const builtAt = new Date().toISOString();
const version = `v${pkg.version}-${sha}-${builtAt.slice(0, 16).replace(/[-:T]/g, '')}`;

// Test photos are not duplicated in the repo: the 12/48 MP samples come from the
// Stage 0 bench, the 1K reference photos from the unit-test fixtures.
const SHARED: Record<string, URL> = {
  'samples/synth_12mp.jpg': new URL('../stage0-bench/public/samples/synth_12mp.jpg', import.meta.url),
  'samples/synth_12mp.heic': new URL('../stage0-bench/public/samples/synth_12mp.heic', import.meta.url),
  'samples/synth_48mp.jpg': new URL('../stage0-bench/public/samples/synth_48mp.jpg', import.meta.url),
  'samples/synth_48mp.heic': new URL('../stage0-bench/public/samples/synth_48mp.heic', import.meta.url),
  ...Object.fromEntries(['stilllife', 'landscape', 'flash', 'portrait'].map((n) => [
    `fixtures/${n}_1k.png`, new URL(`./test/fixtures/${n}_1k.png`, import.meta.url),
  ])),
};
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.heic': 'image/heic', '.png': 'image/png' };

function sharedFiles(): Plugin {
  return {
    name: 'engine-shared-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const key = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''));
        const src = SHARED[key];
        if (!src) return next();
        res.setHeader('Content-Type', MIME[extname(key)] ?? 'application/octet-stream');
        createReadStream(src).pipe(res);
      });
    },
    generateBundle() {
      for (const [fileName, src] of Object.entries(SHARED)) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(src) });
      }
    },
  };
}

// Files cached on install, besides the build's own assets. The 12/48 MP samples are big:
// they are cached on first use instead.
const PUBLIC_PRECACHE = ['./', 'manifest.webmanifest', 'icon-192.png', 'apple-touch-icon.png', 'art-paints.json'];

/** Emits sw.js with the precache list of this build. */
function serviceWorker(): Plugin {
  return {
    name: 'engine-service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const assets = Object.keys(bundle).filter((f) => f !== 'index.html' && !f.endsWith('.map') && !f.startsWith('samples/'));
      const src = readFileSync(new URL('./dev/sw.js', import.meta.url), 'utf8')
        .replace('__ENGINE_VERSION__', version)
        .replace('self.__PRECACHE__', JSON.stringify([...PUBLIC_PRECACHE, ...assets]));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [svelte(), sharedFiles(), serviceWorker()],
  define: {
    __ENGINE_VERSION__: JSON.stringify(version),
  },
  worker: { format: 'es' },
  build: { target: ['safari16', 'es2022'], sourcemap: false },
});
