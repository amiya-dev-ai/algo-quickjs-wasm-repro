# @gamealgo/web — QuickJS wasm 冗余最小复现

`@gamealgo/web`（测试版本 `1.0.22` 与 `2.1.2`，npm latest）在 Vite/Rollup 生产构建中会产出
**4 份 QuickJS wasm，共 4.26MB**，而运行时只会请求其中 1 份（`release-sync`，0.50MB）。
另外 3 份（**3.76MB**，含 2 份 debug 版）没有任何 chunk 引用，属于纯包体死重。

本仓库只做两件事：

| 目录 / 文件 | 作用 |
|---|---|
| `case2-repro/` | **复现 demo**：普通 Vite 生产构建，不做任何处理，产出 4 份 wasm |
| `case1-fix/` + `plugins/drop-unreferenced-quickjs-wasm.mjs` | **Vite 用户解决方案**：同一个入口，仅多一个构建后过滤插件，产出 1 份 wasm |
| `scripts/verify.mjs` | 构建两个 case，统计并断言 wasm 数量、大小、引用关系 |
| `scripts/smoke.mjs` | 用 headless Chromium 真正跑一次 QuickJS 沙箱，记录实际请求的 wasm |

两个 case 的入口代码完全相同（`main.js` 只 `new GameAlgoWebClient(...)`，`sandbox.js` 只跑一段
QuickJS 脚本），差异只有 `vite.*.config.js`。

## 运行

```bash
npm install
npm run verify   # 构建 + 静态断言，打印两份产物对比
npm run smoke    # 可选：headless Chromium 实跑 QuickJS 沙箱（需要本机有 chromium-browser）
```

环境：Node 24 / Vite 7.3.7 / `@gamealgo/web` 2.1.2 / `quickjs-emscripten` 0.32.0。

> 2.x 的 QuickJS 跑在 ES module worker 里，Vite 必须配 `worker: { format: 'es' }`，否则构建直接报
> `Invalid value "iife" for option "worker.format"`。两个 case 的配置都已包含。

## 实测输出

```
=== case2-repro ===
  used   emscripten-module-uFzwHH0Y.wasm  0.50MB  release-sync
  dead   emscripten-module-B1g2L2eS.wasm  1.03MB  release-asyncify
  dead   emscripten-module-ZrHFMo7O.wasm  1.22MB  debug-sync
  dead   emscripten-module-DHbYPfAp.wasm  1.51MB  debug-asyncify
  wasm files: 4 / total 4.26MB / unreferenced 3.76MB / js 0.14MB

=== case1-fix ===
  used   emscripten-module-uFzwHH0Y.wasm  0.50MB  release-sync
  wasm files: 1 / total 0.50MB / unreferenced 0.00MB / js 0.14MB

package size recovered by case 1: 3.76MB
✓ reproduction and workaround behave as documented
```

`npm run smoke` 两个 case 都通过，且都只请求一份 wasm：

```
sandbox result: {"ok":true,"doubled":42}
wasm requests (server log):
  /assets/emscripten-module-uFzwHH0Y.wasm
✓ case2-repro runtime smoke passed
✓ case1-fix runtime smoke passed
```

## 根因

1. `@gamealgo/web/dist/web/src/quickjs-sandbox.js:1` 从根本身导入：
   ```ts
   import { getQuickJS } from "quickjs-emscripten";
   ```
2. `quickjs-emscripten` 的入口把所有变体一次性静态引入（`dist/chunk-OHAYRCBA.mjs`）：
   ```js
   import DEBUG_SYNC from "@jitl/quickjs-wasmfile-debug-sync";
   import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
   import DEBUG_ASYNC from "@jitl/quickjs-wasmfile-debug-asyncify";
   import RELEASE_ASYNC from "@jitl/quickjs-wasmfile-release-asyncify";
   ```
3. 每个变体通过 `new URL('emscripten-module.wasm', import.meta.url)` 声明自己的 wasm。
   Vite 在 transform 阶段就 `emitFile` 并改写 URL，**资产不参与 tree-shaking**，所以即使未使用
   变体的 glue JS 被摇掉，wasm 仍然会被写进 `dist`。
4. `@gamealgo/web` 只用同步路径 `getQuickJS()` → `newQuickJSWASMModule()` → `RELEASE_SYNC`，
   全量 grep 不到 `RELEASE_ASYNC` / `DEBUG_*` / `newQuickJSAsyncWASMModule` 的使用。

上游修复建议见仓库 issue 稿（`quickjs-emscripten-core` + 单变体，不再经过根入口）。

## case 1：Vite 用户侧的临时方案

`plugins/drop-unreferenced-quickjs-wasm.mjs` 在 `closeBundle` 阶段扫描产物里所有 `.js`，
删掉没有任何文件按文件名引用的 `emscripten-module-*.wasm`。

几点实现约束（踩过的坑，改动时别退回去）：

- **不能写死 hash**：保留哪份由「产物里有没有引用」决定，SDK 换版本或改用 async 变体时不会误删。
- **不能在 `generateBundle` 判定**：此时 Vite 的内部 `__VITE_ASSET__…__` 占位符还没替换成最终文件名，
  会误判成「全部未引用」。
- **`closeBundle` 里要按 `root` 解析 `build.outDir`**：`config.build.outDir` 是相对路径
  （如 `../dist/case1-fix`），直接用 `fs` 会找不到目录。
- 插件是幂等的，worker 子构建和主构建各跑一次也不会出错。

它只删除文件，不改变任何运行时请求路径：SDK 真正需要的 wasm 文件名出现在请求它的 JS 里，因此一定保留。

## 局限

- 这是下游兜底，不能替代 SDK 修复：其他使用方不一定有条件加插件。
- `smoke.mjs` 直接驱动 SDK 导出的 `GameAlgoWebScriptRuntime` 来触发 QuickJS，因为真实策略脚本需要
  有效平台凭证；它证明「保留的 wasm 可用、删除的 wasm 从未被请求」，不覆盖 `prepare`/`execute`
  在真实策略下的业务行为。
