# Kenny

This repository contains a protocol-independent resumable workflow core, a WebMCP adapter, and a React/Vite demo that makes partial-failure recovery visible.

> Preserve the good work. Recover the broken part.

Live demo: [https://kenny-webmcp.vercel.app](https://kenny-webmcp.vercel.app)

## The problem

AI agents can perform multi-step actions on websites, but real workflows do not always finish cleanly. If a later step fails, starting over can duplicate side effects, rolling everything back can destroy valid work, and abandoning the workflow leaves the user with a half-finished result.

The core idea is deliberately narrow:

**Preserve valid completed work. Recover only the broken part. Resume safely.**

## Demo

The demo starts with one request:

> Onboard Maya, our new designer, for Monday.

The agent creates Maya's employee account, creates her workspace, assigns a Figma licence, and orders a laptop. Monday orientation then fails because the session is full. Those four valid actions stay complete, while the irreversible welcome email remains blocked.

The agent reads the recovery plan, finds Tuesday and Wednesday as alternatives, and proposes Tuesday. It cannot approve that proposal. A human approves it in the visible page, after which the agent resumes from the failed orientation step. Only orientation is retried, and onboarding completes with one welcome email.

The final proof panel shows:

| Side effect | Final value |
| --- | --- |
| employee | 1 |
| workspace | 1 |
| Figma licence | 1 |
| laptop | 1 |
| orientation | Tuesday |
| welcome email | 1 |

Successful work is not blindly rerun. The journal, simulated backend state, recovery proposal, and approval state are stored in IndexedDB, so the demo can pause, reload, and continue in the same browser profile.

## Human approval boundary

The agent has no approval tool. It can prepare a recovery proposal, but a human must approve that proposal in the application before the irreversible welcome email can be released. `resume_onboarding` fails closed if approval is missing, pending, stale, or does not match the current proposal and journal record.

The page also provides labelled manual controls so the complete story can be demonstrated when WebMCP is unavailable.

## WebMCP tools

The adapter registers exactly six tools through `document.modelContext.registerTool(...)`:

| Tool | Purpose |
| --- | --- |
| `get_onboarding_state` | Read the persisted workflow, side effects, failure, proposal, and approval state. |
| `start_onboarding` | Start the fixed Monday scenario and run until orientation fails. |
| `get_recovery_plan` | Read which work should be preserved, recovered, or kept blocked. |
| `search_orientation_slots` | Read the deterministic Tuesday and Wednesday alternatives. |
| `propose_recovery` | Create a visible Tuesday or Wednesday proposal; it does not approve or execute it. |
| `resume_onboarding` | Continue only after valid human approval, beginning at the failed orientation step. |

The three state/search tools are annotated read-only. There is intentionally no tool that grants approval.

## Architecture

```text
resumable-core
    -> resumable-webmcp adapter
        -> React/Vite demo
```

- `resumable-core` owns the journal, recovery semantics, idempotency keys, approval gates, recovery plans, and resume behavior. It has no WebMCP dependency.
- `resumable-webmcp` is the first protocol adapter. It handles WebMCP registration and lifecycle cleanup without moving workflow policy into the adapter.
- The React/Vite app supplies the deterministic onboarding workflow, IndexedDB persistence, the simulated backend, and the visible human decision point.

The separation is intended to keep the core protocol-independent. It is not a claim that the current implementation is automatically compatible with every agent protocol or production system.

## Prerequisites

- Node.js 20.19+ or 22.12+ (required by Vite 7)
- npm with lockfile v3 support (npm 9+)
- Chromium installed by Playwright for automated browser tests
- Chrome 149+ with experimental WebMCP enabled for real WebMCP testing

## Installation

Use the committed `package-lock.json` for a reproducible install:

```bash
npm ci
npx playwright install chromium
```

No API keys or environment variables are required.

## npm commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server. |
| `npm test` | Run core and WebMCP adapter unit tests. |
| `npm run typecheck` | Type-check the app and both packages. |
| `npm run build` | Type-check and create the production app in `apps/demo/dist`. |
| `npm run preview` | Serve the production build locally. |
| `npm run test:browser` | Run the Playwright integration and reload-recovery suite. |

## Development

```bash
npm run dev
```

Open the URL printed by Vite. The development and preview servers send `Origin-Agent-Cluster: ?1`, which is required for the origin isolation expected by WebMCP.

## Production build

```bash
npm run build
npm run preview
```

The build output is generated at `apps/demo/dist` and is intentionally excluded from version control.

## Test in Chrome with WebMCP

WebMCP is currently experimental. Chrome's current local-development instructions still require the testing flag:

1. Open `chrome://flags/#enable-webmcp-testing` in Chrome 149 or newer.
2. Set **WebMCP testing** to **Enabled** and relaunch Chrome.
3. Optional: also enable `chrome://flags/#devtools-webmcp-support` to use Chrome 149's experimental WebMCP panel in DevTools.
4. Start the app on the documented test origin:

   ```bash
   npm run dev -- --host 127.0.0.1 --port 4173
   ```

5. Open `http://127.0.0.1:4173/` in that Chrome instance.
6. Confirm the header reports **WebMCP — 6 tools connected**.
7. Inspect the six tools in the DevTools WebMCP panel or with Chrome's Model Context Tool Inspector, then run the sequence in [docs/WEBMCP-TESTING.md](docs/WEBMCP-TESTING.md).

See Chrome's official [WebMCP documentation](https://developer.chrome.com/docs/ai/webmcp) and [imperative API reference](https://developer.chrome.com/docs/ai/webmcp/imperative-api) before testing, because the API and browser requirements may change.

## Manual fallback demo

When `document.modelContext` is unavailable, the header truthfully reports **Unavailable — manual demo mode**. To run the same scenario without an agent:

1. Select **Reset demo**.
2. Select **Run failure scenario** and observe that four actions are preserved after Monday orientation fails.
3. Select **Propose Tuesday recovery**.
4. Select **Approve recovery** as the human.
5. Select **Resume safely**.
6. Confirm the final proof values are all one and orientation is Tuesday.
7. Reload before or after approval to verify that progress persists.

## Testing

Run the complete local verification sequence:

```bash
npm test
npm run typecheck
npm run build
npm run test:browser
```

The Playwright suite injects a test-only `modelContext` implementation so registration, discovery, schemas, cancellation, execution, approval gating, idempotency, and reload recovery are deterministic. It does not prove that a real agent selected the right tools; real Chrome/agent smoke testing is a separate check.

## Repository structure

```text
apps/demo/                    React/Vite demo and IndexedDB-backed demo state
packages/resumable-core/      protocol-independent workflow and recovery core
packages/resumable-webmcp/    WebMCP registration adapter
tests/browser/                Playwright integration and reload tests
docs/                         technical contract, demo script, and test guide
playwright.config.ts          browser-test server and runtime configuration
```

## Known limitations

- Mutation serialization is document-local. Multiple tabs are not coordinated and may race against the same IndexedDB state.
- The backend is a deterministic browser demo, not a connection to real identity, workspace, licensing, hardware, calendar, or email SaaS systems.
- Cancellation is cooperative at explicit boundaries. An external side effect already in progress must honor the supplied cancellation/idempotency contract itself.
- WebMCP support currently depends on experimental browser/API behavior, Chrome 149+ for the documented path, origin isolation, and local testing flags or an appropriate origin-trial environment.
- Journal short-circuiting and backend idempotency prevent duplicates in this demo. They do not provide exactly-once distributed execution for arbitrary external systems.
- The workflow, employee, failure, and recovery slots are intentionally fixed to make the proof deterministic.

## Security and license

See [SECURITY.md](SECURITY.md) for responsible reporting expectations. The code is available under the [MIT License](LICENSE).
