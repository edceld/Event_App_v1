import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initialize } from "../src/lib/db";
import {
  createUser,
  hashPassword,
  verifyPassword,
  sessionUser,
  type User,
} from "../src/lib/auth";
import {
  issueTicket,
  scanTicket,
  requestReentry,
  resolveReentry,
} from "../src/lib/tickets";
import { detectLanguage, languages, translate } from "../src/lib/i18n";
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "event-gate-"));
  const url = `file:${join(directory, "test.db")}`;
  const client = connect(url);
  await initialize(client);
  const users = {} as Record<"admin" | "supervisor" | "checkin", User>;
  for (const role of ["admin", "supervisor", "checkin"] as const) {
    const id = await createUser(
      client,
      role,
      `${role}@example.com`,
      role,
      "test-only-password-123",
    );
    users[role] = { id, name: role, email: `${role}@example.com`, role };
  }
  await client.execute(
    "INSERT INTO events(id,name,starts_at,venue,capacity) VALUES('event','Welcome','2027-01-01T00:00:00Z','Hall',120),('other','Other','2027-01-02T00:00:00Z','Hall',120)",
  );
  return {
    client,
    users,
    url,
    close() {
      client.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("5 phones scanning one ticket admit it exactly once", async () => {
  const f = await fixture();
  const phones = Array.from({ length: 5 }, () => connect(f.url));
  try {
    const ticket = await issueTicket(f.client, f.users.admin, {
      eventId: "event",
      name: "Guest",
      category: "general",
    });
    const results = await Promise.all(
      phones.map((client) =>
        scanTicket(client, f.users.checkin, "event", ticket.qr),
      ),
    );
    assert.equal(results.filter((r) => r.status === "admitted").length, 1);
    assert.equal(results.filter((r) => r.status === "duplicate").length, 4);
    assert.equal(
      (await f.client.execute("SELECT COUNT(*) AS n FROM checkins")).rows[0].n,
      1,
    );
  } finally {
    phones.forEach((p) => p.close());
    f.close();
  }
});
test("invalid, wrong-event, and cancelled QR codes are blocked", async () => {
  const f = await fixture();
  try {
    const ticket = await issueTicket(f.client, f.users.admin, {
      eventId: "event",
      name: "Guest",
      category: "staff",
    });
    assert.equal(
      (await scanTicket(f.client, f.users.checkin, "other", ticket.qr)).status,
      "invalid",
    );
    assert.equal(
      (await scanTicket(f.client, f.users.checkin, "event", "EG1:forged"))
        .status,
      "invalid",
    );
    await f.client.execute({
      sql: "UPDATE tickets SET cancelled=1 WHERE id=?",
      args: [ticket.id],
    });
    assert.equal(
      (await scanTicket(f.client, f.users.checkin, "event", ticket.qr)).status,
      "cancelled",
    );
    assert.equal(
      (await f.client.execute("SELECT COUNT(*) AS n FROM checkins")).rows[0].n,
      0,
    );
  } finally {
    f.close();
  }
});
test("five different tickets can all check in concurrently", async () => {
  const f = await fixture();
  const phones = Array.from({ length: 5 }, () => connect(f.url));
  try {
    const tickets: { id: string; qr: string }[] = [];
    for (let i = 0; i < 5; i++)
      tickets.push(
        await issueTicket(f.client, f.users.admin, {
          eventId: "event",
          name: `Guest ${i}`,
          category: "general",
        }),
      );
    const results = await Promise.all(
      phones.map((client, i) =>
        scanTicket(client, f.users.checkin, "event", tickets[i].qr),
      ),
    );
    assert.equal(results.filter((r) => r.status === "admitted").length, 5);
  } finally {
    phones.forEach((p) => p.close());
    f.close();
  }
});
test("check-in staff cannot issue tickets or approve re-entry", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      issueTicket(f.client, f.users.checkin, {
        eventId: "event",
        name: "Guest",
        category: "general",
      }),
      /FORBIDDEN/,
    );
    await assert.rejects(
      issueTicket(f.client, f.users.supervisor, {
        eventId: "event",
        name: "Guest",
        category: "general",
      }),
      /FORBIDDEN/,
    );
    await assert.rejects(
      resolveReentry(f.client, f.users.checkin, "anything", true, ""),
      /FORBIDDEN/,
    );
  } finally {
    f.close();
  }
});
test("supervisor approval records actor, time, reason and cannot be reused", async () => {
  const f = await fixture();
  try {
    const ticket = await issueTicket(f.client, f.users.admin, {
      eventId: "event",
      name: "Performer",
      category: "performer",
    });
    await assert.rejects(
      requestReentry(f.client, f.users.checkin, ticket.id),
      /INVALID_TICKET/,
    );
    await scanTicket(f.client, f.users.checkin, "event", ticket.qr);
    const r = await requestReentry(f.client, f.users.checkin, ticket.id);
    const again = await requestReentry(f.client, f.users.checkin, ticket.id);
    assert.equal(r.id, again.id);
    await resolveReentry(
      f.client,
      f.users.supervisor,
      String(r.id),
      true,
      "Comfort room",
    );
    await assert.rejects(
      resolveReentry(f.client, f.users.supervisor, String(r.id), true, ""),
      /ALREADY_RESOLVED/,
    );
    const audit = (
      await f.client.execute("SELECT * FROM checkins WHERE kind='reentry'")
    ).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].user_id, f.users.supervisor.id);
    assert.equal(audit[0].reason, "Comfort room");
    assert.ok(audit[0].created_at);
    assert.equal(
      (await scanTicket(f.client, f.users.checkin, "event", ticket.qr)).status,
      "duplicate",
    );
    const next = await requestReentry(f.client, f.users.checkin, ticket.id);
    assert.notEqual(next.id, r.id);
  } finally {
    f.close();
  }
});
test("cancelled tickets cannot receive re-entry approval; rejections do not log admission", async () => {
  const f = await fixture();
  try {
    const a = await issueTicket(f.client, f.users.admin, {
      eventId: "event",
      name: "A",
      category: "general",
    });
    await scanTicket(f.client, f.users.checkin, "event", a.qr);
    const r = await requestReentry(f.client, f.users.checkin, a.id);
    await resolveReentry(
      f.client,
      f.users.supervisor,
      String(r.id),
      false,
      "Not allowed",
    );
    assert.equal(
      (
        await f.client.execute(
          "SELECT COUNT(*) AS n FROM checkins WHERE kind='reentry'",
        )
      ).rows[0].n,
      0,
    );
    const next = await requestReentry(f.client, f.users.checkin, a.id);
    await f.client.execute({
      sql: "UPDATE tickets SET cancelled=1 WHERE id=?",
      args: [a.id],
    });
    await assert.rejects(
      resolveReentry(f.client, f.users.supervisor, String(next.id), true, ""),
      /INVALID_TICKET/,
    );
  } finally {
    f.close();
  }
});
test("concurrent issuing respects capacity and rejects unsupported categories", async () => {
  const f = await fixture();
  try {
    await f.client.execute("UPDATE events SET capacity=1 WHERE id='event'");
    await assert.rejects(
      issueTicket(f.client, f.users.admin, {
        eventId: "event",
        name: "A",
        category: "vip",
      }),
      /INVALID_INPUT/,
    );
    const results = await Promise.allSettled(
      ["A", "B"].map((name) =>
        issueTicket(f.client, f.users.admin, {
          eventId: "event",
          name,
          category: "general",
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const fail = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    assert.match(fail.reason.message, /CAPACITY_REACHED/);
    assert.equal(
      (await f.client.execute("SELECT COUNT(*) AS n FROM tickets")).rows[0].n,
      1,
    );
  } finally {
    f.close();
  }
});
test("password hashing and session rejection", async () => {
  const hash = hashPassword("test-password-123");
  assert.ok(!hash.includes("test-password-123"));
  assert.equal(verifyPassword("test-password-123", hash), true);
  assert.equal(verifyPassword("wrong", hash), false);
  const f = await fixture();
  try {
    assert.equal(await sessionUser(f.client, "forged"), null);
    await assert.rejects(
      createUser(f.client, "Name", "staff@example.com", "admin", "short"),
      /INVALID_USER/,
    );
  } finally {
    f.close();
  }
});
test("five language options include both Chinese writing systems", () => {
  assert.equal(languages.length, 5);
  assert.equal(detectLanguage("zh-TW"), "zh-Hant");
  assert.equal(detectLanguage("zh-CN"), "zh-Hans");
  assert.equal(detectLanguage("ja-JP"), "ja");
  assert.equal(detectLanguage("vi-VN"), "vi");
  for (const lang of languages)
    for (const key of [
      "scan",
      "staff",
      "performer",
      "general",
      "approve",
      "duplicate",
      "cancelled",
    ])
      assert.ok(translate(lang, key));
});
