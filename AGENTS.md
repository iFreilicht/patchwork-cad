# CAD in Patchwork

This repository contains research and code to design and implement a NURBS-based CAD-modeller with a similar UX to Fusion 360 that runs standalone with [automerge](https://automerge.org/llms.txt) or as a tool in [patchwork](https://github.com/inkandswitch/patchwork-pkg-base).

## Writing style

Be brief in your writing. Only write what is necessary, avoid duplicate information if possible. Documentation is code, it can be restructured and refactored if necessary. Use links to external sources or to other documents in this repo to add context to your writing. Quote the relevant part of a linked document to prove statements that assert a fact.

Human-written sections are marked enclosed with `<HUMAN-WRITTEN>`/`</HUMAN-WRITTEN>`. NEVER alter a human-written section! If it contains false or inaccurate statements, write your corrections/clarifications/additions DIRECTLY AFTER the `</HUMAN-WRITTEN>` tag.

NEVER add line-breaks inside of a paragraph. The editor/viewer takes care of wrapping lines, not you.

Documents only contain the current result. When something changes, edit the text as if it had always been that way; don't add dated "update" notes or explain what changed and why. Git history tracks changes.

## Repository infrastructure

This repository uses git for version control, nix (with flakes enabled) for meta-dependency management and pnpm for JS/TS dependencies. DO NOT rely on a system package manager! NEVER assume presence of packages (except for nix itself) on a bare system. All dependencies MUST be locked and reproducible! Other languages than JS/TS might be covered sufficiently by nix. If not, ask the user for a decision for an additional package manager.

Enter the development environment (node, pnpm, python, `subduction_cli` and Playwright's browsers) with `nix develop` (see `flake.nix`). Its nixpkgs follows [patchwork-system](https://github.com/inkandswitch/patchwork-system)'s, so tool versions match Patchwork's.

Bash is only allowed for very simple, ephemeral scripts. Python should be preferred at all times.

All application code (except vendored code in `.claude/skills`) MUST be TypeScript, checked against the strict root `tsconfig.json` (`pnpm run typecheck`). Patchwork tools are therefore always bundled (vite), never bundleless JS. Tooling scripts (build scripts, experiment orchestration, …) may be committed and written in TypeScript or Python; prefer TypeScript when they interact with the JS ecosystem.

You MUST have the skill `writing-patchwork-tools` available! If not, abort and inform the user!

The skills in `.claude/skills` were installed with `npx @inkandswitch/patchwork-skills install .claude/skills` and then patched locally: `writing-patchwork-tools` uses pnpm with a pinned `pushwork` devDependency instead of npm/`npx pushwork@latest`, and `reference/patchwork-base/AGENTS.md` only lists tools that actually exist in the checkouts. Re-apply these patches after reinstalling.

## Repository structure

Research goes into `./research`, source code into `./src`.

## Design goals

Model files MUST stay plain, portable JS that runs without our tool, given only the feature library: no walled garden, no DSL, a thin library and a feature-rich editor. See [research/02-model-storage.md](research/02-model-storage.md#design-goal-portable-models).

