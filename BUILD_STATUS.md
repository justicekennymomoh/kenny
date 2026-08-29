# Verification status

Verification target: the Phase 1.1 working tree based on commit `ed1ec4d`
(`Polish recovery experience for production`), including the authorized README,
documentation, human-visible compliance copy, and matching test-assertion changes.

Verified on 29 August 2026.

## Current automated results

- `npm test`: passed — 12 tests total (7 recovery-core and 5 WebMCP-adapter).
- `npm run typecheck`: passed — demo, recovery core, and WebMCP adapter.
- `npm run build`: passed — Vite production output generated successfully.
- Playwright browser suite: passed — 17 tests total:
  - 10 WebMCP integration tests;
  - 6 cross-tab safety tests; and
  - 1 reload-recovery test.

**Total: 29 automated tests passed.**

The execution harness interrupted the single all-suite Playwright process
without reporting a test failure, so the final browser evidence was captured by
running the same `npm run test:browser` script once for each committed spec file:

```bash
npm run test:browser -- tests/browser/cross-tab-safety.spec.ts --reporter=line
npm run test:browser -- tests/browser/webmcp-integration.spec.ts --reporter=line
npm run test:browser -- tests/browser/reload-recovery.spec.ts --reporter=line
```

All three invocations exited successfully with 6, 10, and 1 passing tests
respectively. No product or test configuration was changed to obtain these
results.

## Verified implementation properties

- six stable, unique tools registered through
  `document.modelContext.registerTool(...)`;
- strict object schemas and read-only annotations on the three read-only tools;
- an append-only journal, deterministic idempotency, and IndexedDB persistence;
- selective recovery demonstrating 4 valid actions preserved, 1 failed action
  recovered, and 0 completed actions repeated;
- a visible human approval boundary with no WebMCP approval tool;
- fail-closed resume checks for missing, pending, stale, or mismatched approval;
- cooperative cancellation checks and lifecycle-safe registration cleanup;
- origin-wide mutation serialization through Web Locks, with a document-local
  fallback when Web Locks are unavailable;
- deterministic coverage of integration, reload, and cross-tab race behaviour;
  and
- truthful manual fallback behaviour when WebMCP is unavailable.

## Manual browser evidence

Existing repository evidence records a manual Chrome 151 WebMCP smoke test on
one Windows machine. That check is separate from the injected Playwright suite
and is not a claim about every Chrome installation or ChatGPT's in-app browser.

No ChatGPT in-app-browser verification is currently claimed.

Before deployment or submission, run the complete clean-install sequence again
from the committed lockfile:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run test:browser
```
