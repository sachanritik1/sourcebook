import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cookieOptions, sealSession, unsealSession } from "../lib/session";
import { validOrigin } from "../lib/backend";

const session = {
  token: "private-bearer-token",
  userId: "user-1",
  email: "alice@example.com",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

beforeEach(() => {
  process.env.WEB_SESSION_KEY = "ab".repeat(32);
  process.env.WEB_PUBLIC_ORIGIN = "http://localhost:3001";
});

afterEach(() => {
  delete process.env.WEB_SESSION_KEY;
  delete process.env.WEB_PUBLIC_ORIGIN;
});

describe("browser session boundary", () => {
  it("round-trips a session without exposing its token in the cookie value", () => {
    const cookie = sealSession(session);
    expect(cookie).not.toContain(session.token);
    expect(unsealSession(cookie)).toEqual(session);
  });

  it("rejects modified and expired cookies", () => {
    const cookie = sealSession(session);
    expect(unsealSession(`${cookie.slice(0, -2)}aa`)).toBeNull();
    expect(
      unsealSession(
        sealSession({
          ...session,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ),
    ).toBeNull();
  });

  it("sets a secure cookie only for an HTTPS public origin", () => {
    expect(cookieOptions(session.expiresAt).secure).toBe(false);
    process.env.WEB_PUBLIC_ORIGIN = "https://research.example.com";
    expect(cookieOptions(session.expiresAt).secure).toBe(true);
  });

  it("requires the configured origin for writes", () => {
    expect(validOrigin(new Request("http://localhost:3001/api/session"))).toBe(
      false,
    );
    expect(
      validOrigin(
        new Request("http://localhost:3001/api/session", {
          headers: { Origin: "https://evil.example" },
        }),
      ),
    ).toBe(false);
    expect(
      validOrigin(
        new Request("http://localhost:3001/api/session", {
          headers: { Origin: "http://localhost:3001" },
        }),
      ),
    ).toBe(true);
  });
});
