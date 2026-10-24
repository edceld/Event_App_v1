import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect, initialize } from "../src/lib/db";
import { bootstrapAdmin, verifyPassword } from "../src/lib/auth";
test("first-run administrator is atomic, optional, and cannot reset existing users", async () => {
  const directory = mkdtempSync(join(tmpdir(), "event-gate-bootstrap-"));
  const client = connect(`file:${join(directory, "bootstrap.db")}`);
  try {
    assert.equal(await bootstrapAdmin(client, {}), false);
    await initialize(client);
    const config = {
      email: "owner@example.com",
      password: "bootstrap-test-only-password",
      name: "Owner",
    };
    const results = await Promise.all([
      bootstrapAdmin(client, config),
      bootstrapAdmin(client, config),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const users = (await client.execute("SELECT * FROM users")).rows;
    assert.equal(users.length, 1);
    assert.equal(users[0].role, "admin");
    assert.equal(users[0].email, config.email);
    assert.equal(
      verifyPassword(config.password, String(users[0].password_hash)),
      true,
    );
    assert.equal(
      await bootstrapAdmin(client, {
        ...config,
        password: "replacement-test-password",
      }),
      false,
    );
    assert.equal(
      await bootstrapAdmin(client, { ...config, email: "other@example.com" }),
      false,
    );
    const after = (await client.execute("SELECT * FROM users")).rows;
    assert.equal(after.length, 1);
    assert.equal(after[0].password_hash, users[0].password_hash);
  } finally {
    client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
