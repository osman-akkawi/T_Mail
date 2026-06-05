import { promisify } from "util";
import zlib from "zlib";
import type { TelegramClient } from "../telegram/client";
import type { TMailUser } from "../types";
import type { AuthSession } from "./session-auth";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export interface SnapshotData {
  version: 2;
  savedAt: number;
  users: TMailUser[];
  sessions: AuthSession[];
}

/**
 * Persists a compact snapshot of users + active sessions to a single pinned
 * message in the master index Telegram channel.  On startup the snapshot is
 * read back via getChat (which always returns the pinned message), giving
 * instant rehydration without any external database.
 *
 * Encoding: JSON → gzip → base64 → prepend TMAIL_SNAPSHOT_V2: prefix.
 * Telegram message text limit is 4096 chars.  If the encoded snapshot exceeds
 * the limit, sessions are dropped first; if it still exceeds the limit the
 * save is skipped and a warning is logged.
 *
 * Saves are debounced (3 s) so rapid successive writes collapse into one
 * Telegram API call.
 */

const SNAPSHOT_PREFIX = "TMAIL_SNAPSHOT_V2:";
const MAX_TEXT_LENGTH = 4000; // Telegram limit is 4096; keep a safe margin
const DEBOUNCE_MS = 3_000;

export class SnapshotService {
  private snapshotMessageId: number | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingData: SnapshotData | null = null;

  constructor(
    private readonly telegramClient: TelegramClient,
    private readonly masterIndexChannelId: number,
  ) {}

  /**
   * Load snapshot from the pinned message in the master index channel.
   * Returns null if there is no snapshot or decoding fails (fresh start).
   */
  async load(): Promise<SnapshotData | null> {
    try {
      const chat = await this.telegramClient.getChat(this.masterIndexChannelId);
      const pinnedText = chat.pinnedMessage?.text;
      if (!pinnedText || !pinnedText.startsWith(SNAPSHOT_PREFIX)) {
        return null;
      }

      const base64 = pinnedText.slice(SNAPSHOT_PREFIX.length);
      const compressed = Buffer.from(base64, "base64");
      const decompressed = await gunzip(compressed);
      const parsed = JSON.parse(decompressed.toString("utf8")) as Partial<SnapshotData>;

      if (parsed.version !== 2 || !Array.isArray(parsed.users)) {
        console.warn("Snapshot version mismatch or corrupt — starting fresh.");
        return null;
      }

      this.snapshotMessageId = chat.pinnedMessage!.messageId;
      console.log(
        `Snapshot loaded: ${parsed.users.length} user(s), ` +
          `${parsed.sessions?.length ?? 0} session(s). ` +
          `Saved at ${new Date(parsed.savedAt ?? 0).toISOString()}.`,
      );

      return {
        version: 2,
        savedAt: parsed.savedAt ?? 0,
        users: parsed.users,
        sessions: parsed.sessions ?? [],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error ?? "unknown");
      console.warn(`Snapshot load failed (starting fresh): ${msg}`);
      return null;
    }
  }

  /**
   * Schedule a debounced save.  Multiple rapid calls within DEBOUNCE_MS are
   * collapsed into a single Telegram edit operation.
   */
  schedule(data: SnapshotData): void {
    this.pendingData = data;
    if (this.debounceTimer) {
      return; // existing timer will pick up the latest pendingData
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const toSave = this.pendingData;
      this.pendingData = null;
      if (toSave) {
        void this.persist(toSave);
      }
    }, DEBOUNCE_MS);
  }

  private async persist(data: SnapshotData): Promise<void> {
    try {
      const text = await this.encode(data);
      if (!text) {
        console.warn("Snapshot skipped: encoded size exceeds Telegram message limit.");
        return;
      }
      await this.write(text);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error ?? "unknown");
      console.warn(`Snapshot save failed: ${msg}`);
    }
  }

  private async encode(data: SnapshotData): Promise<string | null> {
    // Try full snapshot (users + sessions)
    const full = await this.compress(data);
    if (full.length <= MAX_TEXT_LENGTH) {
      return full;
    }

    // Retry with sessions stripped to fit within limit
    console.warn(
      `Snapshot too large (${full.length} chars). Retrying without sessions.`,
    );
    const reduced: SnapshotData = { ...data, sessions: [] };
    const withoutSessions = await this.compress(reduced);
    if (withoutSessions.length <= MAX_TEXT_LENGTH) {
      return withoutSessions;
    }

    return null; // cannot fit even without sessions
  }

  private async compress(data: SnapshotData): Promise<string> {
    const json = JSON.stringify(data);
    const compressed = await gzip(Buffer.from(json, "utf8"));
    return `${SNAPSHOT_PREFIX}${compressed.toString("base64")}`;
  }

  private async write(text: string): Promise<void> {
    // Try to edit the existing snapshot message first
    if (this.snapshotMessageId !== null) {
      try {
        await this.telegramClient.editPlainMessage(
          this.masterIndexChannelId,
          this.snapshotMessageId,
          text,
        );
        return;
      } catch (_error) {
        // Message may have been deleted — fall through to post a new one
        this.snapshotMessageId = null;
      }
    }

    // Post a new snapshot message and pin it
    const posted = await this.telegramClient.postPlainMessage(
      this.masterIndexChannelId,
      text,
    );
    this.snapshotMessageId = posted.messageId;

    try {
      await this.telegramClient.pinMessage(this.masterIndexChannelId, posted.messageId);
    } catch (pinError) {
      const msg = pinError instanceof Error ? pinError.message : String(pinError ?? "unknown");
      console.warn(`Snapshot pinning failed (snapshot is saved but not pinned): ${msg}`);
    }
  }
}
