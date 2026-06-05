import React from "react";
import { useEmailStore } from "../store/emailStore";

export default function ComposePage() {
  const { setComposing } = useEmailStore();

  React.useEffect(() => {
    setComposing(true);
    return () => setComposing(false);
  }, [setComposing]);

  return (
    <section className="page">
      <h1>Compose</h1>
      <p>Use the compose window in the lower right corner.</p>
    </section>
  );
}
