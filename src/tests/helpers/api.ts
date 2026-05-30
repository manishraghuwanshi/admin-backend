import request, { type Agent, type Response } from "supertest";

import { createApp } from "../../app.js";
import { env } from "../../config/env.js";
import { TEST_ALLOWED_ORIGIN } from "./env.js";

/**
 * HTTP helpers.
 *
 * A `Agent` keeps cookies between calls, which mirrors how the browser-based
 * admin frontend behaves: the access and refresh tokens live in httpOnly cookies
 * and every state-changing request carries an `Origin`.
 */

export function createTestApp() {
  return createApp();
}

/** A client that presents the allowed same-site origin on every request. */
export function createAgent(app = createTestApp()): Agent {
  return request.agent(app).set("Origin", TEST_ALLOWED_ORIGIN);
}

/** A client from a foreign origin - used to prove CSRF rejection. */
export function createCrossSiteAgent(app = createTestApp()): Agent {
  return request.agent(app).set("Origin", "https://evil.example.com");
}

/** A client with no `Origin` header at all (curl / server-to-server). */
export function createOriginlessAgent(app = createTestApp()): Agent {
  return request.agent(app);
}

export interface AuthCookiePair {
  accessToken: string;
  refreshToken: string;
}

/** Parses `Set-Cookie` headers into the two auth cookie values. */
export function readAuthCookies(res: Response): AuthCookiePair {
  const cookies = res.headers["set-cookie"] ?? [];
  const all = Array.isArray(cookies) ? cookies : [String(cookies)];

  const find = (name: string): string => {
    const match = all.find((cookie) => cookie.startsWith(`${name}=`));

    if (!match) {
      throw new Error(`Expected a '${name}' cookie in the response`);
    }

    return decodeURIComponent(match.split(";")[0]!.slice(name.length + 1));
  };

  return {
    accessToken: find(env.AUTH_COOKIE_NAME_ACCESS),
    refreshToken: find(env.AUTH_COOKIE_NAME_REFRESH),
  };
}

/** True when both auth cookies have been expired/cleared in a response. */
export function authCookiesCleared(res: Response): boolean {
  const cookies = res.headers["set-cookie"] ?? [];
  const all = Array.isArray(cookies) ? cookies : [String(cookies)];

  const cleared = (name: string): boolean =>
    all.some(
      (cookie) =>
        cookie.startsWith(`${name}=`) && /(?:^|;\s*)expires=Thu, 01 Jan 1970/i.test(cookie),
    );

  return (
    cleared(env.AUTH_COOKIE_NAME_ACCESS) && cleared(env.AUTH_COOKIE_NAME_REFRESH)
  );
}

/** Logs in through the real endpoint so sessions are created exactly as in production. */
export async function login(
  agent: Agent,
  credentials: { email: string; password: string },
): Promise<Response> {
  return agent.post("/api/auth/login").send(credentials).expect(200);
}

/** Manually attaches auth cookies, e.g. to replay a rotated-out token. */
export function withAuthCookies(agent: Agent, cookies: AuthCookiePair): Agent {
  return agent.set("Cookie", cookieHeaderFor(cookies));
}

/** Serialises an auth cookie pair for a manual `Cookie` header. */
export function cookieHeaderFor(cookies: AuthCookiePair): string {
  return [
    `${env.AUTH_COOKIE_NAME_ACCESS}=${cookies.accessToken}`,
    `${env.AUTH_COOKIE_NAME_REFRESH}=${cookies.refreshToken}`,
  ].join("; ");
}

/** Serialises only the refresh cookie, e.g. to replay a stolen refresh token. */
export function refreshCookieHeader(refreshToken: string): string {
  return `${env.AUTH_COOKIE_NAME_REFRESH}=${refreshToken}`;
}

/** Serialises only the access cookie, e.g. to replay a stolen access token. */
export function accessCookieHeader(accessToken: string): string {
  return `${env.AUTH_COOKIE_NAME_ACCESS}=${accessToken}`;
}

/** Assert-friendly access to the standard success envelope. */
export function dataOf<T = Record<string, unknown>>(res: Response): T {
  return (res.body as { data: T }).data;
}

export function errorOf(res: Response): { code?: string; message?: string } {
  return (res.body as { error?: { code?: string; message?: string } }).error ?? {};
}
