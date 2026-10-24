import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  createUser,
  digest,
  hashPassword,
  sessionUser,
  token,
  verifyPassword,
  type Role,
} from "@/lib/auth";
import {
  AppError,
  issueTicket,
  scanTicket,
  requestReentry,
  resolveReentry,
  requireRole,
} from "@/lib/tickets";
import { randomUUID } from "node:crypto";
export const runtime = "nodejs";
const cookie = "event_gate_session";
const dummyHash = hashPassword("unused-dummy-password-for-timing");
async function handle(
  req: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const path = (await context.params).path.join("/");
    const client = db();
    const mutating = req.method === "POST";
    if (mutating) {
      const origin = req.headers.get("origin");
      // Next's internal URL can use 0.0.0.0 behind a proxy. Validate against
      // the actual request Host rather than that internal bind address.
      const scheme = process.env.VERCEL
        ? "https"
        : req.headers.get("x-forwarded-proto") ||
          req.nextUrl.protocol.replace(":", "");
      const expectedOrigin = `${scheme}://${req.headers.get("host")}`;
      if (!origin || origin !== expectedOrigin)
        throw new AppError("INVALID_ORIGIN", 403);
      if (!req.headers.get("content-type")?.startsWith("application/json"))
        throw new AppError("INVALID_INPUT");
    }
    let body: Record<string, any> = {};
    if (mutating) {
      if (Number(req.headers.get("content-length") || 0) > 2200000)
        throw new AppError("INVALID_INPUT", 413);
      const raw = await req.text();
      if (raw.length > 2200000) throw new AppError("INVALID_INPUT", 413);
      try {
        body = JSON.parse(raw);
      } catch {
        throw new AppError("INVALID_INPUT");
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new AppError("INVALID_INPUT");
    }
    if (path === "login" && mutating) {
      const email =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!email || email.length > 254 || password.length > 128)
        throw new AppError("INVALID_LOGIN", 401);
      const now = Date.now();
      const attempt = await client.execute({
        sql: `INSERT INTO login_attempts(key,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN reset_at<? THEN 1 ELSE attempts+1 END, reset_at=CASE WHEN reset_at<? THEN ? ELSE reset_at END RETURNING attempts`,
        args: [
          digest(email),
          now + 15 * 60 * 1000,
          now,
          now,
          now + 15 * 60 * 1000,
        ],
      });
      if (Number(attempt.rows[0].attempts) > 10)
        throw new AppError("RATE_LIMITED", 429);
      const row = (
        await client.execute({
          sql: "SELECT * FROM users WHERE email=?",
          args: [email],
        })
      ).rows[0];
      const valid = verifyPassword(
        password,
        String(row?.password_hash || dummyHash),
      );
      if (!row || !valid) throw new AppError("INVALID_LOGIN", 401);
      await client.execute({
        sql: "DELETE FROM login_attempts WHERE key=?",
        args: [digest(email)],
      });
      await client.execute({
        sql: "DELETE FROM sessions WHERE expires_at<?",
        args: [now],
      });
      const raw = token();
      await client.execute({
        sql: "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
        args: [digest(raw), row.id, now + 12 * 60 * 60 * 1000],
      });
      const result = NextResponse.json({ ok: true });
      result.cookies.set(cookie, raw, {
        httpOnly: true,
        secure:
          !!process.env.VERCEL ||
          req.headers.get("x-forwarded-proto") === "https" ||
          req.nextUrl.protocol === "https:",
        sameSite: "strict",
        path: "/",
        maxAge: 12 * 60 * 60,
      });
      return result;
    }
    const user = await sessionUser(client, req.cookies.get(cookie)?.value);
    if (!user) throw new AppError("UNAUTHORIZED", 401);
    if (path === "me" && !mutating)
      return NextResponse.json({
        user,
        emailEnabled: !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
      });
    if (path === "logout" && mutating) {
      await client.execute({
        sql: "DELETE FROM sessions WHERE token_hash=?",
        args: [digest(req.cookies.get(cookie)?.value || "")],
      });
      const result = NextResponse.json({ ok: true });
      result.cookies.delete(cookie);
      return result;
    }
    if (path === "events") {
      if (!mutating)
        return NextResponse.json(
          (
            await client.execute(`SELECT e.*,
        (SELECT COUNT(*) FROM tickets t WHERE t.event_id=e.id AND t.cancelled=0) AS issued,
        (SELECT COUNT(*) FROM tickets t WHERE t.event_id=e.id AND t.checked_in_at IS NOT NULL AND t.cancelled=0) AS arrived
        FROM events e ORDER BY e.starts_at DESC`)
          ).rows,
        );
      requireRole(user, ["admin"]);
      if (
        typeof body.name !== "string" ||
        !body.name.trim() ||
        body.name.length > 160 ||
        typeof body.venue !== "string" ||
        !body.venue.trim() ||
        body.venue.length > 200 ||
        !Number.isInteger(body.capacity) ||
        body.capacity < 1 ||
        body.capacity > 100000 ||
        typeof body.startsAt !== "string" ||
        !Number.isFinite(Date.parse(body.startsAt))
      )
        throw new AppError("INVALID_INPUT");
      const id = randomUUID();
      await client.execute({
        sql: "INSERT INTO events(id,name,starts_at,venue,capacity) VALUES(?,?,?,?,?)",
        args: [
          id,
          body.name.trim(),
          new Date(body.startsAt).toISOString(),
          body.venue.trim(),
          body.capacity,
        ],
      });
      return NextResponse.json({ id }, { status: 201 });
    }
    if (path === "tickets") {
      requireRole(user, ["admin"]);
      if (mutating)
        return NextResponse.json(await issueTicket(client, user, body as any), {
          status: 201,
        });
      return NextResponse.json(
        (
          await client.execute({
            sql: "SELECT id,event_id,name,email,category,cancelled,checked_in_at FROM tickets WHERE event_id=? ORDER BY created_at DESC",
            args: [req.nextUrl.searchParams.get("eventId") || ""],
          })
        ).rows,
      );
    }
    if (path === "ticket-export" && mutating) {
      requireRole(user, ["admin"]);
      const t = (
        await client.execute({
          sql: "SELECT id,credential FROM tickets WHERE id=? AND cancelled=0",
          args: [String(body.ticketId || "")],
        })
      ).rows[0];
      if (!t) throw new AppError("INVALID_TICKET", 404);
      return NextResponse.json({ qr: `EG1:${t.credential}` });
    }
    if (path === "cancel" && mutating) {
      requireRole(user, ["admin"]);
      await client.execute({
        sql: "UPDATE tickets SET cancelled=1 WHERE id=?",
        args: [String(body.ticketId || "")],
      });
      return NextResponse.json({ ok: true });
    }
    if (path === "scan" && mutating) {
      if (typeof body.qr !== "string" || typeof body.eventId !== "string")
        throw new AppError("INVALID_INPUT");
      return NextResponse.json(
        await scanTicket(client, user, body.eventId, body.qr.trim()),
      );
    }
    if (path === "reentry" && mutating)
      return NextResponse.json(
        await requestReentry(client, user, String(body.ticketId || "")),
      );
    if (path === "requests" && !mutating) {
      const isStaff = user.role === "checkin";
      return NextResponse.json(
        (
          await client.execute({
            sql: `SELECT r.*,t.name,t.category,t.cancelled,t.checked_in_at,u.name AS requested_by_name,s.name AS supervisor_name FROM reentry_requests r JOIN tickets t ON t.id=r.ticket_id JOIN users u ON u.id=r.requested_by LEFT JOIN users s ON s.id=r.resolved_by WHERE t.event_id=? ${isStaff ? "AND r.requested_by=?" : ""} ORDER BY r.created_at DESC LIMIT 100`,
            args: isStaff
              ? [req.nextUrl.searchParams.get("eventId") || "", user.id]
              : [req.nextUrl.searchParams.get("eventId") || ""],
          })
        ).rows,
      );
    }
    if (path === "resolve" && mutating) {
      if (typeof body.approve !== "boolean")
        throw new AppError("INVALID_INPUT");
      await resolveReentry(
        client,
        user,
        String(body.requestId || ""),
        body.approve,
        body.reason || "",
      );
      return NextResponse.json({ ok: true });
    }
    if (path === "users") {
      requireRole(user, ["admin"]);
      if (!mutating)
        return NextResponse.json(
          (
            await client.execute(
              "SELECT id,name,email,role FROM users ORDER BY name",
            )
          ).rows,
        );
      if (
        ![body.name, body.email, body.password, body.role].every(
          (v) => typeof v === "string",
        )
      )
        throw new AppError("INVALID_INPUT");
      try {
        await createUser(
          client,
          body.name,
          body.email,
          body.role as Role,
          body.password,
        );
      } catch (e) {
        if (e instanceof Error && e.message === "INVALID_USER")
          throw new AppError("INVALID_INPUT");
        throw e;
      }
      return NextResponse.json({ ok: true }, { status: 201 });
    }
    if (path === "email" && mutating) {
      requireRole(user, ["admin"]);
      if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)
        throw new AppError("EMAIL_NOT_CONFIGURED", 503);
      const t = (
        await client.execute({
          sql: "SELECT t.*,e.name AS event_name FROM tickets t JOIN events e ON e.id=t.event_id WHERE t.id=? AND t.cancelled=0",
          args: [String(body.ticketId || "")],
        })
      ).rows[0];
      if (!t?.email) throw new AppError("EMAIL_REQUIRED");
      if (
        typeof body.image !== "string" ||
        !body.image.startsWith("data:image/jpeg;base64,") ||
        body.image.length > 2000000
      )
        throw new AppError("INVALID_INPUT");
      const image = body.image.slice(23);
      if (
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image) ||
        !Buffer.from(image, "base64")
          .subarray(0, 3)
          .equals(Buffer.from([255, 216, 255]))
      )
        throw new AppError("INVALID_INPUT");
      const id = randomUUID();
      await client.execute({
        sql: "INSERT INTO email_deliveries(id,ticket_id,user_id,status) VALUES(?,?,?,'pending')",
        args: [id, t.id, user.id],
      });
      let result: Response;
      try {
        result = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: process.env.EMAIL_FROM,
            to: [t.email],
            subject: `${t.event_name} — Ticket`,
            text: "Your event ticket is attached. Present its QR code at the entrance. Keep this ticket private.",
            attachments: [{ filename: "event-ticket.jpg", content: image }],
          }),
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        await client.execute({
          sql: "UPDATE email_deliveries SET status='unknown' WHERE id=?",
          args: [id],
        });
        throw new AppError("EMAIL_FAILED", 502);
      }
      if (!result.ok) {
        await client.execute({
          sql: "UPDATE email_deliveries SET status='failed' WHERE id=?",
          args: [id],
        });
        throw new AppError("EMAIL_FAILED", 502);
      }
      const sent = await result.json();
      await client.execute({
        sql: "UPDATE email_deliveries SET status='sent',provider_id=? WHERE id=?",
        args: [String(sent.id), id],
      });
      return NextResponse.json({ ok: true });
    }
    throw new AppError("NOT_FOUND", 404);
  } catch (e) {
    if (e instanceof AppError)
      return NextResponse.json({ error: e.code }, { status: e.status });
    // Do not log requests, passwords, ticket credentials, or database authentication.
    console.error(
      "API operation failed:",
      e instanceof Error ? e.name : "UnknownError",
    );
    return NextResponse.json({ error: "SERVER_ERROR" }, { status: 500 });
  }
}
export { handle as GET, handle as POST };
