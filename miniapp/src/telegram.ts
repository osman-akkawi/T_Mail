import type { TelegramMiniUser } from "./types";

type HapticType = "light" | "medium" | "heavy";

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { user?: TelegramMiniUser };
  ready(): void;
  expand(): void;
  close(): void;
  openLink(url: string): void;
  showAlert(message: string): void;
  showConfirm(message: string, callback?: (ok: boolean) => void): void;
  setHeaderColor(color: string): void;
  enableClosingConfirmation(): void;
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy"): void;
  };
}

interface TelegramWindow {
  Telegram?: {
    WebApp?: TelegramWebApp;
  };
}

const getApp = (): TelegramWebApp | null => {
  const tgWindow = window as unknown as TelegramWindow;
  return tgWindow.Telegram?.WebApp ?? null;
};

export const telegram = {
  isAvailable(): boolean {
    return Boolean(getApp());
  },
  init(): void {
    const app = getApp();
    app?.ready();
    app?.expand();
  },
  getInitData(): string {
    return getApp()?.initData ?? "";
  },
  getUser(): TelegramMiniUser | null {
    return getApp()?.initDataUnsafe?.user ?? null;
  },
  close(): void {
    getApp()?.close();
  },
  showAlert(message: string): void {
    const app = getApp();
    if (app) {
      app.showAlert(message);
      return;
    }
    window.alert(message);
  },
  showConfirm(message: string): Promise<boolean> {
    const app = getApp();
    if (!app) {
      return Promise.resolve(window.confirm(message));
    }

    return new Promise((resolve) => {
      app.showConfirm(message, (ok) => resolve(ok));
    });
  },
  setHeaderColor(color: string): void {
    getApp()?.setHeaderColor(color);
  },
  enableClosingConfirmation(): void {
    getApp()?.enableClosingConfirmation();
  },
  hapticFeedback(type: HapticType): void {
    getApp()?.HapticFeedback?.impactOccurred(type);
  },
  openLink(url: string): void {
    const app = getApp();
    if (app) {
      app.openLink(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  },
  openExternal(url: string): void {
    const app = getApp();
    if (app) {
      app.openLink(url);
      return;
    }
    window.location.assign(url);
  },
};
