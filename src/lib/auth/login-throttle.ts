/**
 * Per-account login throttling.
 *
 * Two bot controls live here, both scoped to a single administrator account
 * rather than to an IP address or to one process:
 *
 * 1. a minimum interval between failed attempts (`LOGIN_MIN_INTERVAL_MS`)
 * 2. a temporary lockout after `LOGIN_MAX_FAILED_ATTEMPTS` consecutive failures
 *    (`LOGIN_LOCKOUT_MS`)
 *
 * They are account-scoped on purpose. `authRateLimiter` already caps the request
 * rate per client, but it cannot slow a distributed attempt spread over many
 * addresses against one known mailbox, and its default store is in memory, so the
 * budget resets on every deploy. The state below is persisted on `admin_users`, so
 * it survives a restart and is shared by every instance.
 *
 * The pure functions are kept here (rather than inlined into the login service) so
 * the decision and the counter arithmetic can be tested without HTTP or a database.
 */

/** Least time allowed between two failed attempts for the same account. */
export const LOGIN_MIN_INTERVAL_MS = 5_000;

/** Consecutive failures that trip the lockout. */
export const LOGIN_MAX_FAILED_ATTEMPTS = 5;

/** How long the account stays locked once the threshold is reached. */
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

/** The stored throttle state a login decision is made from. */
export interface LoginThrottleState {
  failedLoginAttempts: number;
  lastFailedLoginAt: Date | null;
  lockedUntil: Date | null;
}

export type LoginThrottleDecision =
  | { allowed: true }
  | { allowed: false; reason: "locked" | "rate_limited"; retryAfterSeconds: number };

/** Whole seconds until `at`, never negative. Used for `Retry-After` and auditing. */
export function secondsUntil(at: Date, now = Date.now()): number {
  return Math.max(0, Math.ceil((at.getTime() - now) / 1000));
}

/**
 * Decide whether an attempt may proceed, checked **before** the password is
 * verified so a throttled account never pays for an Argon2 verification.
 *
 * Order matters: an active lock outranks the interval, so a locked account always
 * reports the same remaining time instead of a stream of 5-second waits.
 */
export function evaluateLoginThrottle(
  state: LoginThrottleState,
  now = Date.now(),
): LoginThrottleDecision {
  if (state.lockedUntil && state.lockedUntil.getTime() > now) {
    return {
      allowed: false,
      reason: "locked",
      retryAfterSeconds: secondsUntil(state.lockedUntil, now),
    };
  }

  if (state.lastFailedLoginAt) {
    const retryAt = state.lastFailedLoginAt.getTime() + LOGIN_MIN_INTERVAL_MS;

    if (retryAt > now) {
      return {
        allowed: false,
        reason: "rate_limited",
        // At least 1, so a response is never a misleading `Retry-After: 0`.
        retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)),
      };
    }
  }

  return { allowed: true };
}

export interface LoginFailureOutcome {
  /**
   * The counter stored after this failure. It resets to 0 when the threshold is
   * crossed, so the attempt that trips the lock starts the next sequence from a
   * clean slate once the lockout expires.
   */
  failedLoginAttempts: number;
  /** The lock deadline to store, or `null` when this failure did not lock. */
  lockedUntil: Date | null;
  /** True when this failure is the one that reached the threshold. */
  locked: boolean;
}

/**
 * The state that results from recording one failed password.
 *
 * Callers must not read the row, compute with this helper, and write the result
 * back: two concurrent failures would read the same counter and lose an increment.
 * `login()` applies the same arithmetic inside a single `UPDATE ... RETURNING`
 * instead, and this function is what that statement's logic is asserted against.
 */
export function applyFailedAttempt(state: LoginThrottleState, now: Date): LoginFailureOutcome {
  const attempts = state.failedLoginAttempts + 1;

  if (attempts >= LOGIN_MAX_FAILED_ATTEMPTS) {
    return {
      failedLoginAttempts: 0,
      lockedUntil: new Date(now.getTime() + LOGIN_LOCKOUT_MS),
      locked: true,
    };
  }

  return {
    failedLoginAttempts: attempts,
    lockedUntil: state.lockedUntil,
    locked: false,
  };
}