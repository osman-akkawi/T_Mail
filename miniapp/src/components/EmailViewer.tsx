import React from "react";
import { AttachmentList } from "./AttachmentList";
import type { TMailEmail } from "../types";
import { Avatar } from "./Avatar";

interface EmailViewerProps {
  email: TMailEmail;
  thread: TMailEmail[];
  folder: string;
  onReply: () => void;
  onDelete: () => void;
  onToggleStar: () => void;
  onSpam: () => void;
  onNotSpam: () => void;
}

export function EmailViewer({ email, thread, folder, onReply, onDelete, onToggleStar, onSpam, onNotSpam }: EmailViewerProps) {
  const uniqueThread = React.useMemo(() => {
    const seen = new Set<string>();
    return thread.filter((item) => {
      const key = `${item.id}:${item.telegramMessageId}:${item.date}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }, [thread]);

  return (
    <article className="email-viewer">
      <header className="email-viewer-header">
        <h2>{email.subject || "(no subject)"}</h2>

        <div className="email-viewer-meta">
          <Avatar name={email.from} size={36} />
          <div className="email-viewer-meta-text">
            <div className="email-viewer-from">{email.from}</div>
            <div className="email-viewer-date">{new Date(email.date).toLocaleString()}</div>
            <div className="email-viewer-to">to {email.to.join(", ") || "(no recipients)"}</div>
          </div>
        </div>
      </header>

      <div className="email-viewer-actions">
        <button type="button" className="viewer-action primary" onClick={onReply}>Reply</button>
        <button type="button" className="viewer-action" onClick={onToggleStar}>{email.starred ? "Unstar" : "Star"}</button>
        {folder !== "spam" && (
          <button type="button" className="viewer-action warning" onClick={onSpam}>🚫 Spam</button>
        )}
        {folder === "spam" && (
          <button type="button" className="viewer-action" onClick={onNotSpam}>✅ Not Spam</button>
        )}
        <button type="button" className="viewer-action danger" onClick={onDelete}>Delete</button>
      </div>

      <div className="email-viewer-body">{email.bodyHtml || email.body}</div>
      <AttachmentList attachments={email.attachments} />

      {uniqueThread.length > 1 && (
        <section className="thread-list">
          <h3>Conversation</h3>
          {uniqueThread.map((item, index) => (
            <div key={`${item.id}-${item.telegramMessageId}-${index}`} className="thread-item">
              <strong>{item.from}</strong>
              <span>{new Date(item.date).toLocaleString()}</span>
              <p>{item.body.slice(0, 180)}</p>
            </div>
          ))}
        </section>
      )}
    </article>
  );
}
