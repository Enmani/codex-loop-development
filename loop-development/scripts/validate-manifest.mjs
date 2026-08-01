#!/usr/bin/env node

import fs from "node:fs/promises";

const inputPath = process.argv[2];

async function readInput() {
  if (inputPath && inputPath !== "-") return fs.readFile(inputPath, "utf8");

  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function push(errors, condition, path, message) {
  if (!condition) errors.push({ path, message });
}

function validate(manifest) {
  const errors = [];
  const warnings = [];

  push(errors, manifest && typeof manifest === "object" && !Array.isArray(manifest), "$", "must be an object");
  if (errors.length) return { errors, warnings };

  push(errors, manifest.schemaVersion === 1, "schemaVersion", "must equal 1");
  push(errors, isNonEmptyString(manifest.runId), "runId", "must be a non-empty string");
  push(errors, stringArray(manifest.planFiles) && manifest.planFiles.length > 0, "planFiles", "must contain at least one path");
  push(errors, Number.isInteger(manifest.maxParallel) && manifest.maxParallel >= 1 && manifest.maxParallel <= 32, "maxParallel", "must be an integer from 1 to 32");
  push(errors, Array.isArray(manifest.stages) && manifest.stages.length > 0, "stages", "must contain at least one stage");
  if (!Array.isArray(manifest.stages)) return { errors, warnings };

  const byId = new Map();
  const allowedStatuses = new Set(["pending", "assigned", "report_ready", "handoff", "reviewing", "accepted", "partial", "returned", "blocked", "superseded"]);

  manifest.stages.forEach((stage, index) => {
    const base = `stages[${index}]`;
    push(errors, stage && typeof stage === "object" && !Array.isArray(stage), base, "must be an object");
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) return;

    push(errors, isNonEmptyString(stage.id), `${base}.id`, "must be a non-empty string");
    if (isNonEmptyString(stage.id)) {
      push(errors, /^[A-Za-z][A-Za-z0-9._-]*$/.test(stage.id), `${base}.id`, "must use letters, digits, dot, underscore, or hyphen and start with a letter");
      push(errors, !byId.has(stage.id), `${base}.id`, `duplicate stage id ${stage.id}`);
      if (!byId.has(stage.id)) byId.set(stage.id, stage);
    }

    push(errors, stringArray(stage.dependsOn), `${base}.dependsOn`, "must be an array of stage IDs");
    push(errors, isNonEmptyString(stage.scope), `${base}.scope`, "must be a non-empty string");
    push(errors, stringArray(stage.acceptance) && stage.acceptance.length > 0, `${base}.acceptance`, "must contain at least one acceptance criterion");
    push(errors, stringArray(stage.writeSet), `${base}.writeSet`, "must be an array of path patterns");
    push(errors, stringArray(stage.locks), `${base}.locks`, "must be an array of lock names");
    if (stage.userGateAfter !== undefined) push(errors, typeof stage.userGateAfter === "boolean", `${base}.userGateAfter`, "must be boolean when present");
    if (stage.status !== undefined) push(errors, allowedStatuses.has(stage.status), `${base}.status`, "is not an allowed stage status");
  });

  for (const [id, stage] of byId) {
    if (!Array.isArray(stage.dependsOn)) continue;
    const seen = new Set();
    for (const dependency of stage.dependsOn) {
      push(errors, dependency !== id, `stages.${id}.dependsOn`, "cannot depend on itself");
      push(errors, byId.has(dependency), `stages.${id}.dependsOn`, `unknown dependency ${dependency}`);
      push(errors, !seen.has(dependency), `stages.${id}.dependsOn`, `duplicate dependency ${dependency}`);
      seen.add(dependency);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const order = [];

  function visit(id, stack) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      errors.push({ path: `stages.${id}.dependsOn`, message: `dependency cycle: ${[...stack, id].join(" -> ")}` });
      return;
    }

    visiting.add(id);
    const stage = byId.get(id);
    for (const dependency of stage?.dependsOn ?? []) {
      if (byId.has(dependency)) visit(dependency, [...stack, id]);
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }

  for (const id of byId.keys()) visit(id, []);

  const roots = [...byId.entries()]
    .filter(([, stage]) => Array.isArray(stage.dependsOn) && stage.dependsOn.length === 0)
    .map(([id]) => id);
  if (byId.size > 0 && roots.length === 0) errors.push({ path: "stages", message: "must contain at least one dependency root" });

  const rootConflicts = [];
  for (let i = 0; i < roots.length; i += 1) {
    for (let j = i + 1; j < roots.length; j += 1) {
      const left = byId.get(roots[i]);
      const right = byId.get(roots[j]);
      const sharedPaths = (left.writeSet ?? []).filter((value) => (right.writeSet ?? []).includes(value));
      const sharedLocks = (left.locks ?? []).filter((value) => (right.locks ?? []).includes(value));
      if (sharedPaths.length || sharedLocks.length) rootConflicts.push({ stages: [roots[i], roots[j]], sharedPaths, sharedLocks });
    }
  }
  if (rootConflicts.length) warnings.push({ path: "stages", message: "ready roots contain exact write-set or lock conflicts", conflicts: rootConflicts });

  return { errors, warnings, roots, topologicalOrder: order };
}

try {
  const source = await readInput();
  const manifest = JSON.parse(source);
  const result = validate(manifest);
  const output = {
    ok: result.errors.length === 0,
    errors: result.errors,
    warnings: result.warnings,
    roots: result.roots ?? [],
    topologicalOrder: result.topologicalOrder ?? []
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.ok) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, errors: [{ path: "$", message: error.message }], warnings: [], roots: [], topologicalOrder: [] }, null, 2)}\n`);
  process.exitCode = 1;
}
