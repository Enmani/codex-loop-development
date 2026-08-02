#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const [command, runId, ...args] = process.argv.slice(2);
const schemaVersion = 2;
const lockStaleMs = 10 * 60 * 1000;
const repairLeaseMs = 3 * 60 * 1000;
const takeoverLeaseMs = 5 * 60 * 1000;
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const runStatuses = new Set(["initializing", "running", "awaiting_user", "completed", "aborted"]);
const claimantRoles = new Set(["worker", "monitor"]);
const takeoverReasons = new Set(["two-explicit-delivery-failures", "monitor-confirmed-unreachable"]);
const planChangeClassifications = new Set(["technical-closure", "user-approved"]);
const planGapStatuses = new Set(["reported", "pause_requested", "reconciling", "awaiting_user", "applied", "not_a_plan_gap"]);
const planFingerprintPattern = /^sha256:[a-f0-9]{64}$/;

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function reportFailure(error) {
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}

function stateRoot() {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "loop-development", "runs");
}

function requireRunId(value) {
  if (!runIdPattern.test(value ?? "")) fail("runId must use 1-128 letters, digits, dot, underscore, or hyphen");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value) {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) fail(`${label} must be a non-negative integer`);
  return parsed;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function migrateState(value, expectedRunId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (value.schemaVersion === schemaVersion) {
    return {
      ...value,
      project: value.project ?? null,
      workerProfile: value.workerProfile ?? { model: "gpt-5.6-luna", thinking: "max" },
      planRevision: value.planRevision ?? 1,
      planFingerprint: value.planFingerprint ?? null,
      lastPlanChange: value.lastPlanChange ?? null,
      awaitingUserGate: value.awaitingUserGate ?? null,
      planGapDecisions: value.planGapDecisions ?? {},
      decisionLedger: value.decisionLedger ?? [],
      reportDecisions: value.reportDecisions ?? {},
      leadership: value.leadership
        ? {
            ...value.leadership,
            repair: value.leadership.repair ?? null,
            lastRepair: value.leadership.lastRepair ?? null,
            lastTakeover: value.leadership.lastTakeover ?? null
          }
        : value.leadership
    };
  }
  if (value.schemaVersion !== 1) return value;

  const oldForeman = value.foremanThreadId;
  return {
    ...value,
    schemaVersion,
    runId: value.runId ?? expectedRunId,
    project: value.project ?? null,
    workerProfile: value.workerProfile ?? { model: "gpt-5.6-luna", thinking: "max" },
    planRevision: value.planRevision ?? 1,
    planFingerprint: value.planFingerprint ?? null,
    lastPlanChange: value.lastPlanChange ?? null,
    awaitingUserGate: value.awaitingUserGate ?? null,
    planGapDecisions: value.planGapDecisions ?? {},
    decisionLedger: value.decisionLedger ?? [],
    reportDecisions: value.reportDecisions ?? {},
    leadership: {
      epoch: 1,
      status: "active",
      activeForemanThreadId: oldForeman,
      previousForemanThreadIds: [],
      repair: null,
      lastRepair: null,
      takeover: null,
      lastTakeover: null
    }
  };
}

function validateState(value, expectedRunId) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["state must be an object"];
  if (value.schemaVersion !== schemaVersion) errors.push(`schemaVersion must equal ${schemaVersion}`);
  if (value.runId !== expectedRunId) errors.push("runId does not match the command argument");
  if (!runStatuses.has(value.status)) errors.push("status is invalid");

  const leadership = value.leadership;
  if (!leadership || typeof leadership !== "object" || Array.isArray(leadership)) {
    errors.push("leadership must be an object");
  } else {
    if (!Number.isInteger(leadership.epoch) || leadership.epoch < 1) errors.push("leadership.epoch must be a positive integer");
    if (!new Set(["active", "electing"]).has(leadership.status)) errors.push("leadership.status is invalid");
    if (!stringArray(leadership.previousForemanThreadIds)) errors.push("leadership.previousForemanThreadIds must be a string array");
    if (leadership.status === "active") {
      if (!nonEmptyString(leadership.activeForemanThreadId)) errors.push("active leadership requires activeForemanThreadId");
      if (value.foremanThreadId !== leadership.activeForemanThreadId) errors.push("foremanThreadId must mirror activeForemanThreadId");
      if (leadership.takeover !== null) errors.push("active leadership requires takeover=null");
    }
    if (leadership.status === "electing") {
      if (leadership.activeForemanThreadId !== null) errors.push("electing leadership requires activeForemanThreadId=null");
      if (value.foremanThreadId !== null) errors.push("electing leadership requires foremanThreadId=null");
      if (leadership.repair !== null) errors.push("electing leadership requires repair=null");
      if (!leadership.takeover || typeof leadership.takeover !== "object" || Array.isArray(leadership.takeover)) {
        errors.push("electing leadership requires a takeover object");
      } else {
        const takeover = leadership.takeover;
        if (!nonEmptyString(takeover.takeoverId)) errors.push("takeover.takeoverId is required");
        if (!nonEmptyString(takeover.oldForemanThreadId)) errors.push("takeover.oldForemanThreadId is required");
        if (takeover.toEpoch !== leadership.epoch) errors.push("takeover.toEpoch must equal leadership.epoch");
        if (takeover.fromEpoch !== leadership.epoch - 1) errors.push("takeover.fromEpoch must precede leadership.epoch");
        if (!nonEmptyString(takeover.claimantThreadId)) errors.push("takeover.claimantThreadId is required");
        if (!claimantRoles.has(takeover.claimantRole)) errors.push("takeover.claimantRole is invalid");
        if (!nonEmptyString(takeover.leaseExpiresAt)) errors.push("takeover.leaseExpiresAt is required");
        if (takeover.candidateThreadId !== null && !nonEmptyString(takeover.candidateThreadId)) errors.push("takeover.candidateThreadId must be a string or null");
      }
    }

    if (leadership.repair !== null) {
      const repair = leadership.repair;
      if (!repair || typeof repair !== "object" || Array.isArray(repair)) {
        errors.push("leadership.repair must be an object or null");
      } else {
        if (leadership.status !== "active") errors.push("foreman repair requires active leadership");
        if (!nonEmptyString(repair.repairId)) errors.push("repair.repairId is required");
        if (repair.targetForemanThreadId !== leadership.activeForemanThreadId) errors.push("repair target must be the active foreman");
        if (repair.foremanEpoch !== leadership.epoch) errors.push("repair epoch must equal leadership epoch");
        if (!nonEmptyString(repair.claimantThreadId)) errors.push("repair.claimantThreadId is required");
        if (!claimantRoles.has(repair.claimantRole)) errors.push("repair.claimantRole is invalid");
        if (!nonEmptyString(repair.leaseExpiresAt)) errors.push("repair.leaseExpiresAt is required");
        if (!repair.triggerFailure || typeof repair.triggerFailure !== "object" || Array.isArray(repair.triggerFailure)) errors.push("repair.triggerFailure is required");
      }
    }
  }

  if (value.project !== null) {
    if (!value.project || typeof value.project !== "object" || Array.isArray(value.project)) {
      errors.push("project must be an object or null");
    } else {
      if (!nonEmptyString(value.project.projectId)) errors.push("project.projectId is required");
      if (!nonEmptyString(value.project.cwd)) errors.push("project.cwd is required");
      if (value.project.environmentType !== "local") errors.push("project.environmentType must equal local");
    }
  }

  if (!value.workerProfile || value.workerProfile.model !== "gpt-5.6-luna" || value.workerProfile.thinking !== "max") {
    errors.push("workerProfile must fix workers to gpt-5.6-luna with max thinking");
  }

  if (!Number.isInteger(value.planRevision) || value.planRevision < 1) errors.push("planRevision must be a positive integer");
  if (value.planFingerprint !== null && (typeof value.planFingerprint !== "string" || !planFingerprintPattern.test(value.planFingerprint))) errors.push("planFingerprint must be a canonical sha256 fingerprint or null");
  if (value.lastPlanChange !== null) {
    const change = value.lastPlanChange;
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      errors.push("lastPlanChange must be an object or null");
    } else {
      if (!nonEmptyString(change.changeId)) errors.push("lastPlanChange.changeId is required");
      if (!nonEmptyString(change.gapId)) errors.push("lastPlanChange.gapId is required");
      if (!Number.isInteger(change.fromRevision) || change.fromRevision < 1) errors.push("lastPlanChange.fromRevision must be a positive integer");
      if (change.toRevision !== value.planRevision) errors.push("lastPlanChange.toRevision must equal planRevision");
      if (change.toRevision !== change.fromRevision + 1) errors.push("lastPlanChange revisions must advance by exactly one");
      if (!nonEmptyString(change.reason)) errors.push("lastPlanChange.reason is required");
      if (!nonEmptyString(change.changedAt)) errors.push("lastPlanChange.changedAt is required");
      if (!nonEmptyString(change.changedByForemanThreadId)) errors.push("lastPlanChange.changedByForemanThreadId is required");
      if (!planChangeClassifications.has(change.classification)) errors.push("lastPlanChange.classification is invalid");
      if (!stringArray(change.affectedStageIds) || change.affectedStageIds.length === 0) errors.push("lastPlanChange.affectedStageIds must be a non-empty string array");
      if (!stringArray(change.changedFiles) || change.changedFiles.length === 0) errors.push("lastPlanChange.changedFiles must be a non-empty string array");
      if (change.classification === "technical-closure" && change.approvalEventId != null) errors.push("technical plan changes cannot name an approvalEventId");
      if (change.classification === "user-approved" && !nonEmptyString(change.approvalEventId)) errors.push("user-approved plan changes require approvalEventId");
    }
  }
  if (value.awaitingUserGate !== null && (typeof value.awaitingUserGate !== "object" || Array.isArray(value.awaitingUserGate))) {
    errors.push("awaitingUserGate must be an object or null");
  }
  if (!value.planGapDecisions || typeof value.planGapDecisions !== "object" || Array.isArray(value.planGapDecisions)) {
    errors.push("planGapDecisions must be an object");
  } else {
    for (const [gapId, decision] of Object.entries(value.planGapDecisions)) {
      if (!nonEmptyString(gapId)) errors.push("planGapDecisions keys must be non-empty gap IDs");
      if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
        errors.push(`planGapDecisions.${gapId} must be an object`);
        continue;
      }
      if (!planGapStatuses.has(decision.status)) errors.push(`planGapDecisions.${gapId}.status is invalid`);
      if (decision.classification != null && !planChangeClassifications.has(decision.classification)) errors.push(`planGapDecisions.${gapId}.classification is invalid`);
      if (decision.changeId != null && !nonEmptyString(decision.changeId)) errors.push(`planGapDecisions.${gapId}.changeId must be a string or null`);
      if (decision.status === "applied" && (!nonEmptyString(decision.changeId) || !Number.isInteger(decision.toPlanRevision) || decision.toPlanRevision < 2)) {
        errors.push(`planGapDecisions.${gapId} applied entries require changeId and toPlanRevision`);
      }
    }
  }
  if (value.planRevision > 1 && value.lastPlanChange === null) errors.push("planRevision above 1 requires lastPlanChange");
  if (value.lastPlanChange !== null) {
    const appliedGap = value.planGapDecisions?.[value.lastPlanChange.gapId];
    if (!appliedGap || appliedGap.status !== "applied" || appliedGap.changeId !== value.lastPlanChange.changeId || appliedGap.toPlanRevision !== value.planRevision) {
      errors.push("lastPlanChange requires a matching applied planGapDecisions entry");
    }
  }

  if (value.status !== "initializing" && !nonEmptyString(value.monitorThreadId)) errors.push("monitorThreadId is required after initialization");
  if (value.status !== "initializing" && !nonEmptyString(value.automationId)) errors.push("automationId is required after initialization");
  if (!stringArray(value.auxiliaryAutomationIds)) errors.push("auxiliaryAutomationIds must be a string array");
  if (value.automationShutdown !== null && (typeof value.automationShutdown !== "object" || Array.isArray(value.automationShutdown))) errors.push("automationShutdown must be an object or null");
  if (!stringArray(value.planFiles)) errors.push("planFiles must be a string array");
  if (!stringArray(value.accepted)) errors.push("accepted must be a string array");
  for (const key of ["active", "returned", "blocked", "reportDecisions"]) {
    if (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key])) errors.push(`${key} must be an object`);
  }
  if (!Array.isArray(value.decisionLedger)) errors.push("decisionLedger must be an array");
  if (!stringArray(value.ready)) errors.push("ready must be a string array");
  if (value.expectedNext !== null && (typeof value.expectedNext !== "object" || Array.isArray(value.expectedNext))) errors.push("expectedNext must be an object or null");
  return errors;
}

async function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`invalid ${label} JSON: ${error.message}`);
  }
}

async function readCurrent(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function replaceAtomically(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function acquireLock(lock) {
  await fs.mkdir(path.dirname(lock), { recursive: true });
  try {
    return await fs.open(lock, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const stat = await fs.stat(lock).catch(() => null);
  if (!stat || Date.now() - stat.mtimeMs <= lockStaleMs) fail(`state is locked: ${lock}`);

  const stale = `${lock}.stale.${process.pid}.${Date.now()}`;
  try {
    await fs.rename(lock, stale);
  } catch {
    fail(`state is locked: ${lock}`);
  }
  await fs.rm(stale, { force: true });
  return fs.open(lock, "wx");
}

async function withLock(file, operation) {
  const lock = `${file}.lock`;
  const handle = await acquireLock(lock);
  try {
    await handle.writeFile(`${process.pid} ${nowIso()}\n`, "utf8");
    return await operation();
  } finally {
    await handle.close();
    await fs.rm(lock, { force: true });
  }
}

function validateStoredState(state, runIdValue) {
  const normalized = migrateState(state, runIdValue);
  const errors = validateState(normalized, runIdValue);
  if (errors.length) fail(`invalid stored state: ${errors.join("; ")}`);
  return normalized;
}

async function mutateState(file, expectedRevisionArg, mutator) {
  const expectedRevision = parseNonNegativeInteger(expectedRevisionArg, "expectedRevision");
  return withLock(file, async () => {
    const currentRaw = await readCurrent(file);
    if (!currentRaw) fail(`state not found: ${file}`, 2);
    const current = validateStoredState(currentRaw, runId);
    if (current.revision !== expectedRevision) fail(`revision conflict: expected ${expectedRevision}, found ${current.revision}`);

    const proposed = await mutator(clone(current));
    const next = migrateState(proposed, runId);
    next.schemaVersion = schemaVersion;
    next.runId = runId;
    next.revision = current.revision + 1;
    next.updatedAt = nowIso();
    const errors = validateState(next, runId);
    if (errors.length) fail(`invalid proposed state: ${errors.join("; ")}`);
    await replaceAtomically(file, next);
    return next;
  });
}

function requireActiveLeader(state, actorThreadId, actorEpochArg) {
  const actorEpoch = parseNonNegativeInteger(actorEpochArg, "actorForemanEpoch");
  const leadership = state.leadership;
  if (leadership.status !== "active") fail("execution state cannot be written while foreman election is in progress");
  if (leadership.activeForemanThreadId !== actorThreadId || leadership.epoch !== actorEpoch) {
    fail(`foreman fenced: active leader is ${leadership.activeForemanThreadId} at epoch ${leadership.epoch}`);
  }
}

function sameLeadership(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateFailureEvidence(entries, oldForemanThreadId, oldEpoch) {
  if (!Array.isArray(entries) || entries.length < 2) fail("claim requires at least two explicit failed delivery records");
  const distinct = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("failed delivery evidence must contain objects");
    if (entry.targetThreadId !== oldForemanThreadId) fail("failed delivery target does not match old foreman");
    if (entry.foremanEpoch !== oldEpoch) fail("failed delivery epoch does not match old foreman epoch");
    if (!nonEmptyString(entry.attemptedAt) || !nonEmptyString(entry.error)) fail("failed delivery evidence requires attemptedAt and error");
    if (!nonEmptyString(entry.eventId)) fail("failed delivery evidence requires eventId");
    distinct.add(entry.eventId);
  }
  if (distinct.size < 2) fail("failed delivery evidence must contain two distinct event IDs");
}

function validateSingleFailure(entry, oldForemanThreadId, oldEpoch) {
  validateFailureEvidence([entry, { ...entry, eventId: `${entry?.eventId ?? "missing"}/validation-copy` }], oldForemanThreadId, oldEpoch);
}

async function main() {
  requireRunId(runId);
  const file = path.join(stateRoot(), `${runId}.json`);

  if (command === "path") {
    process.stdout.write(`${file}\n`);
    return;
  }

  if (command === "show") {
    const current = await readCurrent(file);
    if (!current) fail(`state not found: ${file}`, 2);
    process.stdout.write(`${JSON.stringify(validateStoredState(current, runId), null, 2)}\n`);
    return;
  }

  if (command === "init") {
    const source = args[0];
    if (!source) fail("full state JSON is required");
    const proposed = migrateState(await parseJson(source, "state"), runId);
    const timestamp = nowIso();
    proposed.schemaVersion = schemaVersion;
    proposed.runId = runId;
    proposed.revision = 0;
    proposed.updatedAt = timestamp;
    const errors = validateState(proposed, runId);
    if (errors.length) fail(`invalid proposed state: ${errors.join("; ")}`);
    const created = await withLock(file, async () => {
      if (await readCurrent(file)) fail(`state already exists: ${file}`);
      await replaceAtomically(file, proposed);
      return proposed;
    });
    process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    return;
  }

  if (command === "write") {
    const [expectedRevision, actorThreadId, actorEpoch, source] = args;
    if (!source || !nonEmptyString(actorThreadId)) {
      fail("usage: state-store.mjs write <runId> <expectedRevision> <actorForemanThreadId> <actorForemanEpoch> <full-state-json>");
    }
    const proposedInput = migrateState(await parseJson(source, "state"), runId);
    const next = await mutateState(file, expectedRevision, (current) => {
      requireActiveLeader(current, actorThreadId, actorEpoch);
      if (!sameLeadership(current.leadership, proposedInput.leadership)) fail("generic write cannot modify leadership; use takeover commands");
      if (proposedInput.foremanThreadId !== current.foremanThreadId) fail("generic write cannot modify foremanThreadId");
      if (proposedInput.planRevision === current.planRevision) {
        if (JSON.stringify(proposedInput.planFiles) !== JSON.stringify(current.planFiles) || proposedInput.planFingerprint !== current.planFingerprint || JSON.stringify(proposedInput.lastPlanChange) !== JSON.stringify(current.lastPlanChange)) {
          fail("plan metadata cannot change without advancing planRevision");
        }
        const newlyAppliedGap = Object.entries(proposedInput.planGapDecisions).some(([gapId, decision]) => decision?.status === "applied" && current.planGapDecisions?.[gapId]?.status !== "applied");
        if (newlyAppliedGap) fail("an applied plan gap must advance planRevision in the same write");
      } else {
        if (proposedInput.planRevision !== current.planRevision + 1) fail("planRevision must advance by exactly one");
        if (!nonEmptyString(proposedInput.planFingerprint) || proposedInput.planFingerprint === current.planFingerprint) fail("a plan revision requires a new non-empty planFingerprint");
        const change = proposedInput.lastPlanChange;
        if (!change || change.fromRevision !== current.planRevision || change.toRevision !== proposedInput.planRevision) fail("a plan revision requires matching lastPlanChange revisions");
        if (change.changedByForemanThreadId !== actorThreadId) fail("lastPlanChange must name the active foreman writer");
        if (Object.values(current.planGapDecisions ?? {}).some((decision) => decision?.status === "applied" && decision.changeId === change.changeId)) fail("a plan revision requires a new changeId");
        if (current.planGapDecisions?.[change.gapId]?.status === "applied") fail("an applied plan gap cannot advance planRevision again");
        const gapDecision = proposedInput.planGapDecisions?.[change.gapId];
        if (!gapDecision || gapDecision.status !== "applied" || gapDecision.changeId !== change.changeId || gapDecision.toPlanRevision !== proposedInput.planRevision) {
          fail("a plan revision requires a matching applied planGapDecisions entry");
        }
      }
      return proposedInput;
    });
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    return;
  }

  if (command === "begin-repair") {
    const [expectedRevision, source] = args;
    if (!source) fail("repair claim JSON is required");
    const request = await parseJson(source, "repair claim");
    const next = await mutateState(file, expectedRevision, (state) => {
      if (state.status !== "running") fail("automatic foreman repair is allowed only while the run is running");
      const leadership = state.leadership;
      if (leadership.status !== "active") fail("cannot repair a foreman while takeover is in progress");
      if (!nonEmptyString(request.claimantThreadId) || !claimantRoles.has(request.claimantRole)) fail("repair requires claimantThreadId and claimantRole");
      if (request.targetForemanThreadId !== leadership.activeForemanThreadId || request.foremanEpoch !== leadership.epoch) fail("repair targets a stale foreman or epoch");
      validateSingleFailure(request.triggerFailure, request.targetForemanThreadId, request.foremanEpoch);

      const currentRepair = leadership.repair;
      if (currentRepair && Date.parse(currentRepair.leaseExpiresAt) > Date.now()) fail(`foreman repair already in progress: ${currentRepair.repairId}`);

      const startedAt = nowIso();
      const repairId = currentRepair?.repairId ?? `${runId}/foreman/${leadership.epoch}/repair/${state.revision + 1}`;
      leadership.repair = {
        repairId,
        status: "claimed",
        attempt: (currentRepair?.attempt ?? 0) + 1,
        targetForemanThreadId: leadership.activeForemanThreadId,
        foremanEpoch: leadership.epoch,
        claimantThreadId: request.claimantThreadId,
        claimantRole: request.claimantRole,
        triggerFailure: request.triggerFailure,
        startedAt,
        leaseExpiresAt: new Date(Date.now() + repairLeaseMs).toISOString(),
        resumeExpectedNext: currentRepair?.resumeExpectedNext ?? state.expectedNext
      };
      state.expectedNext = {
        actorThreadId: request.claimantThreadId,
        type: "FOREMAN_REPAIR",
        repairId,
        targetThreadId: leadership.activeForemanThreadId,
        foremanEpoch: leadership.epoch,
        since: startedAt
      };
      return state;
    });
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    return;
  }

  if (command === "finish-repair") {
    const [expectedRevision, repairId, source] = args;
    if (!source) fail("repair result JSON is required");
    const result = await parseJson(source, "repair result");
    const next = await mutateState(file, expectedRevision, (state) => {
      const leadership = state.leadership;
      const repair = leadership.repair;
      if (leadership.status !== "active" || repair?.repairId !== repairId) fail("repair is not current");
      if (result.actorThreadId !== repair.claimantThreadId) fail("only the repair claimant may finish this repair");
      if (!new Set(["completed", "failed"]).has(result.status)) fail("repair result status must be completed or failed");
      if (typeof result.archiveSucceeded !== "boolean" || typeof result.unarchiveSucceeded !== "boolean") fail("repair result requires archiveSucceeded and unarchiveSucceeded booleans");
      if (result.status === "completed" && (!result.archiveSucceeded || !result.unarchiveSucceeded)) fail("completed repair requires successful archive and unarchive");
      if (result.status === "failed" && !nonEmptyString(result.error)) fail("failed repair requires an error");

      const finishedAt = nowIso();
      leadership.lastRepair = {
        ...repair,
        status: result.status,
        archiveSucceeded: result.archiveSucceeded,
        unarchiveSucceeded: result.unarchiveSucceeded,
        error: result.error ?? null,
        finishedAt
      };
      leadership.repair = null;
      state.expectedNext = {
        actorThreadId: repair.claimantThreadId,
        type: "DELIVERY_RETRY",
        repairId,
        targetThreadId: repair.targetForemanThreadId,
        foremanEpoch: repair.foremanEpoch,
        since: finishedAt
      };
      return state;
    });
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    return;
  }

  if (command === "claim-takeover") {
    const [expectedRevision, source] = args;
    if (!source) fail("claim JSON is required");
    const claim = await parseJson(source, "claim");
    const next = await mutateState(file, expectedRevision, (state) => {
      if (state.status !== "running") fail("automatic foreman takeover is allowed only while the run is running");
      const leadership = state.leadership;
      if (leadership.status !== "active") fail(`takeover already in progress at epoch ${leadership.epoch}`);
      if (leadership.repair !== null) fail("finish the active archive/unarchive repair before takeover");
      if (!nonEmptyString(claim.claimantThreadId) || !claimantRoles.has(claim.claimantRole)) fail("claimantThreadId and a valid claimantRole are required");
      if (!takeoverReasons.has(claim.reason)) fail("claim reason is invalid");
      if (claim.oldForemanThreadId !== leadership.activeForemanThreadId || claim.oldEpoch !== leadership.epoch) fail("claim targets a stale foreman or epoch");
      validateFailureEvidence(claim.failedDeliveries, claim.oldForemanThreadId, claim.oldEpoch);
      const repair = leadership.lastRepair;
      if (!repair || repair.repairId !== claim.repairId) fail("takeover requires the matching completed archive/unarchive repair");
      if (repair.targetForemanThreadId !== claim.oldForemanThreadId || repair.foremanEpoch !== claim.oldEpoch) fail("repair evidence targets a different foreman or epoch");
      if (repair.triggerFailure?.eventId !== claim.failedDeliveries[0].eventId) fail("repair trigger must match the first failed delivery");
      const secondAttempt = Date.parse(claim.failedDeliveries[1].attemptedAt);
      const repairFinished = Date.parse(repair.finishedAt);
      if (!Number.isFinite(secondAttempt) || !Number.isFinite(repairFinished) || secondAttempt < repairFinished) fail("second failed delivery must occur after repair finished");

      const claimedAt = nowIso();
      const toEpoch = leadership.epoch + 1;
      const takeoverId = `${runId}/foreman/${toEpoch}`;
      const previous = [...new Set([...leadership.previousForemanThreadIds, leadership.activeForemanThreadId])];
      state.leadership = {
        epoch: toEpoch,
        status: "electing",
        activeForemanThreadId: null,
        previousForemanThreadIds: previous,
        repair: null,
        lastRepair: leadership.lastRepair,
        takeover: {
          takeoverId,
          status: "claimed",
          fromEpoch: leadership.epoch,
          toEpoch,
          oldForemanThreadId: leadership.activeForemanThreadId,
          claimantThreadId: claim.claimantThreadId,
          claimantRole: claim.claimantRole,
          reason: claim.reason,
          failedReportId: claim.failedReportId ?? null,
          failedDeliveries: claim.failedDeliveries,
          claimedAt,
          leaseExpiresAt: new Date(Date.now() + takeoverLeaseMs).toISOString(),
          candidateThreadId: null,
          candidateHostId: null,
          failedCandidateThreadIds: [],
          failures: [],
          resumeExpectedNext: leadership.lastRepair?.resumeExpectedNext ?? state.expectedNext
        },
        lastTakeover: leadership.lastTakeover ?? null
      };
      state.foremanThreadId = null;
      state.expectedNext = {
        actorThreadId: "foreman-successor",
        type: "FOREMAN_ACTIVATE",
        takeoverId,
        since: claimedAt
      };
      return state;
    });
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    return;
  }

  if (command === "register-candidate") {
    const [expectedRevision, takeoverId, source] = args;
    if (!source) fail("candidate JSON is required");
    const candidate = await parseJson(source, "candidate");
    const next = await mutateState(file, expectedRevision, (state) => {
      const takeover = state.leadership.takeover;
      if (state.leadership.status !== "electing" || takeover?.takeoverId !== takeoverId) fail("takeover is not current");
      if (!nonEmptyString(candidate.threadId)) fail("candidate.threadId is required");
      if (takeover.candidateThreadId && takeover.candidateThreadId !== candidate.threadId) fail("a different candidate is already registered");
      takeover.candidateThreadId = candidate.threadId;
      takeover.candidateHostId = candidate.hostId ?? null;
      takeover.status = "candidate_created";
      takeover.candidateRegisteredAt = nowIso();
      state.expectedNext = {
        actorThreadId: candidate.threadId,
        type: "FOREMAN_ACTIVATE",
        takeoverId,
        since: takeover.candidateRegisteredAt
      };
      return state;
    });
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    return;
  }

  if (command === "record-takeover-failure") {
    const [expectedRevision, takeoverId, source] = args;
    if (!source) fail("failure JSON is required");
    const failure = await parseJson(source, "failure");
    const next = await mutateState(file, expectedRevision, (state) => {
      const takeover = state.leadership.takeover;
      if (state.leadership.status !== "electing" || takeover?.takeoverId !== takeoverId) fail("takeover is not current");
      if (!new Set(["create", "register", "activate"]).has(failure.phase) || !nonEmptyString(failure.error)) fail("failure requires a valid phase and error");
      const entry = {
        phase: failure.phase,
        error: failure.error,
        observedAt: failure.observedAt ?? nowIso(),
        candidateThreadId: failure.candidateThreadId ?? takeover.candidateThreadId ?? null
      };
      takeover.failures.push(entry);
      takeover.lastFailure = entry;
      takeover.status = "needs_recovery";
      return state;
    });
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    return;
  }

  if (command === "resume-takeover") {
    const [expectedRevision, takeoverId, source] = args;
    if (!source) fail("resume JSON is required");
    const resume = await parseJson(source, "resume");
    const next = await mutateState(file, expectedRevision, (state) => {
      const takeover = state.leadership.takeover;
      if (state.leadership.status !== "electing" || takeover?.takeoverId !== takeoverId) fail("takeover is not current");
      if (!nonEmptyString(resume.claimantThreadId) || !claimantRoles.has(resume.claimantRole)) fail("resume requires claimantThreadId and claimantRole");
      const expired = Date.parse(takeover.leaseExpiresAt) <= Date.now();
      if (!expired && !takeover.lastFailure) fail("takeover lease is still healthy");
      if (takeover.candidateThreadId && resume.candidateUnrecoverable !== true) fail("registered candidate must be declared unrecoverable before replacement");
      if (takeover.candidateThreadId) takeover.failedCandidateThreadIds.push(takeover.candidateThreadId);
      takeover.candidateThreadId = null;
      takeover.candidateHostId = null;
      takeover.claimantThreadId = resume.claimantThreadId;
      takeover.claimantRole = resume.claimantRole;
      takeover.status = "claimed";
      takeover.resumedAt = nowIso();
      takeover.leaseExpiresAt = new Date(Date.now() + takeoverLeaseMs).toISOString();
      takeover.lastFailure = null;
      state.expectedNext = {
        actorThreadId: "foreman-successor",
        type: "FOREMAN_ACTIVATE",
        takeoverId,
        since: takeover.resumedAt
      };
      return state;
    });
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    return;
  }

  if (command === "adopt-takeover") {
    const [expectedRevision, takeoverId, candidateThreadId] = args;
    if (!nonEmptyString(candidateThreadId)) fail("candidateThreadId is required");
    const next = await mutateState(file, expectedRevision, (state) => {
      const takeover = state.leadership.takeover;
      if (state.leadership.status !== "electing" || takeover?.takeoverId !== takeoverId) fail("takeover is not current");
      if (takeover.candidateThreadId !== candidateThreadId) fail("candidate does not match the registered takeover candidate");
      const adoptedAt = nowIso();
      state.leadership = {
        epoch: takeover.toEpoch,
        status: "active",
        activeForemanThreadId: candidateThreadId,
        previousForemanThreadIds: state.leadership.previousForemanThreadIds,
        repair: null,
        lastRepair: state.leadership.lastRepair,
        takeover: null,
        lastTakeover: {
          ...takeover,
          status: "adopted",
          adoptedAt
        }
      };
      state.foremanThreadId = candidateThreadId;
      state.expectedNext = {
        actorThreadId: candidateThreadId,
        type: "RECOVERY_RECONCILE",
        takeoverId,
        since: adoptedAt
      };
      return state;
    });
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    return;
  }

  fail("usage: state-store.mjs <path|show|init|write|begin-repair|finish-repair|claim-takeover|register-candidate|record-takeover-failure|resume-takeover|adopt-takeover> <runId> ...");
}

main().catch(reportFailure);
