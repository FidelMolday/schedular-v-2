import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

// Tests and guarded local scripts must never inherit the production DATABASE_URL.
if (process.env.NODE_ENV === "test" || process.env.SCHEDULER_TEST_DB_GUARD === "1") {
  let testDbHost = "";
  try {
    testDbHost = new URL(process.env.DATABASE_URL ?? "").hostname.toLowerCase();
  } catch {
    throw new Error("Refusing test database access: DATABASE_URL is missing or invalid.");
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(testDbHost) || testDbHost.endsWith(".neon.tech")) {
    throw new Error(`Refusing test database host '${testDbHost}'. Only localhost/loopback is allowed.`);
  }
  console.log(`[test-db-guard] DATABASE_URL host: ${testDbHost}`);
}

// Pool size: default 20. pg's own default (10) is smaller than the tested
// booking burst (20 concurrent), and because slot-lock waits are now bounded
// (try-lock, see lib/data/bookings.ts) the pool drains quickly — 20 lets a
// full burst run without queueing while leaving headroom for post-commit
// background work (provisioning, audits, notifications). Override per deploy
// with DATABASE_POOL_MAX.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Math.max(1, parseInt(process.env.DATABASE_POOL_MAX ?? "20", 10) || 20),
});
const adapter = new PrismaPg(pool);

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

export const db = global.prisma ?? new PrismaClient({ adapter });

/**
 * True when `err` is a database serialization / write-conflict failure
 * (Postgres SQLSTATE 40001, Prisma P2034) regardless of how the Prisma pg
 * driver adapter surfaces it:
 *
 *  - classic `PrismaClientKnownRequestError` with `code === "P2034"`
 *    (non-interactive query paths that Prisma's runtime re-maps), or
 *  - a raw `@prisma/driver-adapter-utils` `DriverAdapterError` whose
 *    `cause.kind` is `"TransactionWriteConflict"` and/or whose
 *    `cause.originalCode` is the Postgres SQLSTATE `"40001"` (interactive
 *    transaction COMMIT aborts — the shape this adapter actually surfaces),
 *  - a message mentioning 40001 / serialization / deadlock / write conflict.
 *
 * `cause.originalCode === "40001"` is the raw Postgres error code, which
 * adapter-pg attaches to every Postgres error it wraps, so it is the primary
 * signal and stays stable even if the adapter's wrapper class is renamed.
 */
export function isSerializationConflict(err: unknown): boolean {
  const e = err as {
    code?: string;
    message?: string;
    cause?: { kind?: string; originalCode?: string };
  };
  if (!e) return false;
  return (
    e.code === "P2034" ||
    e.cause?.originalCode === "40001" ||
    e.cause?.kind === "TransactionWriteConflict" ||
    /(40001|serializ|deadlock|TransactionWriteConflict)/i.test(e.message ?? "")
  );
}

if (process.env.NODE_ENV !== "production") {
  global.prisma = db;
}
