import React from "react";
import { api } from "../api";
import type { AuthSession, TMailUser } from "../types";

interface SettingsPageProps {
  user: TMailUser;
  onUserUpdate: (user: TMailUser) => void;
}

interface StorageUsage {
  used: number;
  limit: number;
  percentage: number;
  unlimited: boolean;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`;
  }

  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatPercentage(percentage: number, used: number): string {
  if (used > 0 && percentage < 0.01) {
    return "<0.01%";
  }

  return `${percentage.toFixed(2).replace(/\.?0+$/, "")}%`;
}

function sessionMethodLabel(method: AuthSession["authMethod"]): string {
  return method === "telegram_otp" ? "Email + Telegram Code" : "Telegram Mini App";
}

function sessionTypeLabel(type: AuthSession["deviceType"]): string {
  switch (type) {
    case "telegram":
      return "Telegram";
    case "mobile":
      return "Mobile";
    case "tablet":
      return "Tablet";
    case "desktop":
      return "Desktop";
    default:
      return "Unknown";
  }
}

export default function SettingsPage({ user }: SettingsPageProps) {
  const [usage, setUsage] = React.useState<StorageUsage | null>(null);
  const [usageLoading, setUsageLoading] = React.useState(true);
  const [usageError, setUsageError] = React.useState<string | null>(null);
  const [sessions, setSessions] = React.useState<AuthSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = React.useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = React.useState(true);
  const [sessionsError, setSessionsError] = React.useState<string | null>(null);

  const loadSessions = React.useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);

    try {
      const response = await api.user.sessions();
      setSessions(response.sessions);
      setCurrentSessionId(response.currentSessionId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to load sessions";
      setSessionsError(message);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const loadStorageUsage = React.useCallback(async () => {
    setUsageLoading(true);
    setUsageError(null);

    try {
      setUsage(await api.user.storageUsage());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to load storage usage";
      setUsageError(message);
    } finally {
      setUsageLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadStorageUsage();
    void loadSessions();
  }, [loadSessions, loadStorageUsage]);

  React.useEffect(() => {
    const refreshOnFocus = () => {
      void loadStorageUsage();
    };

    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [loadStorageUsage]);

  const logoutSessions = async (scope: "others" | "all") => {
    try {
      await api.user.logout(scope);
      if (scope === "all") {
        api.auth.clearSessionToken();
        window.location.reload();
        return;
      }
      await loadSessions();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to log out sessions";
      setSessionsError(message);
    }
  };

  const storageIsUnlimited = usage ? usage.unlimited || usage.limit <= 0 : false;

  return (
    <section className="page settings-page">
      <h1>Account Settings</h1>
      <p>Manage your T-Mail identity, storage, and active devices.</p>

      <div className="settings-grid">
        <div className="settings-card">
          <h3>Profile</h3>
          <div className="settings-row"><span>Name</span><strong>{user.displayName}</strong></div>
          <div className="settings-row"><span>T-Mail</span><strong>{user.tmailAddress}</strong></div>
          <div className="settings-row"><span>Telegram</span><strong>@{user.telegramUsername || "unknown"}</strong></div>
          <div className="settings-row"><span>Plan</span><strong>{user.plan.toUpperCase()}</strong></div>
          <div className="settings-row"><span>Joined</span><strong>{new Date(user.createdAt).toLocaleDateString()}</strong></div>
        </div>

        <div className="settings-card">
          <h3>Storage</h3>
          {usage ? (
            <>
              <div className="settings-row"><span>Used</span><strong>{formatBytes(usage.used)}</strong></div>
              <div className="settings-row"><span>Limit</span><strong>{storageIsUnlimited ? "Unlimited" : formatBytes(usage.limit)}</strong></div>
              <div className="settings-row"><span>Usage</span><strong>{storageIsUnlimited ? "No quota" : formatPercentage(usage.percentage, usage.used)}</strong></div>
              <div className={`usage-track${storageIsUnlimited ? " unlimited" : ""}`}>
                <div
                  className="usage-fill"
                  style={{
                    width: storageIsUnlimited
                      ? "100%"
                      : `${usage.used > 0 ? Math.max(0.5, Math.min(100, usage.percentage)) : 0}%`,
                  }}
                />
              </div>
            </>
          ) : usageError ? (
            <p className="auth-error">{usageError}</p>
          ) : usageLoading ? (
            <p>Loading storage usage...</p>
          ) : (
            <p>No storage usage available.</p>
          )}
        </div>
      </div>

      <div className="settings-card sessions-card">
        <div className="sessions-head">
          <h3>Active Sessions</h3>
          <div className="sessions-actions">
            <button type="button" onClick={() => void logoutSessions("others")}>Logout Other Devices</button>
            <button type="button" onClick={() => void logoutSessions("all")}>Logout All Devices</button>
          </div>
        </div>

        {sessionsLoading && <p>Loading active sessions...</p>}
        {!sessionsLoading && sessionsError && <p className="auth-error">{sessionsError}</p>}

        {!sessionsLoading && !sessionsError && sessions.length === 0 && (
          <p>No active sessions found.</p>
        )}

        {!sessionsLoading && !sessionsError && sessions.length > 0 && (
          <div className="session-list">
            {sessions.map((session) => (
              <div key={session.sessionId} className="session-item">
                <div className="session-item-top">
                  <strong>{session.deviceLabel}</strong>
                  <span className="session-chip">{sessionTypeLabel(session.deviceType)}</span>
                  {currentSessionId && currentSessionId === session.sessionId && (
                    <span className="session-chip current">Current</span>
                  )}
                </div>
                <div className="session-meta">Method: {sessionMethodLabel(session.authMethod)}</div>
                <div className="session-meta">Last active: {new Date(session.lastSeenAt).toLocaleString()}</div>
                <div className="session-meta">IP: {session.ipAddress || "unknown"}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
