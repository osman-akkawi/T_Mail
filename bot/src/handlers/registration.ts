import type { TMailUser } from "../types";
import { ConflictError } from "../errors";
import { MasterIndexService } from "../services/index";

function makeDisplayName(firstName: string, lastName?: string): string {
  return `${firstName}${lastName ? ` ${lastName}` : ""}`.trim();
}

export class RegistrationHandler {
  constructor(private readonly indexService: MasterIndexService) {}

  async registerUser(params: {
    telegramUserId: number;
    telegramUsername?: string;
    firstName: string;
    lastName?: string;
    preferredAddress?: string;
  }): Promise<TMailUser> {
    const existing = this.indexService.lookupByTelegramId(params.telegramUserId);
    if (existing) {
      return existing;
    }

    const preferred = params.preferredAddress?.trim().toLowerCase();
    let address: string;

    if (preferred && preferred.length > 0) {
      if (this.indexService.isAddressTaken(preferred)) {
        throw new ConflictError(`Address ${preferred} is already taken`);
      }
      address = preferred;
    } else {
      const usernameSeed = params.telegramUsername ?? params.firstName;
      address = await this.indexService.generateUniqueAddress(usernameSeed);
    }

    const user: TMailUser = {
      telegramUserId: params.telegramUserId,
      telegramUsername: params.telegramUsername ?? "",
      tmailAddress: address,
      displayName: makeDisplayName(params.firstName, params.lastName),
      channels: {
        inbox: params.telegramUserId,
        sent: params.telegramUserId,
        drafts: params.telegramUserId,
        trash: params.telegramUserId,
      },
      createdAt: Date.now(),
      plan: "free",
      storageUsed: 0,
    };

    return this.indexService.registerUser(user);
  }
}
