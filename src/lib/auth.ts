import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
  randomUUID,
} from "node:crypto";
import type { Client } from "@libsql/client";
export type Role = "admin" | "supervisor" | "checkin";
export type User = { id: string; name: string; email: string; role: Role };
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string) {
  const [salt, key] = stored.split(":");
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(key, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function createUser(
  client: Client,
  name: string,
  email: string,
  role: Role,
  password: string,
) {
  if (
    !["admin", "supervisor", "checkin"].includes(role) ||
    password.length < 12 ||
    password.length > 128 ||
    !name.trim() ||
    name.length > 120 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254
  )
    throw new Error("INVALID_USER");
  const id = randomUUID();
  await client.execute({
    sql: "INSERT INTO users(id,name,email,role,password_hash) VALUES(?,?,?,?,?)",
    args: [
      id,
      name.trim(),
      email.trim().toLowerCase(),
      role,
      hashPassword(password),
    ],
  });
  return id;
}
export async function sessionUser(
  client: Client,
  raw: string | undefined,
): Promise<User | null> {
  if (!raw) return null;
  const r = await client.execute({
    sql: "SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
    args: [digest(raw), Date.now()],
  });
  return (r.rows[0] as unknown as User) || null;
}
