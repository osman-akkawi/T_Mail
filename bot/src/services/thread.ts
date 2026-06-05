import { randomUUID } from "crypto";
import type { TMailEmail, TMailThread } from "../types";

export class ThreadService {
  createThreadId(): string {
    return randomUUID();
  }

  collectThreads(emails: TMailEmail[]): TMailThread[] {
    const grouped = new Map<string, TMailEmail[]>();

    for (const email of emails) {
      const list = grouped.get(email.threadId) ?? [];
      list.push(email);
      grouped.set(email.threadId, list);
    }

    const threads: TMailThread[] = [];

    for (const [threadId, threadEmails] of grouped) {
      const sorted = [...threadEmails].sort((a, b) => a.date - b.date);
      const participantsSet = new Set<string>();
      let unreadCount = 0;

      for (const email of sorted) {
        participantsSet.add(email.from);
        email.to.forEach((to) => participantsSet.add(to));
        if (email.status === "unread") {
          unreadCount += 1;
        }
      }

      const last = sorted[sorted.length - 1];
      threads.push({
        threadId,
        subject: last?.subject ?? "(no subject)",
        participants: Array.from(participantsSet.values()),
        emails: sorted,
        lastDate: last?.date ?? 0,
        unreadCount,
      });
    }

    return threads.sort((a, b) => b.lastDate - a.lastDate);
  }
}
