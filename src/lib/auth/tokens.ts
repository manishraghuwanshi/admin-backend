import { createHash, randomBytes } from "node:crypto";

import { jwtVerify, SignJWT } from "jose";

import { env } from "../../config/env.js";
import type { AdminRole } from "../../db/schema.js";

const accessSecret = new TextEncoder().encode(env.AUTH_ACCESS_TOKEN_SECRET);

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: AdminRole;
  sid: string;
}

export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
  return new SignJWT({
    email: payload.email,
    role: payload.role,
    sid: payload.sid,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${env.AUTH_ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(accessSecret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, accessSecret);

  if (
    typeof payload.sub !== "string" ||
    typeof payload.email !== "string" ||
    typeof payload.role !== "string" ||
    typeof payload.sid !== "string"
  ) {
    throw new Error("Invalid access token payload");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    role: payload.role as AdminRole,
    sid: payload.sid,
  };
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function refreshTokenExpiresAt(): Date {
  return new Date(Date.now() + env.AUTH_REFRESH_TOKEN_TTL_SECONDS * 1000);
}
