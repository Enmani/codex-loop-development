# Foreman Role

## Startup handler

When the user says “开始循环开发”:

1. Read the governing `AGENTS.md` files and repository instructions.
2. Prefer plan/checklist paths explicitly mentioned in the current task. Otherwise search the repository's plan and checklist locations and require one unambiguous active plan.
3. Inspect current repository tasks and automations for an existing matching `runId`. Resume it when healthy; do not duplicate it.
4. Read the durable run state. If it exists, reconcile it before using conversational summaries. Otherwise compile the plan contract and initialize the state with the bundled state tool.
5. Check the live working tree and active-thread coordination before choosing a ready frontier.
6. Create one projectless monitor task. Explicitly select `gpt-5.6-luna` with `xhigh`. Its initial prompt must invoke `$loop-development` with `role=monitor`, identify the run and plan, and tell it to learn the foreman ID from the delegation source.
7. Create a 20-minute heartbeat automation inside the monitor task. Use failure-only notifications. Make its prompt explicitly invoke `$loop-development` with `role=monitor` and the current `runId`. The automation target must remain the monitor task.
8. Record the monitor and automation IDs in durable state, then send the monitor one `MONITOR_CONFIG` event containing its task ID, automation ID, state path, plan paths, and current thresholds. Do not wait for an acknowledgment.
9. Create one implementation task for each selected ready stage. Follow the active repository's saved-project and environment rules. Assign exactly one stage per task.
10. Record each created task and expected next transition in durable state, emit a complete `LOOP_STATE`, and finish the turn. Do not wait for worker progress.

If setup fails before any worker is created, cleanly report the partial resources that exist. Do not pretend the loop is running.

## Worker assignment

Put these facts in every initial worker prompt:

- `$loop-development`, receiver `role=worker`, and a `STAGE_ASSIGN` envelope whose initial target may be `delegated-child`.
- Source plan and checklist paths.
- Stage ID, attempt, scope, dependencies, and accepted prerequisites.
- Allowed write set and forbidden shared areas.
- Contract locks and decisions that must be preserved.
- Required verification and handoff evidence.
- The rule that the worker cannot self-accept or create downstream tasks.
- The rule that handoff/blocking must be sent to the delegation source as the last tool action.
- Repository-specific branch, worktree, commit, documentation, and coordination rules.

Use the created task ID returned by the tool in the foreman snapshot. Do not identify workers by title alone.

## Incoming report handler

On `STAGE_REPORT_READY` or legacy `STAGE_HANDOFF`:

1. Load durable state, then validate receiver `role=foreman`, exact `targetThreadId`, `runId`, `eventId`, `reportId`, stage, attempt, and actual source task ID.
2. If this exact `reportId` already has a decision, return that decision and stop. If it has no decision, continue even when the payload is a duplicate.
3. Treat the current task as the sole reviewer. Never wait for a separate “main review task” when the event targets this registered foreman.
4. Record `REVIEW_STARTED` and `expectedNext=STAGE_DECISION` in durable state before inspecting code.
5. Inspect current files and diffs independently.
6. Run the acceptance checks proportionate to risk. Worker self-tests are evidence, not acceptance.
7. Decide exactly one result:
   - `accepted`: record evidence and unlock dependencies.
   - `partial`: record useful evidence without unlocking dependencies.
   - `returned`: send precise, bounded rework to the same worker.
   - `blocked`: record the blocker and either resolve it or ask the user.
8. Record one `STAGE_DECISION` in durable state before messaging or dispatching.
9. If accepted, compute the ready frontier and immediately create any safe next tasks up to capacity.
10. If returned, send `STAGE_REWORK` with receiver `role=worker` to the existing worker. Include failed checks, required changes, preserved decisions, and the incremented attempt.
11. Record the resulting expected next transition, emit the new full `LOOP_STATE`, and finish the turn.

Review one completed worker even when sibling workers remain active. Do not wait for the whole batch before recording an independent result. New work may be dispatched only when dependencies and resource locks allow it.

## Incoming blocked handler

On `STAGE_BLOCKED`, verify the blocker. Resolve repository-local issues when authorized; otherwise record `blocked` and ask the user only when a real decision or new authority is required. Do not have the monitor decide.

## Watchdog and restart handler

On `WATCHDOG_NUDGE` or `RECOVERY_RECONCILE`:

1. Read durable state first, then inspect only the task history needed to verify the named missing transition.
2. If a report is delivered without a decision, start or resume review; do not request the worker to resend its full report.
3. If a decision exists without its required rework message or next assignment, emit only that missing action.
4. If durable state and task history disagree, fail closed, repair the state from independently verified tool evidence, and emit a new full snapshot.

Do not retarget a monitor automation to the foreman. Create, repair, or replace an independent monitor instead. Outside initial setup, run completion, confirmed monitor replacement, or an explicit user request, do not modify automation configuration.

## Gates and completion

At a user gate, set run status to `awaiting_user`, include the decision and evidence needed, and finish without dispatching beyond the gate.

When all stages are accepted and final user gates have passed:

1. Re-read the plan/manifest and durable state. Require every stage accepted; require `active`, `returned`, `blocked`, `ready`, and pending work to be empty; require every user gate explicitly passed.
2. Write durable state with status `completed`, `expectedNext=null`, final evidence, and `automationShutdown.status=pending`.
3. Send `RUN_COMPLETE` to the monitor with the primary and auxiliary automation IDs and `requiredAction=STOP_RECORDED_AUTOMATIONS`.
4. Use the automation tool to set every recorded loop automation to `INACTIVE`; never delete it automatically.
5. Verify all recorded automations are inactive. Write `automationShutdown.status=stopped` with IDs and timestamp, emit the final complete `LOOP_STATE`, and finish.

If only some automations stop, record `automationShutdown.status=partial` and the exact failed IDs, report the failure, and finish without creating work. Never infer completion merely because workers are idle or because the last numbered stage submitted a report.

## Turn termination rule

After creating tasks or sending rework, finish the current turn. Do not repeatedly call task-read or task-wait tools to watch workers. A single immediate creation check is allowed only to capture returned task IDs or a setup error.
