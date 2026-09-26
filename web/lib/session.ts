import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "sourcebook_session";

export type Session = {
  token: string;
  userId: string;
  email: string;
  expiresAt: string;
};

function key(): Buffer {
  const value = process.env.WEB_SESSION_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("WEB_SESSION_KEY must be 64 hex characters");
  }
  return Buffer.from(value, "hex");
}

export function sealSession(session: Session): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final(),
  ]);
  return [nonce, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

export function unsealSession(value: string | undefined): Session | null {
  if (!value) return null;
  try {
    const parts = value.split(".");
    if (parts.length !== 3) return null;
    const [nonce, tag, encrypted] = parts.map((part) =>
      Buffer.from(part, "base64url"),
    );
    if (nonce!.length !== 12 || tag!.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), nonce!);
    decipher.setAuthTag(tag!);
    const parsed: unknown = JSON.parse(
      Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString(
        "utf8",
      ),
    );
    if (!parsed || typeof parsed !== "object") return null;
    const session = parsed as Partial<Session>;
    if (
      typeof session.token !== "string" ||
      typeof session.userId !== "string" ||
      typeof session.email !== "string" ||
      typeof session.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= Date.now()
    ) {
      return null;
    }
    return session as Session;
  } catch {
    return null;
  }
}

export function cookieOptions(expiresAt: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.WEB_PUBLIC_ORIGIN?.startsWith("https://") ?? false,
    path: "/",
    maxAge: Math.max(
      0,
      Math.floor((Date.parse(expiresAt) - Date.now()) / 1000),
    ),
  };
}
