/**
 * Case 1 — drop-in Vite workaround.
 *
 * `quickjs-emscripten` re-exports 4 variants (debug/release × sync/asyncify) from its root
 * entry, and every variant ships its own `emscripten-module.wasm` through
 * `new URL('emscripten-module.wasm', import.meta.url)`. Vite emits those assets while
 * transforming modules — before tree-shaking runs — so unused variants still land in `dist`.
 *
 * This plugin deletes any `emscripten-module-*.wasm` asset that no written JS file refers to
 * by file name. Nothing is hardcoded: whichever variant the bundle really requests at runtime
 * stays, because its file name appears in the JS that requests it.
 *
 * It runs in `closeBundle`, i.e. after Vite (including the nested worker build) has written
 * every chunk and has replaced its internal `__VITE_ASSET__…__` placeholders with the final
 * hashed file names. It is idempotent, so running per build is harmless.
 */
import fs from 'node:fs';
import path from 'node:path';

const wasmRE = /^emscripten-module-[\w-]+\.wasm$/;

function walk(dir) {
  const entries = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) entries.push(...walk(full));
    else entries.push(full);
  }
  return entries;
}

export function dropUnreferencedQuickjsWasm() {
  let outDir;
  return {
    name: 'drop-unreferenced-quickjs-wasm',
    apply: 'build',
    configResolved(config) {
      // `build.outDir` stays relative here; it is resolved against `root` at build time.
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (!outDir || !fs.existsSync(outDir)) return;
      const files = walk(outDir);
      const code = files
        .filter(file => file.endsWith('.js'))
        .map(file => fs.readFileSync(file, 'utf8'))
        .join('\n');

      for (const file of files) {
        const base = path.basename(file);
        if (!wasmRE.test(base)) continue;
        if (code.includes(base)) continue;
        fs.rmSync(file, { force: true });
        this.warn(`dropped unreferenced QuickJS wasm: ${path.relative(outDir, file)}`);
      }
    },
  };
}
