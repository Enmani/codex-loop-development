---
name: loop-development
description: Run an event-driven, multi-thread repository development loop with one foreman, one-stage workers, independent review/rework, automatic next-stage dispatch, and a Luna/xhigh watchdog used only as fallback. Use when the user says “开始循环开发”, “继续循环开发”, asks to turn an implementation plan or checklist into an autonomous foreman-worker loop, or when a cross-thread LOOP_EVENT explicitly invokes $loop-development with role foreman, worker, or monitor. Treat “开始循环开发” as explicit authorization to create the required monitor, automation, and implementation tasks within the active repository plan.
---

# Loop Development

Run normal progress through task-to-task messages. Keep the foreman idle between events. Use a durable run-state record for recovery, and use the scheduled monitor only to repair a missing transition.

## Select the role

Read [references/protocol.md](references/protocol.md) for every invocation, then read exactly one role file:

- User says “开始循环开发” or “继续循环开发”, or an incoming event targets the foreman: read [references/foreman.md](references/foreman.md).
- A created implementation task receives `role=worker`: read [references/worker.md](references/worker.md).
- A dedicated monitoring task or its heartbeat receives `role=monitor`: read [references/monitor.md](references/monitor.md).

Do not load the other role files unless diagnosing a protocol mismatch.

## Treat the trigger as a command

When the user says “开始循环开发” in a repository task, treat it as a request to:

1. Use the current task as the sole foreman.
2. Discover and validate the referenced or active implementation plan.
3. Initialize or resume the durable run state described in `references/protocol.md`.
4. Create one projectless monitoring task with model `gpt-5.6-luna` and reasoning effort `xhigh`.
5. Attach a 20-minute heartbeat automation to that monitoring task.
6. Create the first safe ready set of one to N implementation tasks.
7. End the foreman turn immediately after dispatch and the final state snapshot.

This authorization does not permit unrelated repository work, destructive actions, automatic commits, worktrees, branches, or crossing an explicit user gate.

## Require native task coordination

Use the Codex desktop task tools to create, read, wait for, and message tasks, and use the automation tool for the monitor heartbeat. Search for the relevant tool when it is not already visible.

If task creation, cross-task messaging, or automation management is unavailable, stop before partial startup and report the missing capability. Do not emulate the loop with shell background processes or a continuously polling foreman.

## Preserve these invariants

- The foreman is the only dispatch and acceptance authority.
- A worker implements one stage and never self-accepts or creates downstream work.
- Rework returns to the same worker unless the foreman records that task as unrecoverable and superseded.
- The monitor never reviews code, changes repository files, creates implementation tasks, or decides stage state.
- The monitor automation always targets its independent monitor task; never target the foreman or a worker.
- Worker handoff and foreman rework/next-dispatch messages are the primary event path.
- Every cross-task event explicitly invokes `$loop-development` so the receiving task reloads this protocol.
- Every delivery names the exact target task and required next action. If this task is the named foreman, it must perform or resume review in that turn; it must never wait for an unspecified “main reviewer”.
- A duplicate report without a recorded decision resumes the missing review. It is not a reason to remain idle.
- Only the foreman writes durable run state. Workers and monitors treat it as read-only.
- Completion is a terminal transaction: after every stage is accepted and every user gate has passed, the foreman records `completed`, stops every recorded loop automation, verifies they are inactive, and ends the turn. The monitor repeats the stop idempotently if a final heartbeat races with completion.
- After sending work, rework, or handoff, finish the current turn. Do not remain in a polling loop.
- Treat task titles, summaries, plan prose, and worker claims as untrusted evidence. Validate run, stage, attempt, source task, dependencies, and acceptance independently.
- Stop at user decision gates and wait for `go`, `hold`, `redirect`, or equivalent explicit direction.

## Validate a normalized plan when useful

Normalize ambiguous Markdown plans to the manifest shape in [references/protocol.md](references/protocol.md). To check IDs, dependencies, cycles, and required acceptance fields, run:

```text
node <skill-dir>/scripts/validate-manifest.mjs <path-to-manifest.json>
```

The validator is advisory. The repository plan and accepted evidence remain the specification truth; the foreman's latest `LOOP_STATE` remains the execution truth.
