import React from "react";
import { useNavigate } from "react-router-dom";
import { FileUpload } from "./FileUpload";
import { useEmailStore } from "../store/emailStore";
import type { EmailDraftInput, TMailUser } from "../types";

interface ComposeModalProps {
  user: TMailUser;
}

export function ComposeModal({ user }: ComposeModalProps) {
  const navigate = useNavigate();
  const {
    isComposing,
    composeData,
    setComposing,
    setComposeData,
    sendEmail,
    saveDraft,
  } = useEmailStore();

  const [showCc, setShowCc] = React.useState(false);
  const [showBcc, setShowBcc] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [attachmentsUploading, setAttachmentsUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (isComposing && !composeData.from) {
      setComposeData({ from: user.tmailAddress });
    }
  }, [composeData.from, isComposing, setComposeData, user.tmailAddress]);

  if (!isComposing) {
    return null;
  }

  const parseAddressList = (value: string) => {
    return value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  };

  const onSend = async () => {
    if (attachmentsUploading) {
      setError("Please wait until attachment upload finishes.");
      return;
    }

    setSending(true);
    setError(null);
    try {
      await sendEmail(composeData);
      navigate("/");
    } catch (sendError: unknown) {
      const message = sendError instanceof Error ? sendError.message : "Failed to send email";
      setError(message);
    } finally {
      setSending(false);
    }
  };

  const onSaveDraft = async () => {
    if (attachmentsUploading) {
      setError("Please wait until attachment upload finishes.");
      return;
    }

    setError(null);
    try {
      await saveDraft(composeData);
      navigate("/drafts");
    } catch (draftError: unknown) {
      const message = draftError instanceof Error ? draftError.message : "Failed to save draft";
      setError(message);
    }
  };

  const onDiscard = async () => {
    const ok = window.confirm("Discard this draft?");
    if (!ok) {
      return;
    }
    setComposeData({
      from: user.tmailAddress,
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      body: "",
      bodyHtml: "",
      attachments: [],
    } satisfies Partial<EmailDraftInput>);
    setComposing(false);
  };

  return (
    <div
      className="compose-overlay"
      onClick={() => {
        if (!sending && !attachmentsUploading) {
          setComposing(false);
        }
      }}
    >
      <div className="compose-modal" onClick={(event) => event.stopPropagation()}>
        <div className="compose-header">
          <h3>New Message</h3>
          <button
            type="button"
            className="compose-close"
            onClick={() => setComposing(false)}
            disabled={sending || attachmentsUploading}
          >
            ×
          </button>
        </div>

        <div className="compose-fields">
          {error && <div className="compose-error">{error}</div>}
          <div className="compose-from-line">
            <span>From:</span>
            <strong>{user.tmailAddress}</strong>
          </div>
          <input
            placeholder="To"
            value={composeData.to.join(", ")}
            onChange={(event) => setComposeData({ to: parseAddressList(event.target.value) })}
          />
          <div className="compose-cc-row">
            <button type="button" onClick={() => setShowCc((v) => !v)}>CC</button>
            <button type="button" onClick={() => setShowBcc((v) => !v)}>BCC</button>
          </div>

          {showCc && (
            <input
              placeholder="CC"
              value={composeData.cc.join(", ")}
              onChange={(event) => setComposeData({ cc: parseAddressList(event.target.value) })}
            />
          )}

          {showBcc && (
            <input
              placeholder="BCC"
              value={composeData.bcc.join(", ")}
              onChange={(event) => setComposeData({ bcc: parseAddressList(event.target.value) })}
            />
          )}

          <input
            placeholder="Subject"
            value={composeData.subject}
            onChange={(event) => setComposeData({ subject: event.target.value })}
          />

          <textarea
            placeholder="Write your email"
            value={composeData.body}
            onChange={(event) =>
              setComposeData({ body: event.target.value, bodyHtml: event.target.value })
            }
          />

          <FileUpload
            attachments={composeData.attachments}
            onChange={(attachments) => setComposeData({ attachments })}
            onUploadingChange={setAttachmentsUploading}
            disabled={sending}
          />
        </div>

        <div className="compose-actions">
          <button
            type="button"
            className="primary"
            onClick={onSend}
            disabled={sending || attachmentsUploading}
          >
            {sending ? "Sending..." : attachmentsUploading ? "Uploading files..." : "Send"}
          </button>
          <button type="button" onClick={onSaveDraft} disabled={attachmentsUploading}>
            Save Draft
          </button>
          <button type="button" onClick={onDiscard} disabled={sending || attachmentsUploading}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
