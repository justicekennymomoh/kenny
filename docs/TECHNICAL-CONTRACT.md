# Kenny technical contract

## Scope

One workflow, one human, one browser agent, one deterministic application.

The prototype proves five claims only:

1. A partially completed workflow can stop on failure without erasing successful work.
2. Completed actions with the same workflow/step/args can short-circuit on retry.
3. The application declares recovery semantics instead of asking the model to guess.
4. Recovery can replace only the failed input and resume from the failed logical step.
5. Consequential continuation can require explicit human approval in the visible application UI.

## Recovery semantics

- `READ_ONLY`: no side effect; safe to re-run.
- `REVERSIBLE`: a clean inverse exists.
- `COMPENSATABLE`: an offsetting action exists, but history is not erased.
- `IRREVERSIBLE`: cannot be undone and requires explicit approval before execution.

## Journal model

The journal is append-only. Causality is based on monotonically increasing `seq`, not timestamps.
The browser demo uses `IndexedDbJournal`; `MemoryJournal` remains the default/test
implementation of the same `Journal` abstraction.

Events:

- `STEP_STARTED`
- `STEP_SUCCEEDED`
- `STEP_FAILED`
- `STEP_GATED`
- `DUPLICATE_PREVENTED`
- `RECOVERY_STARTED`
- `RECOVERY_SUCCEEDED`
- `RECOVERY_FAILED`
- `APPROVAL_GRANTED`

## Idempotency contract

The core derives an idempotency key from:

```text
workflow id + step id + execution generation + canonicalized args
```

A journaled successful execution short-circuits subsequent identical calls within the
same execution generation. A successful REVERSIBLE or COMPENSATABLE recovery advances
that step's generation, so intentionally executing the same step and args afterward
receives a fresh deterministic key. A failed recovery does not advance the generation.

This does **not** make arbitrary external systems exactly-once by itself. A real side-effecting integration must also honor the key (or provide an equivalent transactional guarantee). The deterministic demo backend honors this contract and persists its idempotency map in IndexedDB.

## Browser persistence assumptions

- Journal events live in the demo-specific `selective-recovery-demo` IndexedDB
  database and are isolated by the exact workflow id `onboard_maya_v1`.
- Simulated backend state, backend idempotency results, and the human recovery
  proposal (including its journaled approval id after approval) live in the
  separate demo-specific `selective-recovery-demo-state` IndexedDB database.
- IndexedDB structured cloning is the serialization boundary. Journal append and
  backend writes reject values that the browser cannot clone; reads return clones
  so callers cannot mutate persisted values by reference.
- Journal order is the auto-incremented `seq`; timestamps are informational only.
  Appends resolve only after their read/write transaction commits.
- A simulated backend effect and its idempotency result commit atomically in one
  IndexedDB record update. The later journal success is a separate transaction.
  If a page closes in that gap, retry reaches the persisted backend idempotency
  entry and does not repeat the side effect.
- Human approval is authoritative in the append-only journal. The proposal record
  persists the UI recovery choice and approval id needed by the normal resume path.
- `Reset demo` clears only the fixed workflow id from its journal and deletes only
  the backend and proposal records in the demo-state database. It does not clear
  localStorage, sessionStorage, cookies, unrelated records, or unrelated IndexedDB
  databases.

## Recovery-plan output

After Monday orientation fails, the expected plan is conceptually:

```json
{
  "failedStep": "book_orientation",
  "preserve": [
    "create_employee",
    "create_workspace",
    "assign_figma",
    "order_laptop"
  ],
  "recover": {
    "step": "book_orientation",
    "options": ["RETRY", "REPLACE_INPUT"]
  },
  "blocked": [
    {
      "step": "send_welcome_email",
      "reason": "IRREVERSIBLE_REQUIRES_HUMAN_APPROVAL"
    }
  ],
  "resumePoint": "book_orientation"
}
```

## Human authority

The WebMCP agent may create a recovery proposal. It cannot approve its own consequential recovery.

The visible page records the human approval, after which the agent may call `resume_onboarding`.

The current build deliberately uses an in-page approval gate instead of depending on the still-changing WebMCP elicitation API.
