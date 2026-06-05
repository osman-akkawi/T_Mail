import type { NextFunction, Request, Response } from "express";

const requests = new Map<string, { count: number; windowStart: number }>();

interface RateLimitOptions {
  cleanupIntervalMs?: number;
  maxKeys?: number;
}

let lastCleanupAt = 0;

function cleanupRequests(now: number, windowMs: number, maxKeys: number): void {
  for (const [key, state] of requests.entries()) {
    if (now - state.windowStart > windowMs) {
      requests.delete(key);
    }
  }

  if (requests.size <= maxKeys) {
    return;
  }

  const oldest = Array.from(requests.entries()).sort(
    (left, right) => left[1].windowStart - right[1].windowStart,
  );
  const deleteCount = requests.size - maxKeys;
  for (const [key] of oldest.slice(0, deleteCount)) {
    requests.delete(key);
  }
}

export function apiRateLimit(limit: number, windowMs: number, options: RateLimitOptions = {}) {
  const cleanupIntervalMs = options.cleanupIntervalMs ?? Math.max(windowMs, 60_000);
  const maxKeys = options.maxKeys ?? 50_000;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? "unknown";
    const now = Date.now();

    if (now - lastCleanupAt > cleanupIntervalMs || requests.size > maxKeys) {
      cleanupRequests(now, windowMs, maxKeys);
      lastCleanupAt = now;
    }

    const state = requests.get(key);
    const resetAt = state ? state.windowStart + windowMs : now + windowMs;

    if (!state || now - state.windowStart > windowMs) {
      requests.set(key, { count: 1, windowStart: now });
      res.setHeader("X-RateLimit-Limit", String(limit));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - 1)));
      next();
      return;
    }

    if (state.count >= limit) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
      res.setHeader("X-RateLimit-Limit", String(limit));
      res.setHeader("X-RateLimit-Remaining", "0");
      res.status(429).json({ ok: false, error: "Too many requests" });
      return;
    }

    state.count += 1;
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - state.count)));
    next();
  };
}
