import { randomInt } from "crypto";
import { ConflictError } from "../errors";
import type { TMailUser } from "../types";
import { TelegramClient } from "../telegram/client";
import { getTMailDomain } from "./address";
import { normalizeStorageBytes } from "./storage-accounting";

const USER_PREFIX = "TMAIL_USER:";

type UserKey = string;

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export class MasterIndexService {
  private readonly usersByAddress = new Map<UserKey, TMailUser>();
  private readonly usersByTelegram = new Map<number, TMailUser>();
  private readonly addressKeysByTelegram = new Map<number, Set<UserKey>>();
  private onStateChange: (() => void) | null = null;

  constructor(
    private readonly telegramClient: TelegramClient,
    private readonly masterIndexChannelId: number,
  ) {}

  /** Wire a callback that fires after any user mutation (used to schedule snapshot saves). */
  setStateChangeCallback(fn: () => void): void {
    this.onStateChange = fn;
  }

  private normalizeUser(user: TMailUser): TMailUser {
    const primary = normalizeAddress(user.tmailAddress);

    return {
      ...user,
      tmailAddress: primary,
      storageUsed: normalizeStorageBytes(user.storageUsed),
    };
  }

  private getAddressKeys(user: TMailUser): Set<UserKey> {
    const normalized = this.normalizeUser(user);
    return new Set([normalized.tmailAddress].map(normalizeAddress));
  }

  private assertAddressesAvailable(user: TMailUser): void {
    for (const address of this.getAddressKeys(user)) {
      const owner = this.usersByAddress.get(address);
      if (owner && owner.telegramUserId !== user.telegramUserId) {
        throw new ConflictError(`Address ${address} is already taken`);
      }
    }
  }

  private renderUserMessage(user: TMailUser): string {
    return `${USER_PREFIX}${JSON.stringify(this.normalizeUser(user))}`;
  }

  private updateCaches(user: TMailUser): TMailUser {
    const normalized = this.normalizeUser(user);
    const previousKeys = this.addressKeysByTelegram.get(normalized.telegramUserId);
    if (previousKeys) {
      for (const key of previousKeys) {
        this.usersByAddress.delete(key);
      }
    }

    const nextKeys = this.getAddressKeys(normalized);
    for (const key of nextKeys) {
      this.usersByAddress.set(key, normalized);
    }

    this.usersByTelegram.set(normalized.telegramUserId, normalized);
    this.addressKeysByTelegram.set(normalized.telegramUserId, nextKeys);
    return normalized;
  }

  async registerUser(user: TMailUser): Promise<TMailUser> {
    const normalized = this.normalizeUser(user);
    this.assertAddressesAvailable(normalized);

    const posted = await this.telegramClient.postMessage(
      this.masterIndexChannelId,
      this.renderUserMessage(normalized),
    );

    const withMessage: TMailUser = { ...normalized, indexMessageId: posted.messageId };
    const cached = this.updateCaches(withMessage);
    await this.updateSummary();
    this.onStateChange?.();
    return cached;
  }

  lookupByAddress(tmailAddress: string): TMailUser | null {
    return this.usersByAddress.get(normalizeAddress(tmailAddress)) ?? null;
  }

  lookupByTelegramId(telegramUserId: number): TMailUser | null {
    return this.usersByTelegram.get(telegramUserId) ?? null;
  }

  async updateUser(tmailAddress: string, updates: Partial<TMailUser>): Promise<TMailUser> {
    const existing = this.lookupByAddress(tmailAddress);
    if (!existing) {
      throw new ConflictError(`User ${tmailAddress} was not found`);
    }

    const updated: TMailUser = this.normalizeUser({ ...existing, ...updates });
    this.assertAddressesAvailable(updated);
    if (existing.indexMessageId) {
      await this.telegramClient.editMessage(
        this.masterIndexChannelId,
        existing.indexMessageId,
        this.renderUserMessage(updated),
      );
    }

    const result = this.updateCaches(updated);
    this.onStateChange?.();
    return result;
  }

  async incrementStorageUsed(tmailAddress: string, additionalBytes: number): Promise<TMailUser> {
    const existing = this.lookupByAddress(tmailAddress);
    if (!existing) {
      throw new ConflictError(`User ${tmailAddress} was not found`);
    }

    const delta = normalizeStorageBytes(additionalBytes);
    if (delta === 0) {
      return existing;
    }

    return this.updateUser(existing.tmailAddress, {
      storageUsed: normalizeStorageBytes(existing.storageUsed) + delta,
    });
  }

  isAddressTaken(tmailAddress: string): boolean {
    return this.usersByAddress.has(normalizeAddress(tmailAddress));
  }

  async generateUniqueAddress(preferredUsername: string): Promise<string> {
    const normalized = preferredUsername
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, "")
      .replace(/^[_.-]+|[_.-]+$/g, "");

    const base = normalized.length > 0 ? normalized : "user";
    const domain = getTMailDomain();
    const direct = `${base}@${domain}`;
    if (!this.isAddressTaken(direct)) {
      return direct;
    }

    for (let i = 0; i < 1000; i += 1) {
      const suffix = randomInt(1000, 10000);
      const fallback = `${base}${suffix}@${domain}`;
      if (!this.isAddressTaken(fallback)) {
        return fallback;
      }
    }

    throw new ConflictError("Unable to generate unique address. Try a different username.");
  }

  searchUsers(query: string): Array<Pick<TMailUser, "tmailAddress" | "displayName">> {
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      return [];
    }

    const result: Array<Pick<TMailUser, "tmailAddress" | "displayName">> = [];

    for (const user of this.usersByTelegram.values()) {
      const addresses = [user.tmailAddress];
      const matchedAddress = addresses.find((address) => address.toLowerCase().includes(q));
      if (matchedAddress || user.displayName.toLowerCase().includes(q)) {
        result.push({
          tmailAddress: matchedAddress ?? user.tmailAddress,
          displayName: user.displayName,
        });
        if (result.length >= 20) {
          break;
        }
      }
    }

    return result;
  }

  listAllUsers(): TMailUser[] {
    return Array.from(this.usersByTelegram.values());
  }

  /**
   * Restore user state from a persisted snapshot.  Writes directly into the
   * internal caches without posting Telegram messages or firing the state-change
   * callback, so this is safe to call during startup before any request arrives.
   */
  rehydrateFromSnapshot(users: TMailUser[]): void {
    for (const user of users) {
      this.updateCaches(user);
    }
    if (users.length > 0) {
      console.log(`MasterIndex rehydrated: ${users.length} user(s).`);
    }
  }

  private async updateSummary(): Promise<void> {
    const total = this.usersByTelegram.size;
    const summary = `TMAIL_INDEX_SUMMARY users=${total} updatedAt=${Date.now()}`;
    await this.telegramClient.postMessage(this.masterIndexChannelId, summary);
  }
}
