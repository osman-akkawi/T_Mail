import React from "react";
import { api } from "../api";
import type { TMailAttachment } from "../types";

interface FileUploadProps {
  attachments: TMailAttachment[];
  onChange: (attachments: TMailAttachment[]) => void;
  onUploadingChange?: (uploading: boolean) => void;
  disabled?: boolean;
}

const MB = 1024 * 1024;
const MAX_ATTACHMENTS_PER_EMAIL = Math.max(
  1,
  Math.floor(Number(import.meta.env.VITE_MAX_ATTACHMENTS_PER_EMAIL ?? 10)),
);
const MAX_ATTACHMENT_SIZE_MB = Math.max(
  1,
  Math.floor(Number(import.meta.env.VITE_MAX_ATTACHMENT_SIZE_MB ?? 20)),
);
const MAX_ATTACHMENT_SIZE_BYTES = MAX_ATTACHMENT_SIZE_MB * MB;

export function FileUpload({
  attachments,
  onChange,
  onUploadingChange,
  disabled = false,
}: FileUploadProps) {
  const [uploading, setUploading] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);

  const setUploadingState = React.useCallback(
    (value: boolean) => {
      setUploading(value);
      onUploadingChange?.(value);
    },
    [onUploadingChange],
  );

  return (
    <div className="file-upload">
      <label className="file-upload-label" htmlFor="compose-file-input">
        Attach file
      </label>
      <input
        id="compose-file-input"
        type="file"
        multiple
        disabled={disabled || uploading}
        onChange={async (event) => {
          const selected = Array.from(event.target.files ?? []);
          if (selected.length === 0) {
            return;
          }

          const availableSlots = MAX_ATTACHMENTS_PER_EMAIL - attachments.length;
          if (availableSlots <= 0) {
            setError(`You can attach up to ${MAX_ATTACHMENTS_PER_EMAIL} files per email.`);
            event.target.value = "";
            return;
          }

          const queue = selected.slice(0, availableSlots);
          const skipped = selected.length - queue.length;
          const oversized = queue.filter((file) => file.size > MAX_ATTACHMENT_SIZE_BYTES);
          const allowed = queue.filter((file) => file.size <= MAX_ATTACHMENT_SIZE_BYTES);
          let infoMessage: string | null = null;

          if (allowed.length === 0) {
            if (oversized.length > 0) {
              setError(`Each file must be ${MAX_ATTACHMENT_SIZE_MB}MB or smaller.`);
            } else if (skipped > 0) {
              setError(`You can attach up to ${MAX_ATTACHMENTS_PER_EMAIL} files per email.`);
            }
            event.target.value = "";
            return;
          }

          if (oversized.length > 0) {
            infoMessage = `Some files were skipped because they exceed ${MAX_ATTACHMENT_SIZE_MB}MB.`;
          } else if (skipped > 0) {
            infoMessage = `Only ${availableSlots} more file(s) were added due to the ${MAX_ATTACHMENTS_PER_EMAIL}-file limit.`;
          }

          setUploadingState(true);
          setError(infoMessage);

          const nextAttachments = [...attachments];
          try {
            for (let index = 0; index < allowed.length; index += 1) {
              const file = allowed[index];
              setUploadProgress(`Uploading ${index + 1}/${allowed.length}: ${file.name}`);
              const uploaded = await api.attachments.upload(file);
              nextAttachments.push(uploaded.attachment);
              onChange([...nextAttachments]);
            }
          } catch (uploadError: unknown) {
            const message =
              uploadError instanceof Error ? uploadError.message : "Upload failed";
            setError(message);
          } finally {
            setUploadProgress("");
            setUploadingState(false);
            event.target.value = "";
          }
        }}
      />
      <div className="file-upload-hint">
        Max {MAX_ATTACHMENTS_PER_EMAIL} files, {MAX_ATTACHMENT_SIZE_MB}MB each.
      </div>
      {uploading && <div className="file-upload-progress">{uploadProgress || "Uploading..."}</div>}
      {error && <div className="file-upload-error">{error}</div>}
      <div className="file-upload-items">
        {attachments.map((item) => (
          <span key={item.fileId} className="attachment-pill">
            {item.name}
          </span>
        ))}
      </div>
    </div>
  );
}
