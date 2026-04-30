import type { CookieOptions, Response } from "express";

import { env } from "../../config/env.js";

function baseCookieOptions(): CookieOptions {
  const sameSite = env.AUTH_COOKIE_SAMESITE;
  const secure = env.IS_PRODUCTION || sameSite === "none";

  return {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",
  };
}

export function setAuthCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
): void {
  res.cookie(env.AUTH_COOKIE_NAME_ACCESS, tokens.accessToken, {
    ...baseCookieOptions(),
    maxAge: env.AUTH_ACCESS_TOKEN_TTL_SECONDS * 1000,
  });

  res.cookie(env.AUTH_COOKIE_NAME_REFRESH, tokens.refreshToken, {
    ...baseCookieOptions(),
    maxAge: env.AUTH_REFRESH_TOKEN_TTL_SECONDS * 1000,
  });
}

export function clearAuthCookies(res: Response): void {
  const options = baseCookieOptions();

  res.clearCookie(env.AUTH_COOKIE_NAME_ACCESS, options);
  res.clearCookie(env.AUTH_COOKIE_NAME_REFRESH, options);
}
