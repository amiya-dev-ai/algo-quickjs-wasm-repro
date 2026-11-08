#!/usr/bin/env node
// Runtime smoke test for case 1 (the workaround).
//
// Serves dist/case1-fix, opens sandbox.html in headless Chromium and lets the SDK's QuickJS
// worker run one script. It asserts that:
//   - the script really executed inside QuickJS (so the retained wasm is functional)
//   - the only .wasm ever requested is the retained release-sync build (no 404, no other variant)
//
// Real strategy execution needs platform credentials, so the sandbox is driven directly
// through the exported GameAlgoWebScriptRuntime instead of through a config response.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const caseName = process.argv[2] ?? 'case1-fix';
const dist = path.join(root, 'dist', caseName);
const port = 5277;
const cdpPort = 9333;
const keptWasm = /emscripten-module-uFzwHH0Y\.wasm$/;

if (!fs.existsSync(dist)) {
  console.error(`dist/${caseName} missing — run the matching build first`);
  process.exit(1);
}

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.css', 'text/css; charset=utf-8'],
]);

// Minimal stand-in for the GameAlgo backend so the client can initialise without real
// credentials. Nothing is tracked; these responses only keep the SDK quiet.
const fakeConfig = {
  contextId: 'repro',
  gameId: 'repro',
  environment: 'production',
  configVersion: 'repro',
  ttlSeconds: 60,
  serverTime: new Date().toISOString(),
  experiments: [],
  configFiles: [],
};

const requests = [];
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  res.setHeader('cache-control', 'no-store');
  requests.push(url);
  if (url === '/favicon.ico') return res.writeHead(204).end();
  if (url.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(url.endsWith('/config') ? fakeConfig : { ok: true, accepted: 0 }));
    return;
  }
  const file = path.join(dist, url === '/' ? 'index.html' : url);
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': mime.get(path.extname(file)) ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function json(pathname) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}${pathname}`);
  return response.json();
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, message => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(listener) {
    this.listeners.add(listener);
  }
  close() {
    this.ws.close();
  }
}

const chromium = spawn(
  'chromium-browser',
  [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=/tmp/chrome-cdp-algo-repro',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=844,390',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let exitCode = 1;
try {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

  let target;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      target = (await json('/json/version')).webSocketDebuggerUrl;
      if (target) break;
    } catch {
      await sleep(200);
    }
  }
  if (!target) throw new Error('chromium CDP endpoint never came up');

  const page = (await json('/json/list')).find(item => item.type === 'page');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();

  const exceptions = [];
  cdp.on(message => {
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      exceptions.push(details.text + ': ' + (details.exception?.description ?? ''));
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/sandbox.html` });

  const evaluate = expression => cdp.send('Runtime.evaluate', { expression, returnByValue: true });

  let outcome;
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(500);
    const { result } = await evaluate('JSON.stringify({ ok: window.sandboxResult ?? null, error: window.sandboxError ?? null })');
    outcome = JSON.parse(result.value);
    if (outcome.ok || outcome.error) break;
  }
  cdp.close();

  console.log(`sandbox result: ${JSON.stringify(outcome?.ok)}`);
  if (outcome?.error) console.log(`sandbox error: ${outcome.error}`);
  const wasm = [...new Set(requests.filter(url => url.endsWith('.wasm')))];
  console.log(`page exceptions: ${exceptions.length ? JSON.stringify(exceptions) : 'none'}`);
  console.log(`wasm requests (server log): ${wasm.length ? '' : 'none'}`);
  for (const url of wasm) console.log(`  ${url}`);

  const executed = outcome?.ok?.ok === true && outcome.ok.doubled === 42;
  const onlyKept = wasm.length > 0 && wasm.every(url => keptWasm.test(url));
  if (!executed || !onlyKept || exceptions.length) {
    console.error(`✗ ${caseName} runtime smoke failed`);
  } else {
    console.log(`✓ ${caseName} runtime smoke passed`);
    exitCode = 0;
  }
} catch (error) {
  console.error(`✗ ${error.message}`);
} finally {
  server.close();
  chromium.kill('SIGKILL');
  process.exit(exitCode);
}
