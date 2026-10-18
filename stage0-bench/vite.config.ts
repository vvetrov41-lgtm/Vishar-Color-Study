import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
let sha = 'dev';
try {
  sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {}
const builtAt = new Date().toISOString();
const version = `v${pkg.version}-${sha}-${builtAt.slice(0, 16).replace(/[-:T]/g, '')}`;

// Small public files that must work offline. The 12/48 MP samples are cached
// by the Service Worker on first use instead.
const PUBLIC_PRECACHE = [
  './',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'samples/probe.jpg',
  'samples/probe.png',
  'samples/probe.webp',
  'samples/probe.heic',
  'samples/orient6.jpg',
];

/** Emits sw.js with the precache list of this build. */
function serviceWorker(): Plugin {
  return {
    name: 'bench-service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const assets = Object.keys(bundle).filter((f) => f !== 'index.html' && !f.endsWith('.map'));
      const src = readFileSync(new URL('./src/sw.js', import.meta.url), 'utf8')
        .replace('__BENCH_VERSION__', version)
        .replace('self.__PRECACHE__', JSON.stringify([...PUBLIC_PRECACHE, ...assets]));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [svelte(), serviceWorker()],
  define: {
    __BENCH_VERSION__: JSON.stringify(version),
    __BENCH_BUILT_AT__: JSON.stringify(builtAt),
  },
  worker: { format: 'es' },
  build: { target: ['safari16', 'es2022'], sourcemap: false },
});
