# Patchwork test harness

Real browsers (Chromium, Firefox, WebKit) drive a local Patchwork site against a local [Subduction](https://github.com/inkandswitch/subduction) server. Nothing leaves the machine, and every test fails if anything tries to. Findings and browser viability: [research/05-sandboxing.md](../../research/05-sandboxing.md#test-harness).

## Usage

```sh
nix develop
pnpm install
pnpm test:e2e                      # builds the site, the CAD tool and research/16's tldraw tool, then runs every browser
pnpm test:e2e --project=firefox    # arguments go to `playwright test`
CAD_MEASURE=1 pnpm test:e2e --workers=1 cad-measure cad-pushwork   # timings for research/06
CAD_MEASURE=1 pnpm test:e2e --workers=1 cad-measure-features      # rebuild timings for research/07
```

`pnpm dev` (from the repo root, `dev.ts`) runs the same stack for manual use: fixed ports (site 4173, Subduction 4174; `PATCHWORK_DEV_PORT`, `PATCHWORK_DEV_SUBDUCTION_PORT`), Subduction's storage and key in `<repo>/.dev/`, so documents survive restarts, and every tool given as `<name>=<dir>` (the CAD tool, `src/cad`) rebuilt by `vite build --watch` and served as a static module. Reload the page after a rebuild.

`nix develop` provides `subduction_cli` and Playwright's browsers (`PLAYWRIGHT_BROWSERS_PATH`). They come from Patchwork's own nixpkgs, which matches the pinned `@playwright/test` 1.59.1.

## Layout

- `site/`: a minimal copy of [patchwork.inkandswitch.com](https://github.com/inkandswitch/patchwork.inkandswitch.com). The base modules are served same-origin from `@inkandswitch/patchwork-pkg-base`. The build replaces the remote URLs hardcoded in them (`REMOTE_URLS` in `vite.config.ts`) and fails if one disappears in an upgrade. Both sync-server URLs are compiled in as sentinels (`sentinels.ts`).
- `e2e/stack.ts`: starts `subduction_cli` and the site server, by default on free ports with fresh storage. It serves a copy of `dist/` with the sentinels replaced by the local Subduction server and by a local sink that counts connections to the classic sync server, which nothing serves.
- `e2e/server.ts`: the site server, in place of `vite preview`, with the same CORS and immutable-asset headers. It also serves tool packages live as static modules (`/packages/<name>/`, appended to `/modules.json`), so they are installed for every account without pushwork, and it logs every request.
- `e2e/egress.ts`: an HTTP proxy that records and refuses every request. Each browser context uses it, and loopback bypasses it, so every non-local request from every page and worker ends up here.
- `e2e/network-log.ts`: what Playwright reports per context, for attribution. Its coverage differs per browser (see 05), so the egress sink is what proves that nothing left.
- `e2e/modules.ts`: publishes a tool directory with the pinned `pushwork` to the local server (`PUSHWORK_SUBDUCTION_SERVER`) and registers its URL in an account's module-settings doc, as the Packages UI does.
- `e2e/ui.ts`: UI helpers for the threepane frame and CodeMirror.

## Fixtures (`e2e/fixtures.ts`)

| fixture | scope | |
|---|---|---|
| `siteModules` | worker option | tool directories the site serves as static modules, e.g. `test.use({ siteModules: CAD_MODULES })` |
| `localStack` | worker | Subduction and the site, once per worker; also sets `baseURL` |
| `users(n)` | test | n independent browser profiles (contexts), each with its own `networkLog` |
| `installModule(dir, ...users)` | test | publishes `dir` (once per worker) and registers it with each booted user |
| `egress` | test, automatic | the egress sink; the test fails on any attempt unless it sets `test.use({ egressAllowed: true })` |
| `networkLog` | test | Playwright's log for the default context; non-local entries fail the test |

## Caveats

- **Traces are off.** Saving a Playwright trace of a booted Patchwork page stalls until the test timeout, even with plain Playwright fixtures and a passing test. A trace written with `--trace on` therefore costs the full timeout per test.
- **Modifier keys:** the desktop Chrome and Firefox devices emulate `navigator.platform = "Win32"`, so CodeMirror's `Mod` is Ctrl there. Playwright's `ControlOrMeta`, however, follows the host OS. Use `pressMod()` from `ui.ts`.
- **No `fetch` in harness code:** Node's built-in `fetch` (undici) threw one uncaught `setTypeOfService EINVAL` in 150 test runs on macOS, which could not be reproduced. The readiness check uses `node:http` instead.
- **Firefox on macOS 27** hangs in `browserType.launch` until the timeout: it resolves its app-data directory to `~/Library/Application Support/Firefox`, which macOS 27 protects with TCC ([microsoft/playwright#42768](https://github.com/microsoft/playwright/issues/42768), "Fixed upstream in Firefox 158"). The logged `sandbox_extension_issue_file_to_process … Operation not permitted` and `RenderCompositorSWGL failed mapping default framebuffer` are unrelated. `e2e/firefox.ts` sets `CFFIXED_USER_HOME` to an empty directory for every Firefox launch, which avoids it. Remove it once Playwright ships Firefox 158 or later.
- **Caches differ from real browsers.** Default (off-the-record) contexts in Chromium don't keep a 23 MB response in the HTTP cache, while smaller immutable assets stay cached. WebKit keeps it in neither kind of context, and in persistent contexts (`launchPersistentContext`) its Cache API stores nothing: a `put` of `new Response("hello")` is not found by the next `match`. Warm-load measurements therefore use both kinds (`cad-measure.spec.ts`).
- No retries: every failure has to be explained, not retried away.
- pnpm 11.9 on Node 24.16 occasionally aborts with a libuv assertion (`uv__io_poll`) after an install has finished; the installed result is unaffected.
