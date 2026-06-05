import { useEffect } from "react";
import { useEmailStore } from "../store/emailStore";
import type { TMailFolder } from "../types";

export function useEmails(folder: TMailFolder) {
  const store = useEmailStore();

  useEffect(() => {
    void store.fetchEmails(folder);
  }, [folder, store]);

  return {
    emails: store.emails[folder],
    loading: store.isLoading,
  };
}
