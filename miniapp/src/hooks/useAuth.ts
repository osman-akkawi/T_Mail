import React from "react";
import { api } from "../api";
import { telegram } from "../telegram";
import type { TMailUser } from "../types";

export function useAuth() {
  const [user, setUser] = React.useState<TMailUser | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    telegram.init();
    telegram.enableClosingConfirmation();
    telegram.setHeaderColor("#EA4335");

    const initData = telegram.getInitData();
    void api.auth.verify(initData)
      .then((result) => setUser(result.user))
      .finally(() => setLoading(false));
  }, []);

  return { user, loading };
}
