import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { ComposeModal } from "./components/ComposeModal";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { LoadingSpinner } from "./components/LoadingSpinner";
import AssistantPage from "./pages/Assistant";
import ComposePage from "./pages/Compose";
import DraftsPage from "./pages/Drafts";
import EmailPage from "./pages/Email";
import InboxPage from "./pages/Inbox";
import SearchPage from "./pages/Search";
import SentPage from "./pages/Sent";
import SettingsPage from "./pages/Settings";
import StarredPage from "./pages/Starred";
import TrashPage from "./pages/Trash";
import SpamPage from "./pages/Spam";
import { telegram } from "./telegram";
import { useEmailStore } from "./store/emailStore";
import type { TMailUser } from "./types";

type ThemeMode = "dark" | "light";
const THEME_STORAGE_KEY = "tmail_theme";
const TELEGRAM_LAUNCH_ATTEMPT_KEY = "tmail_telegram_launch_attempted";

function getInitialTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "dark";
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark" || stored === "light") {
    return stored;
  }

  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function readEnvString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getTMailDomain(): string {
  const raw = readEnvString(import.meta.env.VITE_TMAIL_EMAIL_DOMAIN)
    .replace(/^@/, "")
    .toLowerCase();

  return raw || "tmail";
}

function normalizeAddress(input: string): string {
  let value = input.trim().toLowerCase();
  if (!value) {
    return "";
  }
  if (!value.includes("@") && !value.includes("#")) {
    value = `${value}@${getTMailDomain()}`;
  }
  return value;
}

function buildTelegramLaunchUrl(botUsername: string): string {
  const botLink = readEnvString(import.meta.env.VITE_TELEGRAM_BOT_LINK);
  if (botLink) {
    return botLink;
  }

  return `https://t.me/${botUsername}?start=tmail_login`;
}

function LoginView(props: {
  error: string | null;
  inTelegram: boolean;
  canDevLogin: boolean;
  forceTelegramLaunch: boolean;
  loginAddress: string;
  setLoginAddress: (value: string) => void;
  code: string;
  setCode: (value: string) => void;
  challengeId: string | null;
  expiresInSeconds: number | null;
  busy: boolean;
  onTelegramLogin: () => void;
  onRequestCode: () => void;
  onVerifyCode: () => void;
  onResetCodeStep: () => void;
  onOpenTelegram: () => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  const canUseTelegramPrimary =
    !props.forceTelegramLaunch && (props.inTelegram || props.canDevLogin);
  const canUseCodeLogin = !props.inTelegram;

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-theme-row">
          <button type="button" className="theme-toggle-btn" onClick={props.onToggleTheme}>
            {props.theme === "dark" ? "Light Mode" : "Dark Mode"}
          </button>
        </div>
        {/* Logo */}
        <div className="auth-logo">
          <img className="auth-logo-icon" src="/logo.png" alt="T-Mail Logo" />
          <h1>T-Mail</h1>
        </div>
        {props.error && <div className="auth-error">{props.error}</div>}

        {canUseTelegramPrimary && (
          <button type="button" className="auth-primary" onClick={props.onTelegramLogin} disabled={props.busy}>
            {props.busy ? "Connecting…" : props.inTelegram ? "✈ Sign in with Telegram" : "🔓 Login (Dev only)"}
          </button>
        )}

        {canUseCodeLogin && (
          <>
            <div className="auth-divider">or use verification code</div>

            {!props.challengeId ? (
              <div className="auth-step">
                <label htmlFor="tmail-address">Email / T-Mail address</label>
                <input
                  id="tmail-address"
                  type="text"
                  placeholder={`yourname@${getTMailDomain()}`}
                  value={props.loginAddress}
                  onChange={(event) => props.setLoginAddress(event.target.value)}
                  autoComplete="username"
                />
                <button
                  type="button"
                  className="auth-primary"
                  onClick={props.onRequestCode}
                  disabled={props.busy}
                >
                  {props.busy ? "Sending…" : "Send Code to Telegram"}
                </button>
              </div>
            ) : (
              <div className="auth-step">
                <div className="auth-note">
                  Code sent to your Telegram for <strong>{normalizeAddress(props.loginAddress)}</strong>
                  {props.expiresInSeconds ? ` — expires in ${props.expiresInSeconds}s` : ""}.
                </div>
                <label htmlFor="tmail-code">Verification code</label>
                <input
                  id="tmail-code"
                  type="text"
                  placeholder="6-digit code"
                  inputMode="numeric"
                  maxLength={6}
                  value={props.code}
                  onChange={(event) => props.setCode(event.target.value.replace(/\D+/g, "").slice(0, 6))}
                  autoComplete="one-time-code"
                />
                <button
                  type="button"
                  className="auth-primary"
                  onClick={props.onVerifyCode}
                  disabled={props.busy}
                >
                  {props.busy ? "Verifying…" : "Verify and Sign In"}
                </button>
                <button
                  type="button"
                  className="auth-secondary"
                  onClick={props.onResetCodeStep}
                  disabled={props.busy}
                >
                  ← Use Different Address
                </button>
              </div>
            )}

            <button type="button" className="auth-secondary" onClick={props.onOpenTelegram} disabled={props.busy}>
              Open T-Mail Bot in Telegram
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const { unreadCounts, setComposing, search } = useEmailStore();
  const [authLoading, setAuthLoading] = React.useState(true);
  const [authUser, setAuthUser] = React.useState<TMailUser | null>(null);
  const [authError, setAuthError] = React.useState<string | null>(null);
  const [loginAddress, setLoginAddress] = React.useState("");
  const [challengeId, setChallengeId] = React.useState<string | null>(null);
  const [verificationCode, setVerificationCode] = React.useState("");
  const [expiresInSeconds, setExpiresInSeconds] = React.useState<number | null>(null);
  const [loginBusy, setLoginBusy] = React.useState(false);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [theme, setTheme] = React.useState<ThemeMode>(() => getInitialTheme());
  const [globalError, setGlobalError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const removeListener = api.addApiErrorListener((error) => {
      if (
        error.message.includes("502 Bad Gateway") ||
        error.message.includes("Unable to reach the origin service")
      ) {
        setGlobalError(error.message);
      }
    });
    return removeListener;
  }, []);

  const isLocalHost =
    typeof window !== "undefined" &&
    ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const canDevLogin =
    import.meta.env.DEV &&
    isLocalHost &&
    import.meta.env.VITE_DEV_BYPASS_AUTH === "true";
  const inTelegram = telegram.isAvailable();
  const hasTelegramAuthData = Boolean(telegram.getInitData());
  const allowStandaloneWeb = import.meta.env.VITE_ALLOW_STANDALONE_WEB === "true";
  const autoOpenTelegram = import.meta.env.VITE_AUTO_OPEN_TELEGRAM === "true";
  const rawBotUsername =
    (import.meta.env.VITE_TELEGRAM_BOT_USERNAME as string | undefined)?.trim() ||
    "tmail_osman_bot";
  const botUsername = rawBotUsername.replace(/^@/, "");
  const botOpenUrl = buildTelegramLaunchUrl(botUsername);
  const forceTelegramLaunch = !isLocalHost && !inTelegram && !allowStandaloneWeb;

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  React.useEffect(() => {
    if (!autoOpenTelegram || !forceTelegramLaunch || authLoading || authUser) {
      return;
    }

    const alreadyAttempted =
      window.sessionStorage.getItem(TELEGRAM_LAUNCH_ATTEMPT_KEY) === botOpenUrl;
    if (alreadyAttempted) {
      return;
    }

    const timer = window.setTimeout(() => {
      window.sessionStorage.setItem(TELEGRAM_LAUNCH_ATTEMPT_KEY, botOpenUrl);
      telegram.openExternal(botOpenUrl);
    }, 700);

    return () => window.clearTimeout(timer);
  }, [authLoading, authUser, autoOpenTelegram, botOpenUrl, forceTelegramLaunch]);

  const handleAuthSuccess = React.useCallback((payload: { user: TMailUser; sessionToken: string }) => {
    api.auth.setSessionToken(payload.sessionToken);
    setAuthUser(payload.user);
    setAuthError(null);
    setChallengeId(null);
    setVerificationCode("");
    setExpiresInSeconds(null);
  }, []);

  const loginWithTelegram = React.useCallback(async () => {
    setLoginBusy(true);
    setAuthError(null);

    try {
      telegram.init();
      telegram.enableClosingConfirmation();
      telegram.setHeaderColor("#EA4335");

      const initData = telegram.getInitData();
      if (!initData && !canDevLogin) {
        throw new Error(
          "Telegram opened T-Mail without secure Mini App auth data. Open it from the bot's Open T-Mail button.",
        );
      }

      const result = await api.auth.verify(initData);
      handleAuthSuccess(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Authentication failed";
      setAuthError(message);
      setAuthUser(null);
    } finally {
      setLoginBusy(false);
    }
  }, [canDevLogin, handleAuthSuccess]);

  const requestCode = React.useCallback(async () => {
    const tmailAddress = normalizeAddress(loginAddress);
    if (!tmailAddress) {
      setAuthError("Enter your T-Mail address first.");
      return;
    }

    setLoginBusy(true);
    setAuthError(null);

    try {
      const result = await api.auth.requestLoginCode(tmailAddress);
      setLoginAddress(tmailAddress);
      setChallengeId(result.challengeId);
      setExpiresInSeconds(result.expiresInSeconds);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to send code";
      setAuthError(message);
    } finally {
      setLoginBusy(false);
    }
  }, [loginAddress]);

  const verifyCode = React.useCallback(async () => {
    const tmailAddress = normalizeAddress(loginAddress);
    if (!challengeId) {
      setAuthError("Request a login code first.");
      return;
    }
    if (!/^\d{6}$/.test(verificationCode)) {
      setAuthError("Enter a valid 6-digit code.");
      return;
    }

    setLoginBusy(true);
    setAuthError(null);

    try {
      const result = await api.auth.verifyLoginCode(tmailAddress, challengeId, verificationCode);
      handleAuthSuccess(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Invalid verification code";
      setAuthError(message);
    } finally {
      setLoginBusy(false);
    }
  }, [challengeId, handleAuthSuccess, loginAddress, verificationCode]);

  const logout = React.useCallback(async () => {
    try {
      await api.user.logout("current");
    } catch (_error) {
      // Ignore transient logout errors on the client.
    }
    api.auth.clearSessionToken();
    setComposing(false);
    setAuthUser(null);
    setAuthError(null);
  }, [setComposing]);

  React.useEffect(() => {
    const bootstrapAuth = async () => {
      setAuthLoading(true);
      setAuthError(null);

      try {
        const existing = api.auth.getSessionToken();
        if (existing) {
          const me = await api.user.me();
          setAuthUser(me.user);
          return;
        }

        if (!forceTelegramLaunch && (hasTelegramAuthData || canDevLogin)) {
          telegram.init();
          telegram.enableClosingConfirmation();
          telegram.setHeaderColor("#EA4335");

          const initData = telegram.getInitData();
          const result = await api.auth.verify(initData);
          handleAuthSuccess(result);
          return;
        }
      } catch (error: any) {
        api.auth.clearSessionToken();
        setAuthUser(null);
        if (
          error instanceof Error &&
          (error.message.includes("502 Bad Gateway") ||
            error.message.includes("Unable to reach the origin service"))
        ) {
          setGlobalError(error.message);
        } else {
          setAuthError(error instanceof Error ? error.message : "Connection failed");
        }
      } finally {
        setAuthLoading(false);
      }
    };

    void bootstrapAuth();
  }, [canDevLogin, forceTelegramLaunch, handleAuthSuccess, hasTelegramAuthData]);

  if (authLoading) {
    return (
      <div className="app-loading-screen">
        <LoadingSpinner />
        <p>Connecting to T-Mail...</p>
      </div>
    );
  }

  if (globalError) {
    return (
      <div className="api-error-overlay">
        <div className="api-error-card">
          <div className="api-error-icon">⚠️</div>
          <h2>502 Bad Gateway</h2>
          <p>Unable to reach the origin service. The service may be down or it may not be responding to traffic from cloudflared.</p>
          <div className="api-error-instructions">
            To fix this, please open your Telegram bot and press <strong>/start</strong> again to wake up the server.
          </div>
          <div className="api-error-btn-group">
            <button
              type="button"
              className="auth-secondary"
              onClick={() => {
                setGlobalError(null);
                window.location.reload();
              }}
            >
              🔄 Retry
            </button>
            <button
              type="button"
              className="auth-primary"
              onClick={() => {
                telegram.openExternal(botOpenUrl);
              }}
            >
              💬 Open Telegram Bot
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!authUser) {
    return (
      <LoginView
        error={authError}
        inTelegram={inTelegram}
        canDevLogin={canDevLogin}
        forceTelegramLaunch={forceTelegramLaunch}
        loginAddress={loginAddress}
        setLoginAddress={setLoginAddress}
        code={verificationCode}
        setCode={setVerificationCode}
        challengeId={challengeId}
        expiresInSeconds={expiresInSeconds}
        busy={loginBusy}
        onTelegramLogin={() => void loginWithTelegram()}
        onRequestCode={() => void requestCode()}
        onVerifyCode={() => void verifyCode()}
        onResetCodeStep={() => {
          setChallengeId(null);
          setVerificationCode("");
          setExpiresInSeconds(null);
          setAuthError(null);
        }}
        onOpenTelegram={() => telegram.openExternal(botOpenUrl)}
        theme={theme}
        onToggleTheme={() => setTheme((value) => value === "dark" ? "light" : "dark")}
      />
    );
  }

  return (
    <div className="app-shell">
      {/* Sidebar backdrop overlay */}
      <div
        className={`sidebar-overlay ${sidebarOpen ? "open" : ""}`}
        onClick={() => setSidebarOpen(false)}
      />

      <Sidebar
        unreadCounts={unreadCounts}
        onCompose={() => setComposing(true)}
        user={authUser}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onLogout={() => void logout()}
      />

      <div className="app-main">
        <TopBar
          onSearch={(query) => void search(query)}
          user={authUser}
          onLogout={() => void logout()}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          theme={theme}
          onToggleTheme={() => setTheme((value) => value === "dark" ? "light" : "dark")}
        />

        <main className="app-content">
          <Routes>
            <Route path="/" element={<InboxPage />} />
            <Route path="/sent" element={<SentPage />} />
            <Route path="/drafts" element={<DraftsPage />} />
            <Route path="/trash" element={<TrashPage />} />
            <Route path="/starred" element={<StarredPage />} />
            <Route path="/spam" element={<SpamPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/assistant" element={<AssistantPage />} />
            <Route path="/email/:folder/:id" element={<EmailPage />} />
            <Route path="/compose" element={<ComposePage />} />
            <Route path="/settings" element={<SettingsPage user={authUser} onUserUpdate={setAuthUser} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>

      {/* Floating Action Button for mobile */}
      <button
        type="button"
        className="mobile-fab"
        onClick={() => setComposing(true)}
        aria-label="Compose new mail"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9"></path>
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
        </svg>
      </button>

      <ComposeModal user={authUser} />
    </div>
  );
}
