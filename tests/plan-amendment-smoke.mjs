#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateStore = path.join(root, "loop-development", "scripts", "state-store.mjs");
const planFingerprint = path.join(root, "loop-development", "scripts", "plan-fingerprint.mjs");
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "loop-development-plan-"));
const env = { ...process.env, CODEX_HOME: codexHome };
const runId = "plan-amendment-smoke";

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [stateStore, ...args], { env, encoding: "utf8" });
  assert.equal(result.status, expectedStatus, `command failed: ${args.join(" ")}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function fingerprint(files) {
  const result = spawnSync(process.execPath, [planFingerprint, JSON.stringify(files)], { env, encoding: "utf8" });
  assert.equal(result.status, 0, `fingerprint failed: ${result.stderr}`);
  assert.match(result.stdout.trim(), /^sha256:[a-f0-9]{64}$/);
  return result.stdout.trim();
}

try {
  const planFile = path.join(codexHome, "plan.md");
  const checklistFile = path.join(codexHome, "checklist.md");
  fs.writeFileSync(planFile, "# Plan v1\n\nG08 depends on G07B.\n", "utf8");
  fs.writeFileSync(checklistFile, "# Checklist v1\n", "utf8");
  const planFiles = [planFile, checklistFile];
  const initialFingerprint = fingerprint(planFiles);
  assert.equal(fingerprint(planFiles), initialFingerprint, "fingerprint must be deterministic");

  const initial = {
    schemaVersion: 2,
    runId,
    status: "running",
    foremanThreadId: "foreman-1",
    leadership: {
      epoch: 1,
      status: "active",
      activeForemanThreadId: "foreman-1",
      previousForemanThreadIds: [],
      repair: null,
      lastRepair: null,
      takeover: null,
      lastTakeover: null
    },
    project: { projectId: "project-1", cwd: "C:/repo", environmentType: "local" },
    workerProfile: { model: "gpt-5.6-luna", thinking: "max" },
    monitorThreadId: "monitor-1",
    automationId: "automation-1",
    auxiliaryAutomationIds: [],
    planFiles,
    planRevision: 1,
    planFingerprint: initialFingerprint,
    lastPlanChange: null,
    decisionLedger: [],
    reportDecisions: {},
    accepted: ["G07B"],
    active: {},
    returned: {},
    blocked: { G08: { reason: "missing production evidence supplier" } },
    ready: [],
    expectedNext: { actorThreadId: "foreman-1", type: "PLAN_RECONCILE", gapId: "gap-G08-provider", since: "2026-08-02T00:00:00.000Z" },
    automationShutdown: null
  };

  const created = run(["init", runId, JSON.stringify(initial)]);
  assert.equal(created.planRevision, 1);

  const technicalChange = {
    gapId: "gap-G08-provider",
    changeId: "plan-change-2",
    fromRevision: 1,
    toRevision: 2,
    reason: "add missing product-current evidence supplier before G08",
    changedAt: "2026-08-02T00:01:00.000Z",
    changedByForemanThreadId: "foreman-1",
    classification: "technical-closure",
    affectedStageIds: ["G07C", "G08"],
    changedFiles: planFiles,
    approvalEventId: null
  };
  fs.writeFileSync(planFile, "# Plan v2\n\nG07C supplies evidence; G08 depends on G07C.\n", "utf8");
  const revisedFingerprint = fingerprint(planFiles);
  assert.notEqual(revisedFingerprint, initialFingerprint, "changed plan content must change the fingerprint");
  const revised = {
    ...created,
    planRevision: 2,
    planFingerprint: revisedFingerprint,
    lastPlanChange: technicalChange,
    planGapDecisions: {
      "gap-G08-provider": {
        reportId: "G08-gap-1",
        status: "applied",
        classification: "technical-closure",
        changeId: "plan-change-2",
        toPlanRevision: 2
      }
    },
    blocked: {},
    ready: ["G07C"],
    expectedNext: { actorThreadId: "foreman-1", type: "STAGE_ASSIGN", stageId: "G07C", since: "2026-08-02T00:01:00.000Z" }
  };
  const written = run(["write", runId, "0", "foreman-1", "1", JSON.stringify(revised)]);
  assert.equal(written.planRevision, 2);
  assert.equal(written.lastPlanChange.classification, "technical-closure");
  assert.deepEqual(written.ready, ["G07C"]);

  run(["write", runId, "1", "foreman-1", "1", JSON.stringify({ ...written, planFingerprint: "sha256:unversioned-change" })], 1);
  run(["write", runId, "1", "foreman-1", "1", JSON.stringify({ ...written, planFiles: [...written.planFiles].reverse() })], 1);
  run(["write", runId, "1", "foreman-1", "1", JSON.stringify({ ...written, planRevision: 4 })], 1);
  run(["write", runId, "1", "foreman-old", "1", JSON.stringify({ ...written, planRevision: 3 })], 1);
  const repeatedGapChange = {
    ...technicalChange,
    changeId: "plan-change-duplicate-gap",
    fromRevision: 2,
    toRevision: 3
  };
  run(["write", runId, "1", "foreman-1", "1", JSON.stringify({
    ...written,
    planRevision: 3,
    planFingerprint: "sha256:duplicate-gap",
    lastPlanChange: repeatedGapChange,
    planGapDecisions: {
      ...written.planGapDecisions,
      "gap-G08-provider": {
        ...written.planGapDecisions["gap-G08-provider"],
        changeId: repeatedGapChange.changeId,
        toPlanRevision: 3
      }
    }
  })], 1);
  const waiting = run(["write", runId, "1", "foreman-1", "1", JSON.stringify({
    ...written,
    status: "awaiting_user",
    awaitingUserGate: {
      gateId: "plan-gate-3",
      proposalId: "plan-proposal-3",
      kind: "plan-amendment",
      reportId: "G08-gap-1",
      requestedAt: "2026-08-02T00:02:00.000Z",
      requestedChanges: ["weaken production evidence", "add paid external service"]
    },
    planGapDecisions: {
      ...written.planGapDecisions,
      "gap-G08-external": {
        reportId: "G08-gap-2",
        status: "awaiting_user",
        classification: "user-approved",
        changeId: "plan-change-3"
      }
    },
    expectedNext: null
  })]);
  assert.equal(waiting.status, "awaiting_user");
  assert.equal(waiting.expectedNext, null);
  assert.equal(waiting.planRevision, 2);
  const unapprovedUserChange = {
    ...technicalChange,
    gapId: "gap-G08-external",
    changeId: "plan-change-3",
    fromRevision: 2,
    toRevision: 3,
    reason: "replace required production evidence with a paid external shortcut",
    classification: "user-approved",
    approvalEventId: null
  };
  run(["write", runId, "2", "foreman-1", "1", JSON.stringify({
    ...waiting,
    planRevision: 3,
    planFingerprint: "sha256:requires-user-approval",
    lastPlanChange: unapprovedUserChange,
    planGapDecisions: {
      ...waiting.planGapDecisions,
      "gap-G08-external": {
        ...waiting.planGapDecisions["gap-G08-external"],
        status: "applied",
        toPlanRevision: 3
      }
    }
  })], 1);

  const legacyRunId = "plan-amendment-legacy";
  const legacy = { ...initial, runId: legacyRunId, schemaVersion: 1 };
  delete legacy.leadership;
  delete legacy.planRevision;
  delete legacy.planFingerprint;
  delete legacy.lastPlanChange;
  const migrated = run(["init", legacyRunId, JSON.stringify(legacy)]);
  assert.equal(migrated.planRevision, 1);
  assert.equal(migrated.planFingerprint, null);
  assert.equal(migrated.lastPlanChange, null);

  process.stdout.write("Plan amendment smoke test passed.\n");
} finally {
  fs.rmSync(codexHome, { recursive: true, force: true });
}
