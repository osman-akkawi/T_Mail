import React, { useMemo } from "react";
import { EmailRow } from "./EmailRow";
import { EmptyState } from "./EmptyState";
import type { TMailEmail } from "../types";

interface EmailListProps {
  emails: TMailEmail[];
  folder: string;
  loading: boolean;
  selected: Set<string>;
  onCheck: (id: string, checked: boolean) => void;
  onToggleStar: (id: string) => void;
  emptyIcon?: string;
  emptyTitle?: string;
  emptyDescription?: string;
}

function sectionName(ts: number): string {
  const now = new Date();
  const date = new Date(ts);
  const dayDiff = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return "This Week";
  if (dayDiff < 30) return "This Month";
  return "Older";
}

export function EmailList({
  emails,
  folder,
  loading,
  selected,
  onCheck,
  onToggleStar,
  emptyIcon = "📭",
  emptyTitle = "No emails yet",
  emptyDescription = "Your mailbox is empty.",
}: EmailListProps) {
  const groups = useMemo(() => {
    const result = new Map<string, TMailEmail[]>();
    for (const email of emails) {
      const section = sectionName(email.date);
      const current = result.get(section) ?? [];
      current.push(email);
      result.set(section, current);
    }
    return result;
  }, [emails]);

  if (loading) {
    return (
      <div className="email-list-loading">
        {Array.from({ length: 7 }).map((_, index) => (
          <div key={index} className="email-skeleton-row" style={{ opacity: 1 - index * 0.1 }} />
        ))}
      </div>
    );
  }

  if (emails.length === 0) {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }

  return (
    <div className={`email-list folder-${folder}`}>
      {Array.from(groups.entries()).map(([section, sectionEmails]) => (
        <section key={section}>
          <h4 className="email-group-title">{section}</h4>
          {sectionEmails.map((email) => (
            <EmailRow
              key={email.id}
              email={email}
              folder={folder}
              checked={selected.has(email.id)}
              onCheck={onCheck}
              onToggleStar={onToggleStar}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
