#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function main() {
  const source = process.argv[2];
  if (!source) throw new Error("usage: plan-fingerprint.mjs '<ordered-plan-files-json-array>'");

  let files;
  try {
    files = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid plan file JSON: ${error.message}`);
  }
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string" || !file.trim())) {
    throw new Error("plan files must be a non-empty JSON string array");
  }

  const aggregate = crypto.createHash("sha256");
  for (const file of files) {
    const absolute = path.resolve(file);
    const normalizedPath = absolute.replaceAll("\\", "/");
    const content = await fs.readFile(absolute);
    aggregate.update(Buffer.from(`${Buffer.byteLength(normalizedPath, "utf8")}:`, "utf8"));
    aggregate.update(Buffer.from(normalizedPath, "utf8"));
    aggregate.update(Buffer.from(`${content.length}:`, "utf8"));
    aggregate.update(content);
  }
  process.stdout.write(`sha256:${aggregate.digest("hex")}\n`);
}

main().catch((error) => fail(error?.message ?? String(error)));
