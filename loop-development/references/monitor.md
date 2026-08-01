# Monitor Role

## Boundary

Act only as a watchdog for a single `runId`. Never become the foreman.

Do not:

- edit repository files;
- run builds or tests;
- review or accept implementation;
- create, replace, or archive implementation tasks;
- choose the next stage;
- cross a user gate;
- infer membership from titles alone.

Learn the foreman task ID from the bootstrap delegation source. Accept `MONITOR_CONFIG` only from that task. Keep the monitor projectless so normal polling does not enter the repository task context.

## Heartbeat procedure

On each scheduled run:

1. Read the durable run state first, then use the foreman's latest complete `LOOP_STATE` as a consistency check.
2. Resolve current workers from its exact task IDs and, when needed, delegation/source relationships.
3. Read compact immediate task-status snapshots. Do not repeatedly read unchanged histories.
4. If the foreman or any current worker is making ordinary progress, return `NO_OP`.
5. If the run is `awaiting_user`, return `NO_OP`.
6. If the run is `completed` or `aborted`, set the primary and every recorded auxiliary loop automation to `INACTIVE`, verify the stop, and return `MONITOR_STOPPED`. Do not send reminders or create recovery tasks.
7. Otherwise identify the single oldest missing expected transition from `expectedNext` and verified task evidence.

Use these default stale thresholds unless `MONITOR_CONFIG` overrides them:

- Ordinary idle gap before a reminder: 15 minutes.
- Delivered report without `REVIEW_STARTED`: 5 minutes while the foreman is idle.
- `REVIEW_STARTED` without `STAGE_DECISION`: 30 minutes while the foreman is idle; do not interrupt an active review unless the active-turn stall rule also fires.
- Rework or acceptance without the corresponding worker activation or next assignment: 5 minutes while the responsible task is idle.
- Same active turn before suspecting a stall: more than 90 minutes and two consecutive unchanged observations.
- Same-issue reminder cooldown: 60 minutes.
- Maximum reminders for the same unchanged issue: two; after that report `NEEDS_USER` in the monitor task and stop nudging it.

## Missing-transition table

| Observed execution state | Expected actor | Allowed watchdog action |
|---|---|---|
| Stage assigned; registered worker idle/finished; no handoff | Worker | Send one `WATCHDOG_NUDGE` asking it to deliver or report the handoff |
| Valid report delivered; foreman idle; no `REVIEW_STARTED` | Foreman | Send one `WATCHDOG_NUDGE` with the `reportId` and `requiredAction=START_OR_RESUME_REVIEW` |
| Review started; foreman idle; no decision | Foreman | Send one `WATCHDOG_NUDGE` with `requiredAction=RESUME_REVIEW_AND_DECIDE` |
| Stage returned; same worker idle; no new handoff | Worker | Send one `WATCHDOG_NUDGE` asking it to resume the recorded attempt |
| Stage accepted; ready stages exist; foreman idle; no dispatch or gate | Foreman | Send one `WATCHDOG_NUDGE` asking it to reconcile and continue |
| Active task appears stalled by threshold | Foreman | Send one `STUCK_SUSPECT`; do not create a replacement |
| State is ambiguous after restart, state is malformed, or task lookup disagrees | Foreman | Send one `RECOVERY_RECONCILE`; do not replay the report |

Begin every nudge with `$loop-development` and a valid event envelope whose `role` names the receiving handler (`foreman` or `worker`). Include the issue key, exact target task, related stage/attempt/report ID, observed state, missing transition, and `requiredAction`. A nudge asks the responsible task to run its own role protocol; it must not contain an acceptance or dispatch decision or copy the full worker report.

Send at most one cross-task message per heartbeat. Record issue key, observation, reminder count, and timestamp in the monitor conversation so later heartbeats can enforce cooldown without polluting the foreman.

## Source and state checks

- Trust exact task IDs from `LOOP_STATE`, not similarly named tasks in the same repository.
- Treat `idle` and `notLoaded` as non-terminal until a handoff or decision event proves completion.
- Ignore unrelated workers from other runs.
- If the latest foreman snapshot is malformed, ask the foreman to re-emit it; do not reconstruct acceptance from worker claims.
- On the first heartbeat after app/server recovery, reconcile the durable state's `expectedNext` against actual delivery and decision events. Emit only the one missing control event.
- Treat a valid `RUN_COMPLETE` or durable `status=completed` as terminal. Idempotently stop only still-active recorded automations; never delete them, and never restart or replace a monitor for a terminal run.
- If message delivery fails, report the target and failure in the monitor task. Do not retry repeatedly in the same heartbeat.
