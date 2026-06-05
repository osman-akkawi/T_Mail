import crypto, { randomInt } from "crypto";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { UnauthorizedError, ValidationError } from "../errors";
import type { TMailUser } from "../types";
import { TelegramClient } from "../telegram/client";

export type AuthMethod = "telegram_webapp" | "telegram_otp";
export type DeviceType = "desktop" | "mobile" | "tablet" | "telegram" | "unknown";

export interface AuthSession {
  sessionId: string;
  telegramUserId: number;
  tmailAddress: string;
  deviceType: DeviceType;
  deviceLabel: string;
  authMethod: AuthMethod;
  ipAddress: string;
  userAgent: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

interface JwtSessionPayload extends jwt.JwtPayload {
  sid: string;
  sub: string;
  typ: "tmail_session";
}

interface LoginChallenge {
  challengeId: string;
  telegramUserId: number;
  tmailAddress: string;
  codeHash: string;
  expiresAt: number;
  attemptsRemaining: number;
  createdAt: number;
}

function inferDeviceType(userAgent: string): DeviceType {
  const ua = userAgent.toLowerCase();
  if (ua.includes("telegram")) {
    return "telegram";
  }
  if (ua.includes("ipad") || ua.includes("tablet")) {
    return "tablet";
  }
  if (ua.includes("android") || ua.includes("iphone") || ua.includes("mobile")) {
    return "mobile";
  }
  if (ua.length > 0) {
    return "desktop";
  }
  return "unknown";
}

function sanitizeLabel(input: string): string {
  const cleaned = input.trim().replace(/\s+/g, " ");
  return cleaned.slice(0, 60);
}

function defaultDeviceLabel(deviceType: DeviceType): string {
  switch (deviceType) {
    case "telegram":
      return "Telegram Mini App";
    case "mobile":
      return "Mobile Browser";
    case "tablet":
      return "Tablet Browser";
    case "desktop":
      return "Desktop Browser";
    default:
      return "Unknown Device";
  }
}

function safeEqualHex(leftHex: string, rightHex: string): boolean {
  if (leftHex.length !== rightHex.length) {
    return false;
  }
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export class SessionAuthService {
  private readonly challenges = new Map<string, LoginChallenge>();
  private readonly sessionsById = new Map<string, AuthSession>();
  private readonly sessionIdsByUser = new Map<number, Set<string>>();
  private readonly lastOtpIssuedAt = new Map<number, number>();
  private onStateChange: (() => void) | null = null;

  private readonly sessionTtlMs: number;
  private readonly challengeTtlMs: number;
  private readonly maxAttempts: number;
  private readonly resendCooldownMs: number;
  private readonly maxSessionsPerUser: number;
  private readonly cleanupIntervalMs: number;
  private readonly maxPendingChallenges: number;
  private lastChallengeCleanupAt = 0;
  private lastSessionCleanupAt = 0;

  constructor(
    private readonly jwtSecret: string,
    private readonly telegramClient: TelegramClient,
  ) {
    this.sessionTtlMs = Number(process.env.SESSION_TTL_HOURS ?? 24 * 30) * 60 * 60 * 1000;
    this.challengeTtlMs = Number(process.env.LOGIN_CODE_TTL_SECONDS ?? 300) * 1000;
    this.maxAttempts = Number(process.env.LOGIN_CODE_MAX_ATTEMPTS ?? 5);
    this.resendCooldownMs = Number(process.env.LOGIN_CODE_RESEND_COOLDOWN_SECONDS ?? 45) * 1000;
    this.maxSessionsPerUser = Number(process.env.MAX_SESSIONS_PER_USER ?? 8);
    this.cleanupIntervalMs = Number(process.env.AUTH_CLEANUP_INTERVAL_SECONDS ?? 60) * 1000;
    this.maxPendingChallenges = Number(process.env.MAX_PENDING_LOGIN_CHALLENGES ?? 10_000);
  }

  /** Wire a callback that fires after any session mutation (used to schedule snapshot saves). */
  setStateChangeCallback(fn: () => void): void {
    this.onStateChange = fn;
  }

  /** Return all currently-tracked sessions (active + not yet expired). */
  listAllSessions(): AuthSession[] {
    return Array.from(this.sessionsById.values());
  }

  /**
   * Restore session state from a persisted snapshot.  Only restores sessions
   * that have not yet expired.  Writes directly into the Maps without firing
   * the state-change callback or enforcing the per-user session cap.
   */
  rehydrateFromSnapshot(sessions: AuthSession[]): void {
    const now = Date.now();
    let count = 0;
    for (const session of sessions) {
      if (session.expiresAt <= now) continue;
      this.sessionsById.set(session.sessionId, session);
      const bucket = this.sessionIdsByUser.get(session.telegramUserId) ?? new Set<string>();
      bucket.add(session.sessionId);
      this.sessionIdsByUser.set(session.telegramUserId, bucket);
      count += 1;
    }
    if (count > 0) {
      console.log(`Sessions rehydrated: ${count} active session(s).`);
    }
  }

  private hashChallengeCode(challengeId: string, code: string): string {
    return crypto
      .createHash("sha256")
      .update(`${challengeId}:${code}:${this.jwtSecret}`)
      .digest("hex");
  }

  private makeSessionToken(sessionId: string, telegramUserId: number): string {
    return jwt.sign(
      {
        sid: sessionId,
        sub: String(telegramUserId),
        typ: "tmail_session",
      } satisfies JwtSessionPayload,
      this.jwtSecret,
      { expiresIn: Math.max(1, Math.floor(this.sessionTtlMs / 1000)) },
    );
  }

  private cleanupExpiredChallenges(now = Date.now(), force = false): void {
    if (!force && now - this.lastChallengeCleanupAt < this.cleanupIntervalMs) {
      return;
    }
    this.lastChallengeCleanupAt = now;

    for (const [challengeId, challenge] of this.challenges.entries()) {
      if (challenge.expiresAt <= now) {
        this.challenges.delete(challengeId);
      }
    }

    for (const [telegramUserId, issuedAt] of this.lastOtpIssuedAt.entries()) {
      if (now - issuedAt > this.resendCooldownMs) {
        this.lastOtpIssuedAt.delete(telegramUserId);
      }
    }
  }

  private removeSession(sessionId: string): boolean {
    const existing = this.sessionsById.get(sessionId);
    if (!existing) {
      return false;
    }

    this.sessionsById.delete(sessionId);
    const bucket = this.sessionIdsByUser.get(existing.telegramUserId);
    if (bucket) {
      bucket.delete(sessionId);
      if (bucket.size === 0) {
        this.sessionIdsByUser.delete(existing.telegramUserId);
      }
    }
    this.onStateChange?.();
    return true;
  }

  private cleanupExpiredSessions(now = Date.now(), force = false): void {
    if (!force && now - this.lastSessionCleanupAt < this.cleanupIntervalMs) {
      return;
    }
    this.lastSessionCleanupAt = now;

    for (const [sessionId, session] of this.sessionsById.entries()) {
      if (session.expiresAt <= now) {
        this.removeSession(sessionId);
      }
    }
  }

  private trackSession(session: AuthSession): void {
    this.sessionsById.set(session.sessionId, session);
    const bucket = this.sessionIdsByUser.get(session.telegramUserId) ?? new Set<string>();
    bucket.add(session.sessionId);
    this.sessionIdsByUser.set(session.telegramUserId, bucket);

    if (bucket.size > this.maxSessionsPerUser) {
      const sessions = Array.from(bucket)
        .map((id) => this.sessionsById.get(id))
        .filter((item): item is AuthSession => Boolean(item))
        .sort((a, b) => a.lastSeenAt - b.lastSeenAt);

      while (sessions.length > this.maxSessionsPerUser) {
        const stale = sessions.shift();
        if (!stale) {
          break;
        }
        this.removeSession(stale.sessionId);
      }
    }

    this.onStateChange?.();
  }

  private createSession(params: {
    user: TMailUser;
    authMethod: AuthMethod;
    ipAddress: string;
    userAgent: string;
    deviceLabel?: string;
  }): { session: AuthSession; sessionToken: string } {
    this.cleanupExpiredSessions();
    const now = Date.now();
    const deviceType = inferDeviceType(params.userAgent);
    const resolvedLabel = sanitizeLabel(params.deviceLabel ?? "") || defaultDeviceLabel(deviceType);

    const session: AuthSession = {
      sessionId: uuidv4(),
      telegramUserId: params.user.telegramUserId,
      tmailAddress: params.user.tmailAddress,
      deviceType,
      deviceLabel: resolvedLabel,
      authMethod: params.authMethod,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.sessionTtlMs,
    };

    this.trackSession(session);

    return {
      session,
      sessionToken: this.makeSessionToken(session.sessionId, session.telegramUserId),
    };
  }

  async requestLoginCode(params: {
    user: TMailUser;
    ipAddress: string;
    userAgent: string;
  }): Promise<{ challengeId: string; expiresInSeconds: number }> {
    const now = Date.now();
    this.cleanupExpiredChallenges(now);
    if (this.challenges.size >= this.maxPendingChallenges) {
      this.cleanupExpiredChallenges(now, true);
      if (this.challenges.size >= this.maxPendingChallenges) {
        throw new ValidationError("Too many login attempts. Please try again shortly.");
      }
    }

    const lastIssue = this.lastOtpIssuedAt.get(params.user.telegramUserId) ?? 0;
    if (now - lastIssue < this.resendCooldownMs) {
      const remainingSeconds = Math.ceil((this.resendCooldownMs - (now - lastIssue)) / 1000);
      throw new ValidationError(`Please wait ${remainingSeconds}s before requesting another code.`);
    }

    const challengeId = uuidv4();
    const code = String(randomInt(100000, 1000000));
    const expiresAt = now + this.challengeTtlMs;

    const challenge: LoginChallenge = {
      challengeId,
      telegramUserId: params.user.telegramUserId,
      tmailAddress: params.user.tmailAddress,
      codeHash: this.hashChallengeCode(challengeId, code),
      expiresAt,
      attemptsRemaining: this.maxAttempts,
      createdAt: now,
    };

    this.challenges.set(challengeId, challenge);
    this.lastOtpIssuedAt.set(params.user.telegramUserId, now);

    await this.telegramClient.sendNotification(
      params.user.telegramUserId,
      [
        "T-Mail verification code:",
        code,
        "",
        `Code expires in ${Math.floor(this.challengeTtlMs / 1000 / 60)} minutes.`,
        "If this was not you, ignore this message.",
      ].join("\n"),
      { silent: false },
    );

    return {
      challengeId,
      expiresInSeconds: Math.floor(this.challengeTtlMs / 1000),
    };
  }

  verifyLoginCode(params: {
    user: TMailUser;
    challengeId: string;
    code: string;
    ipAddress: string;
    userAgent: string;
    deviceLabel?: string;
  }): { session: AuthSession; sessionToken: string } {
    this.cleanupExpiredChallenges();
    const challenge = this.challenges.get(params.challengeId);
    if (!challenge) {
      throw new UnauthorizedError("Invalid or expired verification code.");
    }

    if (challenge.telegramUserId !== params.user.telegramUserId) {
      this.challenges.delete(params.challengeId);
      throw new UnauthorizedError("Invalid or expired verification code.");
    }

    if (challenge.expiresAt <= Date.now()) {
      this.challenges.delete(params.challengeId);
      throw new UnauthorizedError("Verification code expired.");
    }

    if (challenge.attemptsRemaining <= 0) {
      this.challenges.delete(params.challengeId);
      throw new UnauthorizedError("Too many invalid attempts. Request a new code.");
    }

    const expectedHash = challenge.codeHash;
    const providedHash = this.hashChallengeCode(challenge.challengeId, params.code);
    const valid = safeEqualHex(expectedHash, providedHash);

    if (!valid) {
      challenge.attemptsRemaining -= 1;
      if (challenge.attemptsRemaining <= 0) {
        this.challenges.delete(params.challengeId);
      } else {
        this.challenges.set(params.challengeId, challenge);
      }
      throw new UnauthorizedError("Invalid verification code.");
    }

    this.challenges.delete(params.challengeId);
    return this.createSession({
      user: params.user,
      authMethod: "telegram_otp",
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      deviceLabel: params.deviceLabel,
    });
  }

  createSessionFromTelegram(params: {
    user: TMailUser;
    ipAddress: string;
    userAgent: string;
    deviceLabel?: string;
  }): { session: AuthSession; sessionToken: string } {
    return this.createSession({
      user: params.user,
      authMethod: "telegram_webapp",
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      deviceLabel: params.deviceLabel,
    });
  }

  verifySessionToken(sessionToken: string): AuthSession {
    this.cleanupExpiredSessions();

    let payload: JwtSessionPayload;
    try {
      const decoded = jwt.verify(sessionToken, this.jwtSecret) as JwtSessionPayload;
      payload = decoded;
    } catch (_error) {
      throw new UnauthorizedError("Invalid session token.");
    }

    if (payload.typ !== "tmail_session" || !payload.sid || !payload.sub) {
      throw new UnauthorizedError("Invalid session token.");
    }

    const session = this.sessionsById.get(payload.sid);
    if (!session) {
      throw new UnauthorizedError("Session not found or already revoked.");
    }

    if (session.expiresAt <= Date.now()) {
      this.removeSession(session.sessionId);
      throw new UnauthorizedError("Session expired.");
    }

    if (session.telegramUserId !== Number(payload.sub)) {
      this.removeSession(session.sessionId);
      throw new UnauthorizedError("Invalid session token.");
    }

    session.lastSeenAt = Date.now();
    this.sessionsById.set(session.sessionId, session);
    return session;
  }

  listSessions(telegramUserId: number): AuthSession[] {
    this.cleanupExpiredSessions();
    const ids = this.sessionIdsByUser.get(telegramUserId);
    if (!ids) {
      return [];
    }

    return Array.from(ids)
      .map((id) => this.sessionsById.get(id))
      .filter((item): item is AuthSession => Boolean(item))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  revokeSession(telegramUserId: number, sessionId: string): boolean {
    const existing = this.sessionsById.get(sessionId);
    if (!existing || existing.telegramUserId !== telegramUserId) {
      return false;
    }
    return this.removeSession(sessionId);
  }

  revokeAllSessions(telegramUserId: number, exceptSessionId?: string): number {
    const ids = this.sessionIdsByUser.get(telegramUserId);
    if (!ids) {
      return 0;
    }

    let revoked = 0;
    for (const id of Array.from(ids)) {
      if (exceptSessionId && id === exceptSessionId) {
        continue;
      }
      if (this.revokeSession(telegramUserId, id)) {
        revoked += 1;
      }
    }

    return revoked;
  }
}
