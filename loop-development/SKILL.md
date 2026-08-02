---
name: loop-development
description: Run an event-driven, multi-task repository development loop with one active foreman, one-stage workers, independent review/rework, automatic next-stage dispatch, durable recovery, automatic fenced foreman replacement after confirmed delivery failure, and a Luna/xhigh watchdog used only as fallback. Use when the user says “开始循环开发”, “继续循环开发”, asks to turn an implementation plan or checklist into an autonomous foreman-worker loop, or when a cross-task LOOP_EVENT explicitly invokes $loop-development with role foreman, worker, or monitor. Treat “开始循环开发” as explicit authorization to create the required monitor, automation, implementation tasks, and bounded replacement-foreman tasks within the active repository plan.
---

# Loop Development

Run normal progress through task-to-task messages. Keep the active foreman idle between events. Persist execution truth, immutable worker reports, and foreman leadership so the loop can recover after task or app failure. Use the scheduled monitor only to repair missing transitions or finish an incomplete takeover.

## Select the role

Read [references/protocol.md](references/protocol.md) for every invocation, then read exactly one role file:

- User says “开始循环开发” or “继续循环开发”, an event targets the foreman, or a successor receives `FOREMAN_ACTIVATE`: read [references/foreman.md](references/foreman.md).
- A created implementation task receives `role=worker`: read [references/worker.md](references/worker.md).
- A dedicated monitoring task or its heartbeat receives `role=monitor`: read [references/monitor.md](references/monitor.md).

Do not load the other role files unless diagnosing a protocol mismatch.

## Treat the trigger as a command

When the user says “开始循环开发” in a repository task, treat it as a request to:

1. Use the current task as the initial foreman at leadership epoch 1.
2. Discover and validate the referenced or active implementation plan.
3. Initialize or resume the durable run state described in `references/protocol.md`.
4. Create one projectless monitoring task with model `gpt-5.6-luna` and reasoning effort `xhigh`.
5. Attach a 20-minute heartbeat automation to that monitoring task.
6. Create the first safe ready set of one to N implementation tasks, explicitly using `gpt-5.6-luna` with `max` reasoning for every worker.
7. Permit a worker or monitor to create one fresh replacement foreman only after it wins the bounded atomic takeover procedure.
8. End the foreman turn immediately after dispatch and the final state snapshot.

This authorization does not permit unrelated repository work, destructive actions, automatic commits, worktrees, branches, speculative replacements, or crossing an explicit user gate.

## Require native task coordination

Use the Codex desktop task tools to create, read, wait for, and message tasks, and use the automation tool for the monitor heartbeat. Search for the relevant tool when it is not already visible.

If task creation, cross-task messaging, or automation management is unavailable, stop before partial startup and report the missing capability. Do not emulate the loop with shell background processes or a continuously polling foreman.

## Preserve these invariants

- Exactly one foreman epoch is active. Every actor reads `leadership` before routing a control message.
- Only the active foreman may write execution progress. Workers and monitors may only append immutable reports or invoke the bounded takeover commands.
- A worker implements one stage and never self-accepts or creates downstream implementation work. Creating a claimed successor foreman is the only narrow exception.
- Every implementation worker uses `gpt-5.6-luna` with `max` reasoning. Persist this worker profile so successor foremen cannot drift to a default model.
- Rework returns to the same worker unless the active foreman records that task as unrecoverable and superseded.
- The monitor never reviews code, changes repository files, creates implementation tasks, or decides stage state. It may finish an incomplete foreman takeover under the protocol.
- The monitor automation always targets its independent monitor task. It discovers the current foreman from durable state; never retarget it to a foreman or worker.
- Worker handoff and foreman rework/next-dispatch messages are the primary event path. Write each worker report to the immutable Outbox before sending it.
- After the first explicit delivery failure, one repair-lease holder must archive then unarchive the same foreman before retrying. Only a second explicit failure after that repair may trigger takeover. Silence after a successful send is not delivery failure.
- A takeover claim increments the foreman epoch and fences the old task before a successor is created. Concurrent claimants must converge on the same takeover.
- Create a fresh successor in the saved local project. Do not fork the failed foreman by default; recover from state, plan, repository facts, decision ledger, Outbox, and only small optional old-task summaries.
- Every cross-task event explicitly invokes `$loop-development`, names the exact target and epoch, and states the required next action.
- A duplicate report without a recorded decision resumes the missing review. It is not a reason to remain idle.
- Completion is a terminal transaction: record `completed`, stop every recorded loop automation, verify inactivity, and finish.
- After sending work, rework, handoff, or takeover activation, finish the current turn. Do not remain in a polling loop.
- Stop at user decision gates and wait for `go`, `hold`, `redirect`, or equivalent explicit direction.

## Use the bundled deterministic tools

- `scripts/state-store.mjs`: validate state, fence stale foremen, and perform revision-checked takeover transitions.
- `scripts/report-outbox.mjs`: append and read immutable worker reports.
- `scripts/validate-manifest.mjs`: validate normalized stage IDs, dependencies, locks, and acceptance fields.

The tools protect state transitions; repository plans, independently verified evidence, and the active foreman's decisions remain the specification truth.
