import React from "react";
import type { TMailAttachment } from "../types";
import { api } from "../api";

interface AttachmentListProps {
  attachments: TMailAttachment[];
}

export function AttachmentList({ attachments }: AttachmentListProps) {
  if (!attachments.length) {
    return null;
  }

  return (
    <div className="attachments">
      <h4>Attachments</h4>
      <ul>
        {attachments.map((attachment) => (
          <li key={attachment.fileId}>
            <button
              type="button"
              onClick={async () => {
                const { url } = await api.attachments.getUrl(attachment.fileId);
                window.open(url, "_blank", "noopener,noreferrer");
              }}
            >
              {attachment.name} ({Math.ceil(attachment.size / 1024)} KB)
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
