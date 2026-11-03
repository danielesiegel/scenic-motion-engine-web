# Security Policy

This project is a browser-based prototype that loads local assets (fonts,
audio, analysis JSON) via Vite's dev server and optionally spawns `ffmpeg`
and headless Chromium (via Playwright) for the offline render pipeline. It
does not open inbound network sockets, load remote code at runtime, or run
as a privileged service. The attack surface is therefore narrow — but
untrusted analysis JSON, config files, or asset paths could still cause
problems, and we take those reports seriously.

For project context see the [README](./README.md).

---

## Supported versions

Only the latest released minor version receives security fixes. Older
releases are unsupported — upgrade before reporting.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | yes (latest)       |
| < 0.1   | no                 |

---

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Email: **daniel@integralmimetics.com**

Include, at minimum:

- A description of the issue and its impact (crash, arbitrary file read,
  XSS via asset parsing, arbitrary code execution via the render
  subprocess, etc.).
- The affected version (`package.json` version field or git SHA).
- Steps to reproduce — a minimal `assets/` + `analysis/` + config
  reproduction is ideal.
- Your preferred attribution (name, handle, affiliation, or anonymous)
  for the hall of fame below.

If the issue is sensitive, request a PGP key in your first mail and one
will be sent back before you share details.

---

## Expected response time

Best-effort response within **7 days** of the initial email, usually
sooner. The response will either:

- Confirm the issue and give an estimated fix timeline, or
- Explain why we don't consider it a vulnerability (e.g., it requires
  the attacker to already have local code execution).

Fixes for confirmed issues ship in the next patch release. Coordinated
disclosure timelines are negotiable; the default is 90 days from
confirmation to public disclosure, or sooner if a fix lands first.

---

## Scope

In scope:

- XSS, prototype pollution, or arbitrary-code paths reachable from a
  crafted `analysis/*.json`, config file, or asset.
- Parser vulnerabilities in analysis JSON, config, or font / audio
  loading paths that can be triggered by a crafted file.
- Command injection via the `scripts/render.ts` `ffmpeg` or Playwright
  subprocess arguments.
- Any path that would let a malicious asset directory escalate beyond
  reading its own files when served by Vite in dev mode.

Out of scope:

- Issues that require the attacker to already have arbitrary code
  execution on the local machine.
- Denial of service via obviously oversized assets (a 10 GB WAV will
  OOM the tab; that's expected).
- Third-party dependency CVEs where the vulnerable code path is not
  reachable from this package — report upstream.
- Browser-specific issues that are not reproducible with a current
  version of Chrome, Arc, or Firefox.

---

## Hall of fame

Researchers who have responsibly disclosed valid issues will be listed
here with their preferred attribution.

_(empty — be the first)_
