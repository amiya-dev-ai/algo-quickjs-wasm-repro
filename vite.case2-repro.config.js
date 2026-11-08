// Case 2 — reproduction, no workaround.
// Production build that mirrors a normal Vite setup: 4 QuickJS wasm are emitted,
// 3 of them are never referenced by any chunk.
import { fileURLToPath } from 'node:url';

const page = name => fileURLToPath(new URL(`./case2-repro/${name}`, import.meta.url));

export default {
  root: 'case2-repro',
  worker: { format: 'es' },
  build: {
    outDir: '../dist/case2-repro',
    emptyOutDir: true,
    rollupOptions: { input: { index: page('index.html'), sandbox: page('sandbox.html') } },
  },
};
