import { StorageService } from "../services/storage";
import type { ExternalEmailAttachment } from "../services/external-email";
import type { TMailAttachment, TMailUser } from "../types";

export class AttachmentHandler {
  constructor(private readonly storageService: StorageService) {}

  async upload(
    user: TMailUser,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  ): Promise<TMailAttachment> {
    return this.storageService.uploadAttachment(user, file);
  }

  async uploadInbound(
    user: TMailUser,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  ): Promise<TMailAttachment> {
    return this.storageService.uploadAttachment(user, file, user.channels.inbox);
  }

  async getFileUrl(fileId: string): Promise<string> {
    return this.storageService.resolveFileUrl(fileId);
  }

  async readForExternalSend(attachment: TMailAttachment): Promise<ExternalEmailAttachment> {
    const content = await this.storageService.readAttachmentContent(attachment);
    return {
      filename: content.filename,
      content: content.buffer.toString("base64"),
      contentType: content.mimeType,
      size: content.size,
    };
  }

  async getLocalAttachmentForDownload(
    fileId: string,
    expires: string | string[] | undefined,
    sig: string | string[] | undefined,
  ): Promise<{ filePath: string; fileName: string; mimeType: string; size: number }> {
    return this.storageService.getLocalAttachmentForDownload(fileId, expires, sig);
  }
}
