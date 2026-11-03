# Contributing to scenic-motion-engine-web

Thanks for your interest. This document covers local setup, the required
pre-push checks, and the PR flow. For project context, feature matrix, and
architecture, start at [README.md](./README.md).

> **Heads up:** this repo is the TypeScript / Canvas 2D **prototype** and
> reference implementation. Most new work should land in the Rust / Metal
> native Mac port at
> [`scenic-motion-engine-mac`](https://github.com/danielesiegel/scenic-motion-engine-mac).
> Fixes to the engine semantics, analysis format, or docs are welcome here;
> net-new features are usually better upstreamed to the Rust port and then
> back-ported if they make sense in-browser.

---

## Setup

Prerequisites — same as the [README install section](./README.md#install):

- Node 20+ (tested on 20.x and 22.x)
- macOS 14+ or Linux; Chrome 120+ / Arc 1.42+ for WebCodecs recording
- Python 3.10+ with a virtualenv (only if you plan to re-run `scripts/analyze.py`)
- `ffmpeg` on `PATH` (only for the deterministic `scripts/render.ts` pipeline)

Clone and install:

```bash
git clone https://github.com/danielesiegel/scenic-motion-engine-web.git
cd scenic-motion-engine-web
npm install
```

Drop assets before first run:

- A font (`.otf` / `.ttf`, ITC Avant Garde Gothic LT Demi preferred) into `assets/fonts/`
- A WAV into `assets/audio/`
- The matching analysis JSON into `analysis/` (produced by `npm run analyze`)

Then:

```bash
npm run dev
```

Other common commands (see `package.json` for the full list): `npm test`,
`npm run typecheck`, `npm run build`, `npm run render`, `npm run analyze`.

---

## Local checks

Run all three before pushing — CI will run the identical set and reject
anything that fails:

```bash
npm run typecheck
npm test
npm run build
```

Formatting follows the TypeScript defaults enforced by `tsc` + the Vite
build. Do not disable `strict` or relax `tsconfig.json` without a PR
explaining why.

---

## Opening PRs

- Branch off `main`, keep PRs small and focused.
- Fill in the PR template (`.github/PULL_REQUEST_TEMPLATE.md`) — Context,
  Changes, Test Plan.
- Reviewers are routed via [CODEOWNERS](./.github/CODEOWNERS); expect at least
  one owner review on every file touched.
- CI must be green before merge.
- Update [CHANGELOG.md](./CHANGELOG.md) under `## [Unreleased]` for any
  user-visible behavior change.

---

## Motion extensions

Adding a new path function, easing, or ticker binding? Read **[MOTION.md](./MOTION.md)** first — it covers the path-function contract, continuity model, compose modes, per-glyph outputs, and the registered-paths table.

New paths go in `src/motion/paths.ts` and get a one-line entry in MOTION.md's
registered-paths table. If the new path is useful offline too, port it to
`src/motion/paths.rs` in the
[Mac repo](https://github.com/danielesiegel/scenic-motion-engine-mac) in the
same release cycle so the two engines stay bit-identical.

---

## Contract-first swarm pattern

This project was prototyped with a small agent swarm — one agent per module
(engine, text, audio, motion, render, preview), coordinated by an
orchestrator. The invariant that made parallel work tractable:

> **`src/types.ts` is the immutable contract.** Every module builds against
> these types, and the Rust port's `src/types.rs` is a direct translation.
> Module agents may add helper types inside their own module but must not
> change `types.ts` without the orchestrator.

The same rule holds for human contributors. If you need to change
`src/types.ts`:

1. Open an issue or discussion first describing the shape change.
2. Expect the PR to touch every downstream module that consumes the type —
   and, probably, the matching PR in the Mac repo.
3. Keep the diff minimal — add new optional fields rather than rewriting
   existing ones so old `analysis/*.json` files still load.

This keeps module boundaries narrow and makes it possible to review engine,
render, and audio changes independently across both repos.

---

## Code of conduct

Be kind. Prefer evidence over opinion. If a reviewer asks for a benchmark or
a determinism check, include one.
