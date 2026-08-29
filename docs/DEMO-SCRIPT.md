# Demo script

## Opening

> AI agents are learning to act on websites. But real workflows do not always finish cleanly.

Prompt:

> Onboard Maya, our new designer, for Monday.

## Failure beat

The live timeline should show:

```text
✓ Create employee account
✓ Create workspace account
✓ Assign design software licence
✓ Order laptop
× Book orientation — Monday is fully booked
○ Send welcome email
```

Voiceover:

> Four valid workflow actions have already succeeded. Restarting can duplicate them. Rolling everything back destroys valid work.

## Recovery beat

Agent reads `get_recovery_plan`, then `search_orientation_slots`, then proposes Tuesday.

The page shows the human decision:

> Keep the completed setup, book Tuesday, then send Maya the welcome email.

Human clicks **Approve recovery**.

Agent calls `resume_onboarding`.

## Finish

Timeline:

```text
✓ Create employee account
✓ Create workspace account
✓ Assign design software licence
✓ Order laptop
✓ Book orientation — Tuesday
✓ Send welcome email
```

Proof panel should make the result obvious:

- one employee
- one placed laptop order
- one welcome email
- Tuesday orientation
- four earlier actions preserved
- failed logical step recovered

Closing idea:

> Preserve the valid work. Recover the broken part. Continue safely.

Do not spend video time explaining sagas or distributed systems. Put that context in the README.
