import { create } from "zustand";
import { api } from "../api";
import type { EmailDraftInput, TMailEmail, TMailFolder } from "../types";

interface EmailStore {
  currentFolder: TMailFolder;
  emails: Record<TMailFolder, TMailEmail[]>;
  currentEmail: TMailEmail | null;
  unreadCounts: Record<TMailFolder, number>;
  isComposing: boolean;
  composeData: EmailDraftInput;
  searchQuery: string;
  searchResults: TMailEmail[];
  isLoading: boolean;
  fetchEmails: (folder: TMailFolder) => Promise<void>;
  openEmail: (email: TMailEmail) => void;
  markRead: (emailId: string) => Promise<void>;
  toggleStar: (emailId: string) => Promise<void>;
  deleteEmail: (emailId: string) => Promise<void>;
  sendEmail: (data: EmailDraftInput) => Promise<void>;
  saveDraft: (data: EmailDraftInput) => Promise<void>;
  search: (query: string) => Promise<void>;
  setFolder: (folder: TMailFolder) => void;
  setComposing: (open: boolean) => void;
  setComposeData: (data: Partial<EmailDraftInput>) => void;
}

const emptyDraft: EmailDraftInput = {
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  body: "",
  bodyHtml: "",
  attachments: [],
};

function recalcUnread(emails: Record<TMailFolder, TMailEmail[]>): Record<TMailFolder, number> {
  const folders: TMailFolder[] = ["inbox", "sent", "drafts", "trash", "starred"];
  const counts = {
    inbox: 0,
    sent: 0,
    drafts: 0,
    trash: 0,
    starred: 0,
  };

  for (const folder of folders) {
    counts[folder] = emails[folder].filter((email) => email.status === "unread").length;
  }

  return counts;
}

export const useEmailStore = create<EmailStore>((set, get) => ({
  currentFolder: "inbox",
  emails: {
    inbox: [],
    sent: [],
    drafts: [],
    trash: [],
    starred: [],
  },
  currentEmail: null,
  unreadCounts: {
    inbox: 0,
    sent: 0,
    drafts: 0,
    trash: 0,
    starred: 0,
  },
  isComposing: false,
  composeData: emptyDraft,
  searchQuery: "",
  searchResults: [],
  isLoading: false,

  async fetchEmails(folder) {
    set({ isLoading: true, currentFolder: folder });
    try {
      const { emails: items } = await api.emails.list(folder, 50, 0);
      set((state) => {
        const nextEmails = { ...state.emails, [folder]: items };
        nextEmails.starred = [
          ...nextEmails.inbox,
          ...nextEmails.sent,
          ...nextEmails.drafts,
          ...nextEmails.trash,
        ].filter((email) => email.starred);

        return {
          emails: nextEmails,
          unreadCounts: recalcUnread(nextEmails),
        };
      });
    } finally {
      set({ isLoading: false });
    }
  },

  openEmail(email) {
    set({ currentEmail: email });
  },

  async markRead(emailId) {
    const folder = get().currentFolder;
    await api.emails.update(folder, emailId, { status: "read" });
    set((state) => {
      const next = state.emails[folder].map((email) =>
        email.id === emailId ? { ...email, status: "read" } : email,
      );
      const all = { ...state.emails, [folder]: next };
      return { emails: all, unreadCounts: recalcUnread(all) };
    });
  },

  async toggleStar(emailId) {
    const folder = get().currentFolder;
    const target = get().emails[folder].find((e) => e.id === emailId);
    if (!target) {
      return;
    }

    await api.emails.update(folder, emailId, { starred: !target.starred });
    set((state) => {
      const nextFolder = state.emails[folder].map((email) =>
        email.id === emailId ? { ...email, starred: !email.starred } : email,
      );
      const all = { ...state.emails, [folder]: nextFolder };
      all.starred = [
        ...all.inbox,
        ...all.sent,
        ...all.drafts,
        ...all.trash,
      ].filter((email) => email.starred);
      return { emails: all };
    });
  },

  async deleteEmail(emailId) {
    const folder = get().currentFolder;
    await api.emails.delete(folder, emailId);
    set((state) => {
      const nextFolder = state.emails[folder].filter((email) => email.id !== emailId);
      const all = { ...state.emails, [folder]: nextFolder };
      return { emails: all, unreadCounts: recalcUnread(all) };
    });
  },

  async sendEmail(data) {
    await api.compose.send(data);
    set({
      isComposing: false,
      composeData: emptyDraft,
    });
    await get().fetchEmails("sent");
  },

  async saveDraft(data) {
    await api.compose.draft(data);
    set({
      isComposing: false,
      composeData: emptyDraft,
    });
    await get().fetchEmails("drafts");
  },

  async search(query) {
    set({ searchQuery: query });
    if (!query.trim()) {
      set({ searchResults: [] });
      return;
    }

    const { emails } = await api.emails.search(query);
    set({ searchResults: emails });
  },

  setFolder(folder) {
    set({ currentFolder: folder });
  },

  setComposing(open) {
    set({ isComposing: open });
  },

  setComposeData(data) {
    set((state) => ({ composeData: { ...state.composeData, ...data } }));
  },
}));
