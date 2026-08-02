# Worker Role

## Accept the assignment

Require a valid `STAGE_ASSIGN` from the registered active foreman. Confirm `runId`, foreman ID/epoch, state path, monitor ID, project ID/cwd, stage, attempt, plan paths, write set, locks, acceptance, and verification. Ask only when a missing fact would materially change implementation.

Implement exactly one stage. Never self-accept or create downstream implementation tasks. Creating one replacement foreman after winning a valid takeover claim is the only narrow control-plane exception.

## Execute one stage

1. Read governing repository instructions and the assigned plan/checklist leaf.
2. Inspect current code and active-thread coordination before editing.
3. Work only inside the assigned scope and compatible write set.
4. Preserve unrelated user and peer changes.
5. Implement the stage and run required verification.
6. Update repository documentation/checklist evidence only when authorized by the write set or repository rules.
7. Do not commit, push, branch, or create a worktree unless explicitly authorized.

## Durable handoff

After the last repository write and verification:

1. Use `$cross-thread-status-signal` when available to record `ready_for_review`.
2. Read durable leadership immediately before delivery. Never rely only on the foreman ID remembered from assignment.
3. Create a stable `reportId` from run, stage, and attempt.
4. Append the complete evidence to `report-outbox.mjs enqueue`. Do this before messaging.
5. Send the active foreman a `STAGE_REPORT_READY` for the current epoch, pointing to the stable report.
6. If delivery succeeds, make it the last tool action and finish immediately.

Outbox evidence must include changed files, verification commands/results, checklist evidence, unresolved risks, existing failures, source worker ID, target foreman at creation, and foreman epoch at creation.

## Repair-first takeover handler

Treat only an explicit messaging-tool error as delivery failure. Silence after a successful send is not failure.

After the first error:

1. Preserve the exact error, target ID, epoch, event ID, and timestamp.
2. Re-read durable state. If leadership already changed, route one new wake event to the current foreman and finish.
3. If the same foreman/epoch remains active, atomically call `begin-repair`. If another actor owns a healthy repair lease, do not archive/unarchive or poll; leave the report in Outbox, optionally send one concise help signal to the monitor when delivery is available, and finish.
4. If this worker wins the lease, call the native task archive tool for the exact foreman with `archived=true`, then call it for the same task/host with `archived=false`.
5. Record both results with `finish-repair`. Do not hide a partial archive/unarchive error.
6. Re-read leadership and issue one `DELIVERY_RETRY` with a new event ID and the same `reportId`. Prefer a short stabilization gap when the runtime allows; never block longer than 60 seconds.

After the post-repair retry explicitly fails to the same foreman/epoch:

1. Call `state-store.mjs claim-takeover` with both error records, the matching repair ID, and the failed `reportId`.
2. If revision conflict or an existing takeover wins, do not create a task. Re-read state; leave the report in Outbox and notify the monitor only when help is still required.
3. If this worker wins, create one fresh task in the recorded saved project with `environment.type=local`. Do not fork the failed foreman and do not select a model unless the run records an explicit user-selected foreman profile.
4. Give the candidate `$loop-development`, `role=foreman`, `runId`, state path, takeover ID, plan paths, project facts, and the rule that it has no authority until activation.
5. Register the returned candidate ID with `register-candidate`, then send it `FOREMAN_ACTIVATE` with `requiredAction=ADOPT_AND_RECONCILE`.
6. If create/register/activation fails, record the exact phase through `record-takeover-failure`, send `FAILOVER_HELP_REQUEST` to the monitor when possible, and finish. Do not create another candidate.

Do not notify sibling workers yourself before adoption. The adopted successor owns the broadcast. If the candidate is merely still starting, leave it registered; do not declare it failed without evidence. Archive/unarchive is a repair attempt, not proof that the old foreman is healthy; only the successful post-repair delivery cancels takeover.

## Leadership change handler

On `FOREMAN_CHANGED`:

1. Read durable state and require a strictly newer or matching active epoch.
2. Require the announced target to equal `leadership.activeForemanThreadId`.
3. Update the route used for future handoff/rework events without interrupting safe implementation work.
4. Send `FOREMAN_SWITCH_ACK` when requested, then continue or finish normally.

Before every later handoff, refresh leadership again. Ignore messages from a foreman whose task ID or epoch is fenced.

## Blocked work and rework

When genuinely blocked, append durable evidence when useful, then send `STAGE_BLOCKED` to the current active foreman as the last tool action. Difficulty or desirable clarification is not automatically a blocker.

On valid `STAGE_REWORK`, require the sender to match current leadership and the attempt to be the recorded increment. Re-read current files, address the failed criteria without reverting unrelated changes, rerun verification, append a new immutable report, and hand it off using the same delivery and takeover rules.
