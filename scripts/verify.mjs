#!/usr/bin/env node
// Builds both cases and compares the emitted QuickJS wasm.
// Fails if case 1 (workaround) does not end up with exactly one, referenced, wasm.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const cases = [
  { id: 'case2-repro', config: 'vite.case2-repro.config.js', expect: 4 },
  { id: 'case1-fix', config: 'vite.case1-fix.config.js', expect: 1 },
];

function build(config) {
  execFileSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '-c', config], {
    cwd: root,
    stdio: 'inherit',
  });
}

function analyse(caseId) {
  const assets = path.join(root, 'dist', caseId, 'assets');
  const files = fs.readdirSync(assets);
  const chunks = files.filter(name => name.endsWith('.js'));
  const code = chunks.map(name => fs.readFileSync(path.join(assets, name), 'utf8')).join('\n');
  const wasm = files
    .filter(name => /^emscripten-module-[\w-]+\.wasm$/.test(name))
    .map(name => ({
      name,
      bytes: fs.statSync(path.join(assets, name)).size,
      referenced: code.includes(name),
    }))
    .sort((a, b) => a.bytes - b.bytes);
  return { wasm, chunkBytes: chunks.reduce((sum, name) => sum + fs.statSync(path.join(assets, name)).size, 0) };
}

// Map each emitted wasm back to the variant package it came from, so the report names it.
function variantIndex() {
  const index = new Map();
  const base = path.join(root, 'node_modules/@jitl');
  if (!fs.existsSync(base)) return index;
  for (const dir of fs.readdirSync(base)) {
    const file = path.join(base, dir, 'dist/emscripten-module.wasm');
    if (!fs.existsSync(file)) continue;
    index.set(createHash('md5').update(fs.readFileSync(file)).digest('hex'), dir.replace('quickjs-wasmfile-', ''));
  }
  return index;
}

const bytes = n => `${(n / 1_000_000).toFixed(2)}MB`;
const variant = variantIndex();

for (const entry of cases) build(entry.config);

let failed = false;
for (const entry of cases) {
  const { wasm, chunkBytes } = analyse(entry.id);
  const total = wasm.reduce((sum, item) => sum + item.bytes, 0);
  const dead = wasm.filter(item => !item.referenced).reduce((sum, item) => sum + item.bytes, 0);
  console.log(`\n=== ${entry.id} ===`);
  for (const item of wasm) {
    const md5 = createHash('md5').update(fs.readFileSync(path.join(root, 'dist', entry.id, 'assets', item.name))).digest('hex');
    const name = variant.get(md5) ?? 'unknown-variant';
    console.log(`  ${item.referenced ? 'used  ' : 'dead  '} ${item.name}  ${bytes(item.bytes)}  ${name}`);
  }
  console.log(`  wasm files: ${wasm.length} / total ${bytes(total)} / unreferenced ${bytes(dead)} / js ${bytes(chunkBytes)}`);

  if (wasm.length !== entry.expect) {
    console.error(`  ✗ expected ${entry.expect} wasm, got ${wasm.length}`);
    failed = true;
  }
  if (entry.id === 'case1-fix' && wasm.some(item => !item.referenced)) {
    console.error('  ✗ case1-fix still ships unreferenced wasm');
    failed = true;
  }
  if (entry.id === 'case2-repro' && !wasm.some(item => !item.referenced)) {
    console.error('  ✗ case2-repro did not reproduce: everything is referenced');
    failed = true;
  }
}

const repro = analyse('case2-repro');
const fix = analyse('case1-fix');
const saved = repro.wasm.reduce((s, i) => s + i.bytes, 0) - fix.wasm.reduce((s, i) => s + i.bytes, 0);
console.log(`\npackage size recovered by case 1: ${bytes(saved)}`);

if (failed) process.exit(1);
console.log('✓ reproduction and workaround behave as documented');
