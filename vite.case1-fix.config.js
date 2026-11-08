// Case 1 — Vite user workaround.
// Identical entry and settings as case 2, plus one post-build asset filter.
import { fileURLToPath } from 'node:url';
import { dropUnreferencedQuickjsWasm } from './plugins/drop-unreferenced-quickjs-wasm.mjs';

const page = name => fileURLToPath(new URL(`./case1-fix/${name}`, import.meta.url));

export default {
  root: 'case1-fix',
  // @gamealgo/web 2.x runs QuickJS inside an ES module worker.
  worker: { format: 'es' },
  plugins: [dropUnreferencedQuickjsWasm()],
  build: {
    outDir: '../dist/case1-fix',
    emptyOutDir: true,
    rollupOptions: { input: { index: page('index.html'), sandbox: page('sandbox.html') } },
  },
};
