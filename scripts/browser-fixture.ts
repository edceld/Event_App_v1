// Isolated test database. Never populates the development/production database.
import { rmSync } from "node:fs";
import { initialize, db } from "../src/lib/db";
import { createUser } from "../src/lib/auth";
if (process.env.DATABASE_URL !== "file:.data/browser-test.db")
  throw new Error("Fixture requires isolated browser-test.db");
rmSync(".data/browser-test.db", { force: true });
await initialize();
for (const role of ["admin", "supervisor", "checkin"] as const)
  await createUser(
    db(),
    role,
    `${role}@example.com`,
    role,
    "browser-test-only-password",
  );
db().close();
