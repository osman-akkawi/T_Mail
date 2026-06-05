import React from "react";
import { useNavigate } from "react-router-dom";
import { Avatar } from "./Avatar";
import type { TMailEmail } from "../types";

interface EmailRowProps {
  email: TMailEmail;
  folder: string;
  checked: boolean;
  onCheck: (id: string, checked: boolean) => void;
  onToggleStar: (id: string) => void;
}

function formatRowDate(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  const sameYear = date.getFullYear() === now.getFullYear();
  if (sameYear) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" });
}

function senderLabel(address: string): string {
  const [name] = address.split("@");
  return name || address;
}

export function EmailRow({ email, folder, checked, onCheck, onToggleStar }: EmailRowProps) {
  const navigate = useNavigate();
  const unread = email.status === "unread";
  const sent = folder === "sent";

  return (
    <div
      className={`email-row ${unread ? "email-row-unread" : "email-row-read"}`}
      onClick={() => navigate(`/email/${folder}/${email.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          navigate(`/email/${folder}/${email.id}`);
        }
      }}
    >
      {/* Checkbox */}
      <input
        className="email-row-checkbox"
        type="checkbox"
        checked={checked}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onCheck(email.id, event.target.checked)}
        aria-label="Select email"
      />

      {/* Star */}
      <button
        type="button"
        className={`email-row-star ${email.starred ? "starred" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          onToggleStar(email.id);
        }}
        aria-label={email.starred ? "Unstar" : "Star"}
      >
        {email.starred ? "★" : "☆"}
      </button>

      {/* Avatar */}
      <Avatar name={sent ? (email.to[0] ?? "?") : email.from} size={34} />

      {/* Content */}
      <div className="email-row-content">
        <div className="email-row-sender">
          {sent ? `To: ${email.to.join(", ") || "unknown"}` : senderLabel(email.from)}
        </div>
        <div className="email-row-line">
          <span className="email-row-subject">{email.subject || "(no subject)"}</span>
          <span className="email-row-divider">·</span>
          <span className="email-row-preview">{email.body.slice(0, 100)}</span>
        </div>
      </div>

      {/* Unread dot + date */}
      <div className="email-row-trailing">
        {unread && <span className="unread-dot" aria-hidden="true" />}
        <div className="email-row-date">{formatRowDate(email.date)}</div>
      </div>
    </div>
  );
}
