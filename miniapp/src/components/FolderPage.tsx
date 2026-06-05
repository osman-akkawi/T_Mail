import React from "react";
import { EmailList } from "./EmailList";
import { useEmailStore } from "../store/emailStore";
import type { TMailFolder } from "../types";

interface FolderPageProps {
  folder: TMailFolder;
  title: string;
}

const folderIcons: Record<TMailFolder, string> = {
  inbox:   "📥",
  sent:    "📤",
  drafts:  "📝",
  starred: "⭐",
  trash:   "🗑",
  spam:    "🚫",
};

const folderEmptyIcons: Record<TMailFolder, string> = {
  inbox:   "📭",
  sent:    "📤",
  drafts:  "📄",
  starred: "⭐",
  trash:   "🗑",
  spam:    "✅",
};

const folderEmptyMessages: Record<TMailFolder, { title: string; description: string }> = {
  inbox:   { title: "Inbox is clear",       description: "You're all caught up! New messages will appear here." },
  sent:    { title: "No sent messages",      description: "Emails you send will show up here." },
  drafts:  { title: "No drafts saved",       description: "Start composing and save a draft to find it here." },
  starred: { title: "No starred messages",   description: "Star important emails to find them quickly." },
  trash:   { title: "Trash is empty",        description: "Deleted emails will appear here before being removed." },
  spam:    { title: "No spam — great!",      description: "Emails you report as spam will be kept here." },
};

export function FolderPage({ folder, title }: FolderPageProps) {
  const {
    emails,
    currentFolder,
    fetchEmails,
    setFolder,
    isLoading,
    markRead,
    toggleStar,
    deleteEmail,
    moveToSpam,
    markNotSpam,
  } = useEmailStore();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    setFolder(folder);
    void fetchEmails(folder);
  }, [fetchEmails, folder, setFolder]);

  const selectedIds = Array.from(selected);

  const onBulkMarkRead = async () => {
    for (const id of selectedIds) {
      await markRead(id);
    }
    setSelected(new Set());
  };

  const onBulkDelete = async () => {
    for (const id of selectedIds) {
      await deleteEmail(id);
    }
    setSelected(new Set());
  };

  const onBulkSpam = async () => {
    for (const id of selectedIds) {
      await moveToSpam(id);
    }
    setSelected(new Set());
  };

  const onBulkNotSpam = async () => {
    for (const id of selectedIds) {
      markNotSpam(id);
    }
    setSelected(new Set());
  };

  const empty = folderEmptyMessages[folder];

  return (
    <section className={`page folder-page folder-${folder}`}>
      <div className="page-header">
        <h1>
          <span className="page-title-icon" aria-hidden="true">{folderIcons[folder]}</span>
          {title}
        </h1>
        {selected.size > 0 && (
          <div className="bulk-actions">
            <button type="button" onClick={() => void onBulkMarkRead()}>✓ Mark read</button>
            {folder !== "spam" && (
              <button type="button" onClick={() => void onBulkSpam()}>🚫 Spam</button>
            )}
            {folder === "spam" && (
              <button type="button" onClick={() => void onBulkNotSpam()}>✅ Not spam</button>
            )}
            <button type="button" onClick={() => void onBulkDelete()}>🗑 Delete</button>
          </div>
        )}
      </div>

      <EmailList
        emails={emails[currentFolder]}
        folder={folder}
        loading={isLoading}
        selected={selected}
        emptyIcon={folderEmptyIcons[folder]}
        emptyTitle={empty.title}
        emptyDescription={empty.description}
        onCheck={(id, checked) => {
          const next = new Set(selected);
          if (checked) {
            next.add(id);
          } else {
            next.delete(id);
          }
          setSelected(next);
        }}
        onToggleStar={(id) => void toggleStar(id)}
      />
    </section>
  );
}
