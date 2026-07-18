# Coretax Agent

Standalone desktop app for Coretax automation. Separate from, and does not touch, the existing
`Taxio/coretax-helper` (`TaxioCoretaxHelper.exe`) - that one keeps working exactly as before via
`taxio-coretax://` deep links from the web apps. Coretax Agent is a different app you open
directly: you sign in with your Taxio or Taxio.me email+password once, and drive Coretax through
a local GUI dashboard instead of a console window.

## Run in development

```
npm install
npm run start
```

No build step needed to iterate - edit any file under `lib/`, `gui/`, or `automation/` and
restart `node main.js`. The dashboard itself (`gui/public/*`) can be refreshed in the window
without even restarting the Node process.

## Build the distributable exe

```
npm run build
```

Produces `dist/coretax-agent.exe` via `@yao-pkg/pkg` (same toolchain as coretax-helper - plain
`@vercel/pkg` is known not to work with Playwright's crypto usage on Node 22).

## What's here

- `main.js` - entry point: the Playwright-driver-subprocess guard (must run first, see comment
  in the file), starts the local GUI server, tries to restore a previously-connected session,
  opens the dashboard as an app-mode Chrome window.
- `lib/` - shared primitives: logging (+ SSE-friendly subscriber list), the Supabase project
  registry, file-backed session persistence, Chrome/Playwright login+impersonation helpers
  (ported from coretax-helper's proven logic), entity/PIC listing, and masa (tax period) parsing.
- `gui/` - the local HTTP server (`node:http`, no framework) and dashboard (`public/`: plain
  HTML/CSS/JS, no build step, no framework).
- `automation/ebupot.js` - automation feature #1: e-Bupot (BPPU/BP21/BPA1) PDF downloads. See
  the file's own header comment for the design rationale and an explicit note on which parts
  (DOM selectors for Coretax's filter/pagination controls) are least certain and most likely to
  need adjustment after a first live run - it was written from a spec document, not against a
  live session.

## First live test checklist

The e-Bupot flow's Coretax-side selectors (`setMasaPajakFilter`, `setBpa1RangeFilter`,
`setKodeObjekFilter`, `getDownloadButton`, `extractRowFields`'s header-name matching) are the
one part of this codebase that couldn't be verified against the real site while building it.
Run one small download (a single entity, a single masa, a handful of expected rows) first and
check `coretax-agent.log` for anything logged as "tidak ditemukan" (not found) - that pinpoints
exactly which selector needs adjusting.
