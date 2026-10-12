# Plan: VM-based test harness

Execution plan for a fresh agent. Read `AGENTS.md`, [src/harness/README.md](../README.md) and [research/05-sandboxing.md](../../../research/05-sandboxing.md) first. When the plan is done, fold the results into the harness `README.md` and 05's "Test harness" section, and delete this file.

## Goal

Move the e2e harness into NixOS VMs, so that "nothing leaves the machine" holds by construction and is verified on every packet, rather than by plugging holes in a proxy. Also close the gaps that block 05 but are unrelated to networking. All of this is done **before** any work on the sandbox runner in 05.

The current harness has these gaps (all confirmed): loopback traffic bypasses the egress proxy and is never recorded, traffic that ignores HTTP proxies (WebRTC/UDP, possibly DNS prefetch) is invisible, the site sends no COOP/COEP headers and they can't be switched per test, measurements run on 2 parallel workers, OCCT's wasm has no local host, `users(n)` can't mix browsers, and every test gets fresh profiles (no warm loads).

## Decisions already made

- **NixOS test framework on the macOS host:** `pkgs.testers.runNixOSTest` with macOS `pkgs` runs `aarch64-linux` VMs through Apple's hypervisor (system feature `apple-virt`); no nested virtualization. Node configs must use their own `pkgs` module argument; the outer `pkgs` is the macOS one.
- **QEMU's user-mode NIC is never unrestricted:** on a macOS host the nix build has no network sandbox, and the default NIC is a NAT to the internet (`curl 1.1.1.1` succeeded from a VM). The attacker has none (`virtualisation.qemu.networkingOptions = lib.mkForce [ ]`); the client's is restricted (below). Every run asserts that the internet and the host are unreachable from the client except through the forward.
- **Subduction runs natively on the host**, started by the test script (which runs on the host) on a free port with fresh storage. The client reaches it through `virtualisation.restrictNetwork = true` ("the guest will be isolated, i.e. it will not be able to contact the host and no guest IP packets will be routed over the host to the outside") plus one guest forward, added at runtime through `QEMU_NET_OPTS`: `guestfwd=tcp:10.0.2.100:7000-cmd:nc 127.0.0.1 <port>`. Subduction's `--service-name` must be that forward address. The client's `eth0` gets a static address and no gateway. This needs no Linux build of Subduction.
- **Topology:**
  - `client`: browsers, Playwright and the site on `localhost` (a secure context, as service workers require). `tcpdump -i any` captures every packet, loopback included.
  - `attacker`: stands in for the internet. It is the client's default gateway for IPv4 and IPv6, answers every DNS name with its own address (dnsmasq `address=/#/…`), and redirects TCP to any destination to a catch-all ([`catchall.py`](catchall.py)) that logs the bytes and answers HTTP 404. Without the gateway, attempts to IP literals fail locally and leave no packet; without the 404, an unanswered WebSocket blocks all later ones to the same IP ([RFC 6455 §4.1](https://www.rfc-editor.org/rfc/rfc6455#section-4.1): "there MUST be no more than one connection in a CONNECTING state").
- **Verdicts:**
  - **Flows:** every packet on the client's `eth1`, and every packet on `eth0` other than the Subduction forward, is an egress attempt and fails the test unless the test expects it. Loopback flows are allowed only to the site's port. Multicast leaves on every interface: WebRTC makes Chromium announce random `<uuid>.local` names over mDNS (224.0.0.251:5353, plus IGMP joins), so attack tests that use WebRTC expect those.
  - **Canaries:** attack tests embed known payloads; each must be found as an exact byte string (not by regex extraction: adjacent pcap framing bytes corrupt matches) in the capture and in the attacker's log. Payloads only survive verbatim in hostnames, URLs and plain HTTP bodies; WebSocket client frames are masked, TLS and compression hide them, so either decode at the attacker or put canaries where they stay plain.
- **Client VM settings:** `virtualisation.useNixStoreImage = true` (reading the browsers over 9p made a `cat` take 55 s), `hardware.graphics.enable = true` (WPE WebKit's web process crashes with SIGTRAP without a Mesa EGL driver), 4 GB / 4 cores, browsers run as an unprivileged user.
- **Setup requirements are documented and checked**, not assumed.

## Known facts (spike, 2026-10-12)

- [`spike.nix`](spike.nix) (two VMs, capture, no internet) and [`spike-browsers.nix`](spike-browsers.nix) with [`spike-probe.ts`](spike-probe.ts) pass as `nix build`s. The latter needs the built site and runs impurely: `nix build --impure --expr 'let f = builtins.getFlake (toString ./.); in import ./src/harness/vm/spike-browsers.nix { pkgs = f.inputs.nixpkgs.legacyPackages.aarch64-darwin; subduction = f.inputs.subduction.packages.aarch64-darwin.subduction_cli; dist = builtins.path { path = ./src/harness/site/dist; name = "site-dist"; }; }'`.
- In the VM, Patchwork boots in Chromium in about 1 s, Firefox 2 s, WebKit 1–2 s (single runs up to 24 s). In each browser, a doc created in one profile reaches a second profile through the host's Subduction. The whole spike runs in about 2 minutes after the images are built.
- All 21 canaries (fetch host and query, image, `sendBeacon` body, WebSocket URL, WebRTC STUN hostname, fetch to an IP literal; × 3 browsers) are in the capture. STUN goes over UDP, which the TCP catch-all doesn't log; the capture shows the DNS query and the UDP packets. Firefox gathers no ICE candidates without a default route. Through the restricted NIC, the client reaches only the forward: not the internet, not the host's Subduction port directly, not the host's SSH.
- Playwright's `aarch64-linux` browsers (`pkgsLinux.playwright-driver.browsers`, same revisions as on macOS) are in cache.nixos.org; Linux WebKit is WPE, not Safari's port.
- `subduction_cli` for `aarch64-linux` is in no cache, and on the default nix-darwin `linux-builder` (1 CPU, 3 GB, no swap) its final `rustc` is killed by a signal, almost certainly the OOM killer. Running Subduction on the host avoids that build.

## Host requirements

The user's nix-darwin setup runs Lix 2.95 with `nix.linux-builder.enable = true`; `apple-virt` and `nixos-test` are Lix's default system features on macOS. Needed:
- an `aarch64-linux` builder for the VM images (the default `linux-builder` suffices)
- `kern.hv_support: 1`, system feature `apple-virt`
- free RAM for the VMs: about 5 GB, plus the builder while building
- a free local TCP port for the host's Subduction (allocated at runtime)
- a Linux host instead also works (KVM, and Subduction built natively there); keep the test free of macOS assumptions

## Steps

1. **Preflight and requirements:** an entry point (e.g. `nix run .#harness-vm` or `pnpm test:vm`) that first runs a preflight script (Python or TS) checking every host requirement above, with a clear message per failure, then builds and runs the VM test. Document the requirements in the harness README.
2. **Reproducible inputs as derivations:** the site's `dist/` and the harness's `node_modules` for `aarch64-linux` (Playwright test runner, pushwork with its native `lmdb`). pnpm's lockfile must cover both platforms (`supportedArchitectures` in `pnpm-workspace.yaml`); fetch with nixpkgs' pnpm fetcher. Replace `vite preview` in the VM by a small TypeScript static server on `node:http`: it removes the native rolldown dependency, and it is needed anyway for per-test headers and request logs (steps 4 and 6).
3. **Port the stack and fixtures into the client VM:** the test script starts Subduction on the host and the guest forward as in the spike (one Subduction per run; fixtures in the VM share it, with fresh browser profiles per test), starts the capture, runs `playwright test` inside the client, copies results out (`copy_from_vm`), and analyses the capture. The `egress` fixture asks a small capture-control service in the client for the flows of its own time window, so violations are attributed per test. The proxy-based recorder stays for the macOS host suite.
4. **Allowed channels:** request logs for the site server, Subduction's connection log (on the host), and a canary search in Subduction's storage (on the host) after attack tests, because writing a secret into a synced document is exfiltration through an allowed channel.
5. **Attacker completeness:** UDP catch-all (log STUN/TURN and arbitrary UDP), IPv6 equivalents of the TCP redirect, optional TLS termination with a test CA trusted by the client browsers so HTTPS canaries can be found. Self-tests: the spike's 21 canaries plus IP-literal STUN, DNS prefetch hints, and a negative test (a page that sends nothing must produce zero `eth1` flows apart from expected ones).
6. **Non-network gaps:**
   - COOP/COEP (and other headers) settable per test on the site server
   - a serial `measure` project (one worker, repeated runs) for timings; document that VM timings are not representative and when host runs are needed
   - local hosting of large static assets (OCCT's wasm) through the site server
   - `users()` across browser types in one test, for determinism tests
   - persistent profiles (a profile that survives across pages and reloads) for warm loads
7. **Docs and verification:** update the harness README and 05; keep one command to run everything.

## Rules for execution

- Follow `AGENTS.md`: TypeScript for application code and tests, Python or TypeScript for tooling, everything locked through nix and pnpm, documents state only the current result.
- Explain every failure before it counts: during the spike, a test bug (a `pkgs` from the host), a probe bug (WebSocket queueing), and an oracle bug (regex extraction) each looked like a finding at first.
- Separate commits for unrelated changes; the user reviews before committing.
- Ask the user before changing anything outside the repository (e.g. the nix-darwin builder config).

## Verification

- On a fresh clone with the host requirements met, one command runs the preflight, builds everything and runs the VM suite in all three browsers.
- Every test fails on any unexpected `eth1` flow; the self-tests prove that each egress route in 05's escape list is detected in each browser.
- The macOS host suite keeps passing.
