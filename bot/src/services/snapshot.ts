import { promisify } from "util";
import zlib from "zlib";
import type { TelegramClient } from "../telegram/client";
import type { TMailUser } from "../types";
import type { MailboxSnapshot } from "./email";
import type { AuthSession } from "./session-auth";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export interface SnapshotData {
  version: 3;
  savedAt: number;
  users: TMailUser[];
  sessions: AuthSession[];
  mailboxes: MailboxSnapshot;
}

interface LegacySnapshotData {
  version: 2;
  savedAt: number;
  users: TMailUser[];
  sessions?: AuthSession[];
}

interface SnapshotPointer {
  version: 3;
  savedAt: number;
  fileId: string;
}

const LEGACY_SNAPSHOT_PREFIX = "TMAIL_SNAPSHOT_V2:";
const SNAPSHOT_FILE_PREFIX = "TMAIL_SNAPSHOT_V3:";
const MAX_TEXT_LENGTH = 4000;
const DEBOUNCE_MS = 3_000;

export class SnapshotService {
  private snapshotMessageId: number | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingData: SnapshotData | null = null;

  constructor(
    private readonly telegramClient: TelegramClient,
    private readonly masterIndexChannelId: number,
  ) {}

  async load(): Promise<SnapshotData | null> {
    try {
      const chat = await this.telegramClient.getChat(this.masterIndexChannelId);
      const pinnedText = chat.pinnedMessage?.text;
      if (!pinnedText) {
        return null;
      }

      this.snapshotMessageId = chat.pinnedMessage!.messageId;

      if (pinnedText.startsWith(SNAPSHOT_FILE_PREFIX)) {
        return await this.loadFileSnapshot(pinnedText);
      }

      if (pinnedText.startsWith(LEGACY_SNAPSHOT_PREFIX)) {
        return await this.loadLegacyTextSnapshot(pinnedText);
      }

      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "unknown");
      console.warn(`Snapshot load failed (starting fresh): ${message}`);
      return null;
    }
  }

  schedule(data: SnapshotData): void {
    this.pendingData = data;
    if (this.debounceTimer) {
      return;
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

  private async loadLegacyTextSnapshot(pinnedText: string): Promise<SnapshotData | null> {
    const base64 = pinnedText.slice(LEGACY_SNAPSHOT_PREFIX.length);
    const compressed = Buffer.from(base64, "base64");
    const decompressed = await gunzip(compressed);
    const parsed = JSON.parse(decompressed.toString("utf8")) as Partial<LegacySnapshotData>;

    if (parsed.version !== 2 || !Array.isArray(parsed.users)) {
      console.warn("Snapshot version mismatch or corrupt - starting fresh.");
      return null;
    }

    console.log(
      `Legacy snapshot loaded: ${parsed.users.length} user(s), ` +
        `${parsed.sessions?.length ?? 0} session(s). ` +
        `Saved at ${new Date(parsed.savedAt ?? 0).toISOString()}.`,
    );

    return {
      version: 3,
      savedAt: parsed.savedAt ?? 0,
      users: parsed.users,
      sessions: parsed.sessions ?? [],
      mailboxes: {},
    };
  }

  private async loadFileSnapshot(pinnedText: string): Promise<SnapshotData | null> {
    const pointer = JSON.parse(pinnedText.slice(SNAPSHOT_FILE_PREFIX.length)) as Partial<SnapshotPointer>;
    if (pointer.version !== 3 || !pointer.fileId) {
      console.warn("Snapshot pointer is corrupt - starting fresh.");
      return null;
    }

    const fileUrl = await this.telegramClient.getFileUrl(pointer.fileId);
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Snapshot file download failed: HTTP ${response.status}`);
    }

    const compressed = Buffer.from(await response.arrayBuffer());
    const decompressed = await gunzip(compressed);
    const parsed = JSON.parse(decompressed.toString("utf8")) as Partial<SnapshotData>;

    if (parsed.version !== 3 || !Array.isArray(parsed.users)) {
      console.warn("Snapshot file version mismatch or corrupt - starting fresh.");
      return null;
    }

    console.log(
      `Snapshot loaded: ${parsed.users.length} user(s), ` +
        `${parsed.sessions?.length ?? 0} session(s), ` +
        `${this.countMailboxEmails(parsed.mailboxes)} email(s). ` +
        `Saved at ${new Date(parsed.savedAt ?? pointer.savedAt ?? 0).toISOString()}.`,
    );

    return {
      version: 3,
      savedAt: parsed.savedAt ?? pointer.savedAt ?? 0,
      users: parsed.users,
      sessions: parsed.sessions ?? [],
      mailboxes: parsed.mailboxes ?? {},
    };
  }

  private async persist(data: SnapshotData): Promise<void> {
    try {
      const compressed = await this.compressToBuffer(data);
      const uploaded = await this.telegramClient.uploadFile(
        this.masterIndexChannelId,
        compressed,
        `tmail-snapshot-${data.savedAt}.json.gz`,
        "application/gzip",
      );
      const text = this.encodePointer({
        version: 3,
        savedAt: data.savedAt,
        fileId: uploaded.fileId,
      });

      if (text.length > MAX_TEXT_LENGTH) {
        console.warn("Snapshot skipped: pointer size exceeds Telegram message limit.");
        return;
      }

      await this.write(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "unknown");
      console.warn(`Snapshot save failed: ${message}`);
    }
  }

  private encodePointer(pointer: SnapshotPointer): string {
    return `${SNAPSHOT_FILE_PREFIX}${JSON.stringify(pointer)}`;
  }

  private async compressToBuffer(data: SnapshotData): Promise<Buffer> {
    const json = JSON.stringify(data);
    return gzip(Buffer.from(json, "utf8"));
  }

  private countMailboxEmails(mailboxes: MailboxSnapshot | undefined): number {
    if (!mailboxes) {
      return 0;
    }

    let count = 0;
    for (const folders of Object.values(mailboxes)) {
      for (const emails of Object.values(folders)) {
        if (Array.isArray(emails)) {
          count += emails.length;
        }
      }
    }
    return count;
  }

  private async write(text: string): Promise<void> {
    if (this.snapshotMessageId !== null) {
      try {
        await this.telegramClient.editPlainMessage(
          this.masterIndexChannelId,
          this.snapshotMessageId,
          text,
        );
        return;
      } catch (_error) {
        this.snapshotMessageId = null;
      }
    }

    const posted = await this.telegramClient.postPlainMessage(
      this.masterIndexChannelId,
      text,
    );
    this.snapshotMessageId = posted.messageId;

    try {
      await this.telegramClient.pinMessage(this.masterIndexChannelId, posted.messageId);
    } catch (pinError) {
      const message = pinError instanceof Error ? pinError.message : String(pinError ?? "unknown");
      console.warn(`Snapshot pinning failed (snapshot is saved but not pinned): ${message}`);
    }
  }
}
