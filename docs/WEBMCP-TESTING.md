# WebMCP testing

## Supported environment

Use Chrome 149 or newer with WebMCP enabled, or a ChatGPT in-app browser build
that exposes WebMCP. The application uses the current imperative API at
`document.modelContext`; it does not use `navigator.modelContext`,
`requestUserInteraction()`, or proposed consequential annotations.

For local Chrome testing:

1. Open `chrome://flags/#enable-webmcp-testing`.
2. Set **WebMCP testing** to **Enabled**.
3. Relaunch Chrome.
4. Optionally enable `chrome://flags/#devtools-webmcp-support` and relaunch if
   you want Chrome's experimental WebMCP panel in DevTools.
5. In this repository run `npm run dev -- --host 127.0.0.1 --port 4173`.
6. Open `http://127.0.0.1:4173/` in that Chrome instance.
7. Confirm the page says **WebMCP — 6 tools connected**.

The Vite development and preview servers send `Origin-Agent-Cluster: ?1` because
WebMCP requires an origin-keyed document. Do not set `document.domain` or send
`Origin-Agent-Cluster: ?0`.

## Expected discovery

The exact tool names are:

1. `get_onboarding_state`
2. `start_onboarding`
3. `get_recovery_plan`
4. `search_orientation_slots`
5. `propose_recovery`
6. `resume_onboarding`

In a Chrome version with WebMCP DevTools support, inspect the page's WebMCP
tools there. Otherwise install Chrome's **Model Context Tool Inspector**
extension, which can list schemas and manually execute tools. The page console
can also confirm same-origin discovery:

```js
await document.modelContext.getTools()
```

Expect the browser to return the six tools in alphabetical order. The three
read-only tools must show `annotations.readOnlyHint: true`. The other three must
not claim to be read-only. `propose_recovery` must show an enum containing only
`Tuesday` and `Wednesday`, with `additionalProperties: false`.

## Exact human-agent sequence

Start from **Reset demo**, then have the agent use this sequence:

1. `get_onboarding_state({})`
2. `start_onboarding({})`
3. Confirm the outcome is `paused_on_failure`, the failure is
   `book_orientation`, and the four existing side effects each equal one.
4. `get_recovery_plan({})`
5. `search_orientation_slots({})`
6. `propose_recovery({ "slot": "Tuesday" })`
7. Stop. The webpage must now visibly show **Human decision required**.
8. Call `resume_onboarding({})` before clicking anything. It must return
   `resumed: false` with `HUMAN_APPROVAL_REQUIRED_OR_STALE`.
9. The human—not the agent—clicks **Approve recovery** in the webpage.
10. `get_onboarding_state({})` must now report `canResume: true`.
11. `resume_onboarding({})`.
12. Confirm `workflowStatus: "complete"`, orientation `Tuesday`, one welcome
    email, and exactly one employee, workspace, Figma licence, and laptop.
13. Repeat `start_onboarding({})` and `resume_onboarding({})`; neither may add a
    side effect.

## Proving the agent cannot self-approve

- Discovery must contain exactly the six names above; there is no approval tool.
- `propose_recovery` returns `waitingForHuman: true` and stores a pending proposal.
- Before the human click, `get_onboarding_state` reports `canResume: false` and
  `resume_onboarding` fails closed.
- Approval is valid only when the current proposal ID and approval ID match the
  journaled `APPROVAL_GRANTED` record for `send_welcome_email` and the persisted
  orientation recovery is still active.
- Creating a newer proposal makes an older approval inapplicable.

## Automated coverage versus real-agent coverage

Run:

```text
npm test
npm run typecheck
npm run build
npm run test:browser
```

The browser suite injects a test-only implementation of the current WebMCP
registration, discovery, schema-validation, and execution shape. This makes the
adapter flow deterministic in Playwright. The final application does not ship
that implementation: when `document.modelContext` is absent, it truthfully
reports that WebMCP is unavailable and leaves the labelled manual controls
available.

Automated adapter coverage is not evidence that a ChatGPT agent selected and
called the tools. Record real Chrome/Inspector and ChatGPT-agent verification
separately when those environments are available.

## Current browser/spec note

On one Windows machine, Chrome 151 stable successfully exposed
`document.modelContext`, `registerTool()`, `getTools()`, and `executeTool()`, but
page-initiated `executeTool()` did not provide the documented second
execution-context argument to the registered executor. Therefore executors
tolerate an absent context while honoring `AbortSignal` when supplied. This is
the observed runtime behavior on that installation; it is not a claim about
every Chrome 151 installation or about agent-initiated execution.

Chrome documents an improved unregistration behavior in Chrome 153 that avoids
breaking in-flight executions. This implementation does not depend on it: each
React mount owns an abortable registration set and cleanup aborts that set, which
also works on earlier supported Chrome versions. Consequently, pre-153 cleanup
may cancel an in-flight call during component unmount; the executor checks the
call signal and does not return fake success.
