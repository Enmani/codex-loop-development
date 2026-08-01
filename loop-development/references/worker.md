# Worker Role

## Accept the assignment

Require a valid `STAGE_ASSIGN` event from the delegation source. Confirm that the stage, attempt, plan paths, write set, contract locks, acceptance criteria, and verification commands are present. Ask the foreman only when a missing fact would materially change implementation.

Treat the foreman as the only acceptance and next-stage authority. Do not create other implementation tasks.

## Execute one stage

1. Read governing repository instructions and the assigned plan/checklist leaf.
2. Inspect current code and active-thread coordination before editing.
3. Work only inside the assigned scope and compatible write set.
4. Preserve unrelated user and peer changes.
5. Implement the stage and run its required verification.
6. Update repository documentation or checklist evidence only when the assignment or repository rules make that part of the write set.
7. Do not commit, push, branch, or create a worktree unless explicitly authorized.

## Handoff

After the last repository write and verification:

1. Use `$cross-thread-status-signal` when available to set `ready_for_review` with a concise evidence note.
2. Create a stable `reportId` from run, stage, and attempt. Send the foreman a message beginning with `$loop-development` and a valid `STAGE_REPORT_READY` envelope whose receiver role is `foreman`, exact `targetThreadId` is the registered foreman, and `requiredAction` is `START_OR_RESUME_REVIEW`.
3. Include changed files, verification commands/results, checklist evidence, unresolved risks, and any relevant existing failures.
4. Make that message the last tool action. After it succeeds, perform no more writes or commands and immediately return a concise final response.

If cross-task messaging fails, return `HANDOFF_SEND_FAILED` with the exact stage, attempt, `reportId`, evidence, and target task ID so the monitor can recover the missing transition.

If asked to resend, do not present the same payload as a new report. Send a `DELIVERY_RETRY` with a new `eventId`, the original `reportId`, the exact foreman target, and `requiredAction=START_OR_RESUME_REVIEW`. Include only enough evidence to locate the original report.

## Blocked work

When genuinely blocked:

1. Use `$cross-thread-status-signal` when available to set `blocked` with the concrete dependency or decision.
2. Send a `STAGE_BLOCKED` event with receiver `role=foreman` to the foreman as the last tool action.
3. Finish the turn without inventing authority or broadening scope.

Difficulty, incomplete work, or a desirable clarification is not automatically a blocker. Continue safe in-scope work first.

## Rework

On a valid `STAGE_REWORK` event from the registered foreman:

1. Validate receiver `role=worker`, `runId`, stage, source task, and incremented attempt.
2. Re-read current files; other work may have landed since the prior handoff.
3. Address the precise failed acceptance points without reverting unrelated changes.
4. Re-run required verification.
5. Send a new `STAGE_REPORT_READY` with a new `reportId` for the new attempt as the final tool action, then finish.

Ignore duplicate or stale rework events that target an already superseded or later attempt.
