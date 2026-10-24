import type { Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { digest, token, type User } from "./auth";
import { writeTransaction } from "./db";
export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function requireRole(user: User, roles: string[]) {
  if (!roles.includes(user.role)) throw new AppError("FORBIDDEN", 403);
}
export async function issueTicket(
  client: Client,
  user: User,
  input: { eventId: string; name: string; email?: string; category: string },
) {
  requireRole(user, ["admin"]);
  if (
    typeof input.eventId !== "string" ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 120 ||
    !["staff", "performer", "general"].includes(input.category) ||
    (input.email !== undefined &&
      (typeof input.email !== "string" ||
        (input.email &&
          (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
            input.email.length > 254))))
  )
    throw new AppError("INVALID_INPUT");
  const tx = await writeTransaction(client);
  try {
    const event = (
      await tx.execute({
        sql: "SELECT * FROM events WHERE id=?",
        args: [input.eventId],
      })
    ).rows[0];
    if (!event) throw new AppError("EVENT_NOT_FOUND", 404);
    const count = (
      await tx.execute({
        sql: "SELECT COUNT(*) AS n FROM tickets WHERE event_id=? AND cancelled=0",
        args: [input.eventId],
      })
    ).rows[0];
    if (Number(count.n) >= Number(event.capacity))
      throw new AppError("CAPACITY_REACHED", 409);
    const id = randomUUID(),
      secret = token();
    await tx.execute({
      sql: "INSERT INTO tickets(id,event_id,name,email,category,token_hash,credential,created_by) VALUES(?,?,?,?,?,?,?,?)",
      args: [
        id,
        input.eventId,
        input.name.trim(),
        input.email?.trim() || null,
        input.category,
        digest(secret),
        secret,
        user.id,
      ],
    });
    await tx.commit();
    // Admin-only exports can retrieve the credential; scan lookups use its hash.
    return { id, qr: `EG1:${secret}` };
  } finally {
    tx.close();
  }
}
export async function scanTicket(
  client: Client,
  user: User,
  eventId: string,
  qr: string,
) {
  if (!/^EG1:[A-Za-z0-9_-]{43}$/.test(qr)) return { status: "invalid" };
  const tx = await writeTransaction(client);
  try {
    const ticket = (
      await tx.execute({
        sql: "SELECT id,name,category,cancelled,checked_in_at FROM tickets WHERE token_hash=? AND event_id=?",
        args: [digest(qr.slice(4)), eventId],
      })
    ).rows[0];
    // No changes on these branches; finally closes/rolls back the read-only work.
    if (!ticket) return { status: "invalid" };
    if (ticket.cancelled) return { status: "cancelled" };
    if (ticket.checked_in_at) return { status: "duplicate", ticket };
    await tx.execute({
      sql: "UPDATE tickets SET checked_in_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND checked_in_at IS NULL",
      args: [ticket.id],
    });
    await tx.execute({
      sql: "INSERT INTO checkins(id,ticket_id,user_id,kind) VALUES(?,?,?,'entry')",
      args: [randomUUID(), ticket.id, user.id],
    });
    const updated = (
      await tx.execute({
        sql: "SELECT id,name,category,checked_in_at FROM tickets WHERE id=?",
        args: [ticket.id],
      })
    ).rows[0];
    await tx.commit();
    return { status: "admitted", ticket: updated };
  } finally {
    tx.close();
  }
}
export async function requestReentry(
  client: Client,
  user: User,
  ticketId: string,
) {
  const tx = await writeTransaction(client);
  try {
    const ticket = (
      await tx.execute({
        sql: "SELECT id FROM tickets WHERE id=? AND cancelled=0 AND checked_in_at IS NOT NULL",
        args: [ticketId],
      })
    ).rows[0];
    if (!ticket) throw new AppError("INVALID_TICKET");
    await tx.execute({
      sql: "INSERT OR IGNORE INTO reentry_requests(id,ticket_id,requested_by) VALUES(?,?,?)",
      args: [randomUUID(), ticketId, user.id],
    });
    const row = (
      await tx.execute({
        sql: "SELECT id FROM reentry_requests WHERE ticket_id=? AND status='pending'",
        args: [ticketId],
      })
    ).rows[0];
    await tx.commit();
    return row;
  } finally {
    tx.close();
  }
}
export async function resolveReentry(
  client: Client,
  user: User,
  requestId: string,
  approve: boolean,
  reason: string,
) {
  requireRole(user, ["admin", "supervisor"]);
  if (typeof reason !== "string" || reason.length > 500)
    throw new AppError("INVALID_INPUT");
  const tx = await writeTransaction(client);
  try {
    const r = (
      await tx.execute({
        sql: "SELECT r.*,t.cancelled FROM reentry_requests r JOIN tickets t ON t.id=r.ticket_id WHERE r.id=? AND r.status='pending'",
        args: [requestId],
      })
    ).rows[0];
    if (!r) throw new AppError("ALREADY_RESOLVED", 409);
    if (r.cancelled) throw new AppError("INVALID_TICKET", 409);
    await tx.execute({
      sql: "UPDATE reentry_requests SET status=?,resolved_by=?,reason=?,resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      args: [approve ? "approved" : "rejected", user.id, reason, requestId],
    });
    if (approve)
      await tx.execute({
        sql: "INSERT INTO checkins(id,ticket_id,user_id,kind,reason) VALUES(?,?,?,'reentry',?)",
        args: [randomUUID(), r.ticket_id, user.id, reason],
      });
    await tx.commit();
  } finally {
    tx.close();
  }
}
