# Patchwork test harness

Real browsers (Chromium, Firefox, WebKit) drive a local Patchwork site against a local [Subduction](https://github.com/inkandswitch/subduction) server. Nothing leaves the machine, and every test fails if anything tries to. Findings and browser viability: [research/05-sandboxing.md](../../research/05-sandboxing.md#test-harness).

## Usage

```sh
nix develop
pnpm install
pnpm test:e2e                      # builds the site, then runs every browser
pnpm test:e2e --project=firefox    # arguments go to `playwright test`
```

`nix develop` provides `subduction_cli` and Playwright's browsers (`PLAYWRIGHT_BROWSERS_PATH`). They come from Patchwork's own nixpkgs, which matches the pinned `@playwright/test` 1.59.1.

## Layout

- `site/`: a minimal copy of [patchwork.inkandswitch.com](https://github.com/inkandswitch/patchwork.inkandswitch.com). The base modules are served same-origin from `@inkandswitch/patchwork-pkg-base`. The build replaces the remote URLs hardcoded in them (`REMOTE_URLS` in `vite.config.ts`) and fails if one disappears in an upgrade. Both sync-server URLs are compiled in as sentinels (`sentinels.ts`).
- `e2e/stack.ts`: starts `subduction_cli` and `vite preview` on free ports with fresh storage. It serves a copy of `dist/` with the sentinels replaced by the local Subduction server and by a local sink that counts connections to the classic sync server, which nothing serves.
- `e2e/egress.ts`: an HTTP proxy that records and refuses every request. Each browser context uses it, and loopback bypasses it, so every non-local request from every page and worker ends up here.
- `e2e/network-log.ts`: what Playwright reports per context, for attribution. Its coverage differs per browser (see 05), so the egress sink is what proves that nothing left.
- `e2e/modules.ts`: publishes a tool directory with the pinned `pushwork` to the local server (`PUSHWORK_SUBDUCTION_SERVER`) and registers its URL in an account's module-settings doc, as the Packages UI does.
- `e2e/ui.ts`: UI helpers for the threepane frame and CodeMirror.

## Fixtures (`e2e/fixtures.ts`)

| fixture | scope | |
|---|---|---|
| `localStack` | worker | Subduction and the site, once per worker; also sets `baseURL` |
| `users(n)` | test | n independent browser profiles (contexts), each with its own `networkLog` |
| `installModule(dir, ...users)` | test | publishes `dir` (once per worker) and registers it with each booted user |
| `egress` | test, automatic | the egress sink; the test fails on any attempt unless it sets `test.use({ egressAllowed: true })` |
| `networkLog` | test | Playwright's log for the default context; non-local entries fail the test |

## Caveats

- **Traces are off.** Saving a Playwright trace of a booted Patchwork page stalls until the test timeout, even with plain Playwright fixtures and a passing test. A trace written with `--trace on` therefore costs the full timeout per test.
- **Modifier keys:** the desktop Chrome and Firefox devices emulate `navigator.platform = "Win32"`, so CodeMirror's `Mod` is Ctrl there. Playwright's `ControlOrMeta`, however, follows the host OS. Use `pressMod()` from `ui.ts`.
- **No `fetch` in harness code:** Node's built-in `fetch` (undici) threw one uncaught `setTypeOfService EINVAL` in 150 test runs on macOS, which could not be reproduced. The readiness check uses `node:http` instead.
- No retries: every failure has to be explained, not retried away.
- pnpm 11.9 on Node 24.16 occasionally aborts with a libuv assertion (`uv__io_poll`) after an install has finished; the installed result is unaffected.
