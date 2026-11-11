#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const dotenv = require("dotenv");

const envFile = path.resolve(__dirname, "..", ".env.test");
const allowedHosts = new Set(["localhost", "127.0.0.1", "::1"]);

function loadSafeTestEnv() {
  if (!fs.existsSync(envFile)) {
    throw new Error("Missing .env.test; refusing to run a database command.");
  }

  const parsed = dotenv.parse(fs.readFileSync(envFile));
  if (!parsed.DATABASE_URL) {
    throw new Error(".env.test must define DATABASE_URL; refusing to run.");
  }

  let url;
  try {
    url = new URL(parsed.DATABASE_URL);
  } catch {
    throw new Error(".env.test DATABASE_URL is not a valid URL; refusing to run.");
  }

  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host) || host.endsWith(".neon.tech")) {
    throw new Error(`Refusing database host '${host}'; only localhost/loopback is allowed.`);
  }

  return { parsed, host };
}

if (require.main === module) {
  let safe;
  try {
    safe = loadSafeTestEnv();
  } catch (error) {
    console.error(`[test-db-guard] ${error.message}`);
    process.exit(2);
  }

  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("Usage: node scripts/test-db-guard.cjs <command> [args...]");
    process.exit(2);
  }

  console.log(`[test-db-guard] DATABASE_URL host: ${safe.host}`);
  console.log(`[test-db-guard] Running: ${command} ${args.join(" ")}`.trim());

  const env = {
    ...process.env,
    ...safe.parsed,
    DATABASE_URL: safe.parsed.DATABASE_URL,
    SCHEDULER_TEST_DB_GUARD: "1",
  };
  const result = spawnSync(command, args, {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.error(`[test-db-guard] ${result.error.message}`);
    process.exit(2);
  }
  process.exit(result.status ?? 1);
}

module.exports = { loadSafeTestEnv };
