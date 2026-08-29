# Kenny

> **WebMCP gives agents tools. Kenny gives those tools a recovery contract.**

Kenny is a reference implementation for developers building stateful WebMCP applications where external agents can cause consequential multi-step side effects.

Live demo: [https://kenny-webmcp.vercel.app](https://kenny-webmcp.vercel.app)

## The partial-failure problem

AI agents can perform multi-step actions on websites, but real workflows do not always finish cleanly. If a later step fails, starting over can duplicate side effects, rolling everything back can destroy valid work, and abandoning the workflow leaves the user with a half-finished result.

Partial workflow failure is not a newly invented problem. Established systems already use retries, idempotency, compensation, sagas, journals, and durable workflow execution. Kenny does not claim to invent those mechanics.

The boundary Kenny examines is:

```text
stateful web application
        ↕
      WebMCP
        ↕
external AI agent
```

## Kenny's answer

The application—not the agent—is the source of truth about recovery.

After a partial failure, Kenny exposes an application-declared recovery contract that says:

- what succeeded;
- what remains valid;
- what must not be replayed;
- what failed;
- which recovery operations are permitted;
- where execution can resume;
- what remains blocked; and
- what requires human authority.

The narrow operating principle is:

> Preserve valid completed work. Recover only the broken part. Resume after authorization.

## Proof: 4 / 1 / 0

Kenny's deterministic Maya reference workflow demonstrates:

| Preserved | Recovered | Repeated |
| ---: | ---: | ---: |
| **4 valid actions** | **1 failed action** | **0 completed actions** |

Final simulated side effects:

| Side effect | Final value |
| --- | ---: |
| Employee account | 1 |
| Workspace | 1 |
| Design software licence | 1 |
| Laptop order | 1 |
| Orientation | Tuesday |
| Welcome email | 1 |

Exact workflow attempts:

| Step ID | Attempts |
| --- | ---: |
| `create_employee` | 1 |
| `create_workspace` | 1 |
| `assign_figma` | 1 |
| `order_laptop` | 1 |
| `book_orientation` | 2 |
| `send_welcome_email` | 1 |

Only the failed orientation step is attempted twice: Monday fails, then the human-approved Tuesday replacement succeeds. This is proof for Kenny's fixed reference workflow, not a universal exactly-once guarantee.

## Application, agent, and human authority

| Participant | Authority |
| --- | --- |
| **Application** | Persists recovery truth; declares `PRESERVE`, `RECOVER`, or `BLOCKED`; declares permitted recovery and the resume point. |
| **Agent** | Inspects state, reads the recovery plan, searches alternatives, proposes recovery, and resumes after authorization. |
| **Human** | Approves the current recovery proposal in the visible application. |

**Kenny exposes no WebMCP approval tool.** An agent cannot grant approval through Kenny's six-tool WebMCP surface.

If `resume_onboarding` is called without a valid approval bound to the current proposal and journal state, it fails closed:

```text
HUMAN_APPROVAL_REQUIRED_OR_STALE
```

This is a narrow capability-boundary claim. Kenny does not claim to prevent prompt injection, jailbreaks, or every form of unauthorized browser interaction.

## Application-declared recovery contract

After Monday orientation fails, `get_recovery_plan` returns deterministic application state equivalent to:

| Step | Semantics | Disposition | Additional constraint |
| --- | --- | --- | --- |
| `create_employee` | `REVERSIBLE` | `PRESERVE` | — |
| `create_workspace` | `REVERSIBLE` | `PRESERVE` | — |
| `assign_figma` | `REVERSIBLE` | `PRESERVE` | — |
| `order_laptop` | `COMPENSATABLE` | `PRESERVE` | — |
| `book_orientation` | `COMPENSATABLE` | `RECOVER` | `allowedRecovery: ["REPLACE_INPUT"]` |
| `send_welcome_email` | `IRREVERSIBLE` | `BLOCKED` | `requiresHumanApproval: true` |

The response also reports the current `failure`, `resumePoint`, `validApprovalExists`, and `canResume`. These values are derived from the application's persisted journal, proposal, and approval state. They are not LLM-generated reasoning.

## Why WebMCP

Ordinary action tools tell an agent what it can invoke. Kenny uses one WebMCP-discovered surface to expose both:

1. operational actions; and
2. application recovery state and constraints.

The external agent can discover the operational tools, current recovery state, permitted recovery, and resume capability without becoming the source of truth for any of them.

This gives the human and agent a shared, inspectable handoff: the agent can
prepare and continue recovery from application truth while the human retains the
approval decision. Without that contract, an external agent would have to infer
what remains valid and what it is authorized to replay from generic actions or
page state. Preserving valid progress instead of forcing a restart is the user
experience improvement Kenny demonstrates.

The recovery-contract concept is not exclusive to WebMCP. WebMCP is the chosen application-to-agent boundary for this challenge because the page can publish structured tools and current application semantics directly to an external browser agent.

## Maya as a reference scenario

Maya onboarding is a fixed, reproducible reference scenario—not Kenny's intended product category.

The pattern may be relevant to developers building stateful WebMCP applications for provisioning, reservations, account administration, fulfilment, commerce, IT operations, and other consequential multi-step web workflows.

These are potential applications of the pattern, not integrations currently provided by Kenny.

## Relationship to sagas and Temporal

Temporal and saga-style systems coordinate recovery inside workflows and integrations an application controls. Kenny applies established recovery principles at another boundary: the application publishes recovery semantics outward to an external agent through WebMCP. The agent is not the source of truth about what remains valid—the application is.

Kenny does not replace a durable workflow engine. Kenny does not claim that retries, compensation, idempotency, journals, or recovery mechanics are new.

## Live judge walkthrough

Open the [live demo](https://kenny-webmcp.vercel.app) in an environment that exposes WebMCP, then:

1. Reset the demo.
2. Call `get_onboarding_state`, then `start_onboarding`.
3. Confirm that four completed actions remain valid after `book_orientation` fails for Monday.
4. Call `get_recovery_plan` and `search_orientation_slots`.
5. Call `propose_recovery` with Tuesday.
6. Before approval, call `resume_onboarding` and confirm `HUMAN_APPROVAL_REQUIRED_OR_STALE`.
7. The human selects **Approve recovery** in the page.
8. Call `resume_onboarding` again.
9. Confirm the final side effects and attempts shown in the 4 / 1 / 0 proof above.

When WebMCP is unavailable, the page truthfully reports **Unavailable — manual demo mode** and exposes labelled manual controls for the same deterministic scenario. Detailed agent and manual paths are in [docs/WEBMCP-TESTING.md](docs/WEBMCP-TESTING.md).

## Architecture

```text
resumable-core
    → resumable-webmcp adapter
        → React/Vite demo
```

- `resumable-core` owns the journal, recovery semantics, idempotency keys, approval gates, recovery plans, and resume behaviour. It has no WebMCP dependency.
- `resumable-webmcp` registers the WebMCP tools and owns registration lifecycle cleanup without moving workflow policy into the adapter.
- The React/Vite application supplies the fixed onboarding workflow, IndexedDB persistence, deterministic simulated backend, visible recovery contract, and human decision point.

This separation keeps the core protocol-independent. It is not a claim that the implementation is automatically compatible with every agent protocol or production system.

## Six WebMCP tools

The adapter registers exactly six tools through `document.modelContext.registerTool(...)`:

| Tool | Purpose |
| --- | --- |
| `get_onboarding_state` | Read the persisted workflow, simulated side effects, failure, proposal, and approval state. |
| `start_onboarding` | Start the fixed Monday scenario and run until orientation fails. |
| `get_recovery_plan` | Read the application-declared preserve, recover, blocked, approval, and resume state. |
| `search_orientation_slots` | Read the deterministic Tuesday and Wednesday alternatives. |
| `propose_recovery` | Create a visible Tuesday or Wednesday proposal; it does not approve or execute recovery. |
| `resume_onboarding` | Continue from the failed orientation step only after valid human approval. |

The three state/search tools are annotated read-only. There is intentionally no tool that grants approval.

## Verification and testing

Run the complete verification sequence:

```bash
npm test
npm run typecheck
npm run build
npm run test:browser
```

Verified on 29 August 2026: **12 unit/adapter tests + 17 browser tests = 29
automated tests passed**. See [BUILD_STATUS.md](BUILD_STATUS.md) for the exact
verification target and command breakdown.

Unit tests cover the recovery core and WebMCP registration adapter. The Playwright suite injects a test-only `modelContext` implementation so registration, discovery, schema validation, cancellation, execution, approval gating, idempotency, reload recovery, and cross-tab races are deterministic.

Injected Playwright coverage does not prove that a real external agent selected the correct tools. Manually performed Chrome WebMCP checks are recorded separately in [BUILD_STATUS.md](BUILD_STATUS.md). No ChatGPT in-app-browser verification is claimed without separate evidence.

## Persistence and concurrency

The append-only journal, simulated backend state, idempotency results, recovery proposal, and approval state are persisted in IndexedDB. The workflow can pause, reload, and continue in the same browser profile.

Mutating operations use one exclusive origin-wide Web Lock:

```text
kenny:onboard_maya_v1:mutation
```

The lock protects start, proposal creation, human approval, resume, and reset. Read-only tools remain lock-free. Browsers without Web Locks fall back to document-local serialization.

The browser suite tests simultaneous starts, concurrent proposals, stale-tab approval, resume/proposal races, and reset/mutation races across tabs. This locking does not provide distributed coordination, cross-device locking, or cross-profile locking.

## Deterministic simulated backend

Kenny's external service actions are deterministic simulations. This makes the partial-failure scenario reproducible and lets judges verify the recovery invariants repeatedly.

Kenny demonstrates an application-declared recovery contract; it does not demonstrate production integrations with identity, workspace, licensing, hardware, calendar, email, or other SaaS systems.

## Known limitations

- Journal short-circuiting and simulated-backend idempotency prevent duplicates in this reference scenario. They do not provide exactly-once distributed execution for arbitrary external systems.
- A real side-effecting integration would also need to honour the idempotency key or provide an equivalent transactional guarantee.
- Cancellation is cooperative at explicit boundaries. An external side effect already in progress must honour the supplied cancellation/idempotency contract itself.
- The Web Lock is origin-wide within a supporting browser profile, not distributed across devices, profiles, or external services.
- WebMCP support depends on experimental browser/API behaviour, origin isolation, and a compatible ChatGPT in-app browser, Chrome testing flag, or origin-trial environment.
- The workflow, employee, failure, and recovery slots are intentionally fixed to keep the proof deterministic.
- Kenny is a demonstration, not a production service, durable workflow engine, or production SaaS integration.

## Local development

Prerequisites:

- Node.js 20.19+ or 22.12+;
- npm 9+ with lockfile v3 support; and
- Chromium installed by Playwright for automated browser tests.

Install and start:

```bash
npm ci
npx playwright install chromium
npm run dev
```

No API keys or environment variables are required. The Vite development server prints the local URL and sends `Origin-Agent-Cluster: ?1`.

For the current Chrome WebMCP setup, exact six-tool sequence, manual fallback, and automated-versus-real-browser distinction, see [docs/WEBMCP-TESTING.md](docs/WEBMCP-TESTING.md).

Repository layout:

```text
apps/demo/                    React/Vite demo and IndexedDB-backed state
packages/resumable-core/      Protocol-independent workflow and recovery core
packages/resumable-webmcp/    WebMCP registration adapter
tests/browser/                Integration, reload, and cross-tab browser tests
docs/                         Contract, demo, compliance, and testing documentation
```

## Licence

Kenny is available under the [MIT License](LICENSE). See [SECURITY.md](SECURITY.md) for responsible reporting expectations.
