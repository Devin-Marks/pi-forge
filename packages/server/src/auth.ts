import { Buffer } from "node:buffer";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * scrypt cost params. N=16384 (2^14) targets ~50–100 ms per verify on
 * modern hardware — slow enough to make brute-forcing expensive,
 * fast enough that an interactive login feels instant. r/p left at
 * the recommended defaults. Bump N when verifies start feeling fast.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

const HASH_PREFIX = "scrypt";
const lastTokenActivityMs = new Map<string, number>();
const loginAttempts = new Map<string, { failures: number; lockedUntilMs?: number }>();

export interface JwtPayload {
  sub: "ui-user";
  iat: number;
  exp: number;
  /** When true, this token may only call `POST /auth/change-password`. */
  mustChangePassword: boolean;
}

export interface IssuedToken {
  token: string;
  expiresAt: string;
}

export type PasswordSource = "stored" | "env" | "none";

export interface LoginLockoutState {
  locked: boolean;
  remainingMs: number;
  lockedUntil?: string;
}

/**
 * Constant-time string comparison. Pads the shorter buffer so timingSafeEqual
 * can run on equal-length inputs, then enforces the length check after-the-fact
 * so length isn't leaked through early-return timing.
 */
export function constantTimeStringEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  const len = Math.max(a.length, b.length);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  a.copy(aPadded);
  b.copy(bPadded);
  return timingSafeEqual(aPadded, bPadded) && a.length === b.length;
}

export function generateToken(opts: { mustChangePassword: boolean }): IssuedToken {
  if (config.auth.jwtSecret === undefined) {
    throw new Error("auth: cannot generate token — JWT_SECRET not configured");
  }
  const expiresIn = config.auth.jwtExpiresInSeconds;
  const token = jwt.sign(
    {
      sub: "ui-user",
      mustChangePassword: opts.mustChangePassword,
    } satisfies Pick<JwtPayload, "sub" | "mustChangePassword">,
    config.auth.jwtSecret,
    {
      algorithm: "HS256",
      expiresIn,
    },
  );
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  lastTokenActivityMs.set(token, Date.now());
  return { token, expiresAt };
}

/**
 * Verify a JWT and return the typed payload, or undefined on any failure
 * (bad signature, expired, missing JWT_SECRET, wrong subject).
 */
export function verifyToken(token: string, opts: { touch?: boolean } = {}): JwtPayload | undefined {
  if (config.auth.jwtSecret === undefined) return undefined;
  try {
    const decoded = jwt.verify(token, config.auth.jwtSecret, {
      algorithms: ["HS256"],
    });
    if (typeof decoded !== "object" || decoded === null) return undefined;
    if (decoded.sub !== "ui-user") return undefined;
    if (typeof decoded.iat !== "number" || typeof decoded.exp !== "number") return undefined;
    // mustChangePassword may be absent on tokens issued before this
    // field existed; treat absence as `false` so existing sessions
    // don't get force-rerouted to the change-password screen.
    if (!tokenIsActive(token, decoded.iat, opts.touch !== false)) return undefined;
    const mustChangePassword =
      typeof (decoded as { mustChangePassword?: unknown }).mustChangePassword === "boolean"
        ? (decoded as { mustChangePassword: boolean }).mustChangePassword
        : false;
    return { sub: "ui-user", iat: decoded.iat, exp: decoded.exp, mustChangePassword };
  } catch {
    // jsonwebtoken throws on malformed/expired/wrong-secret tokens.
    // Caller treats undefined as "no valid token" without
    // distinguishing why — clients can't act on the distinction
    // (and we don't want to leak which case applies to a brute-forcer).
    return undefined;
  }
}

function tokenIsActive(token: string, issuedAtSeconds: number, touch: boolean): boolean {
  const timeoutSeconds = config.auth.loginInactivityTimeoutSeconds;
  if (timeoutSeconds <= 0) return true;
  const now = Date.now();
  const lastSeen = lastTokenActivityMs.get(token) ?? issuedAtSeconds * 1000;
  if (now - lastSeen > timeoutSeconds * 1000) {
    lastTokenActivityMs.delete(token);
    return false;
  }
  if (touch) lastTokenActivityMs.set(token, now);
  return true;
}

export function verifyApiKey(presented: string): boolean {
  const expected = config.auth.apiKey;
  if (expected === undefined) return false;
  return constantTimeStringEqual(presented, expected);
}

export function loginLockoutKey(username: string | undefined): string {
  return (username ?? config.auth.localAdminUsername).trim().toLowerCase();
}

export function getLoginLockoutState(key: string, nowMs = Date.now()): LoginLockoutState {
  const state = loginAttempts.get(key);
  const lockedUntilMs = state?.lockedUntilMs;
  if (lockedUntilMs === undefined) return { locked: false, remainingMs: 0 };
  if (lockedUntilMs <= nowMs) {
    if ((state?.failures ?? 0) <= 0) loginAttempts.delete(key);
    else loginAttempts.set(key, { failures: 0 });
    return { locked: false, remainingMs: 0 };
  }
  return {
    locked: true,
    remainingMs: lockedUntilMs - nowMs,
    lockedUntil: new Date(lockedUntilMs).toISOString(),
  };
}

export function recordLoginFailure(key: string, nowMs = Date.now()): LoginLockoutState {
  const prior = loginAttempts.get(key);
  const failures = (prior?.failures ?? 0) + 1;
  if (failures >= config.auth.loginAttemptLimitMax) {
    const lockedUntilMs = nowMs + config.auth.loginLockoutMs;
    loginAttempts.set(key, { failures: 0, lockedUntilMs });
    return {
      locked: true,
      remainingMs: config.auth.loginLockoutMs,
      lockedUntil: new Date(lockedUntilMs).toISOString(),
    };
  }
  loginAttempts.set(key, { failures });
  return { locked: false, remainingMs: 0 };
}

export function resetLoginFailures(key: string): void {
  loginAttempts.delete(key);
}

/**
 * Verify a presented password against either the on-disk hash (if
 * present) or the env UI_PASSWORD (fallback). The returned `source`
 * lets the caller decide whether to set `mustChangePassword` on the
 * issued token: `env` means the user is logging in with the
 * deployment-baked credential and (if `requirePasswordChange` is on)
 * must change it before doing anything else.
 *
 * Once a hash exists on disk, the env password is IGNORED — that
 * file is the canonical credential and should survive env-rotation
 * just like jwt-secret does.
 */
export async function verifyPasswordWithSource(
  presented: string,
): Promise<{ ok: boolean; source: PasswordSource }> {
  const stored = readStoredHash();
  if (stored !== undefined) {
    const ok = await verifyAgainstStoredHash(presented, stored);
    return { ok, source: "stored" };
  }
  const envPw = config.auth.uiPassword;
  if (envPw !== undefined) {
    return { ok: constantTimeStringEqual(presented, envPw), source: "env" };
  }
  return { ok: false, source: "none" };
}

export function passwordConfigured(): boolean {
  return readStoredHash() !== undefined || config.auth.uiPassword !== undefined;
}

/**
 * Hash the new password and atomically replace the on-disk file.
 * Mode 0600 — only the pi-forge process owner should be able to
 * read it. Atomic replace via tmp + rename so a crash mid-write
 * doesn't leave a half-written hash that locks the user out.
 */
export async function persistPassword(plain: string): Promise<void> {
  const encoded = await hashPassword(plain);
  const path = config.auth.passwordHashFile;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${encoded}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = await scrypt(plain, salt, SCRYPT_KEYLEN);
  return [
    HASH_PREFIX,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(encoded: string): ParsedHash | undefined {
  const parts = encoded.split("$");
  if (parts.length !== 6) return undefined;
  if (parts[0] !== HASH_PREFIX) return undefined;
  const n = Number.parseInt(parts[1] ?? "", 10);
  const r = Number.parseInt(parts[2] ?? "", 10);
  const p = Number.parseInt(parts[3] ?? "", 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return undefined;
  try {
    const salt = Buffer.from(parts[4] ?? "", "base64");
    const hash = Buffer.from(parts[5] ?? "", "base64");
    if (salt.length === 0 || hash.length === 0) return undefined;
    return { n, r, p, salt, hash };
  } catch {
    return undefined;
  }
}

function readStoredHash(): string | undefined {
  const path = config.auth.passwordHashFile;
  if (!existsSync(path)) return undefined;
  try {
    const v = readFileSync(path, "utf8").trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function scryptWithOptions(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => {
      if (err !== null) {
        reject(err);
        return;
      }
      resolve(derived);
    });
  });
}

async function verifyAgainstStoredHash(presented: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (parsed === undefined) return false;
  // Honour the stored params (not our current constants) so older
  // hashes with different cost parameters still verify after a
  // params bump. New hashes always use the current SCRYPT_* values.
  const candidate = await scryptWithOptions(presented, parsed.salt, parsed.hash.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
  });
  if (candidate.length !== parsed.hash.length) return false;
  return timingSafeEqual(candidate, parsed.hash);
}

export function extractBearer(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(headerValue);
  return m?.[1];
}
