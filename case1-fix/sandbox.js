// Forces the QuickJS worker to spin up, so the retained wasm is actually fetched and used.
import { GameAlgoWebScriptRuntime } from '@gamealgo/web';

const runtime = new GameAlgoWebScriptRuntime({ prepareTimeoutMs: 10000, executionTimeoutMs: 10000 });
const script = 'function execute(input) { return { ok: true, doubled: input.n * 2 }; }';

try {
  await runtime.prepare(script);
  window.sandboxResult = await runtime.execute(script, { n: 21 });
} catch (error) {
  window.sandboxError = String(error?.message ?? error);
} finally {
  runtime.close();
}
