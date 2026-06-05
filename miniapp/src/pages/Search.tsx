import React from "react";
import { useSearchParams } from "react-router-dom";
import { EmailList } from "../components/EmailList";
import { useEmailStore } from "../store/emailStore";

export default function SearchPage() {
  const [params] = useSearchParams();
  const query = params.get("q") ?? "";
  const { searchResults, search } = useEmailStore();

  React.useEffect(() => {
    void search(query);
  }, [query, search]);

  return (
    <section className="page">
      <h1>Search</h1>
      <EmailList
        emails={searchResults}
        folder="inbox"
        loading={false}
        selected={new Set()}
        onCheck={() => undefined}
        onToggleStar={() => undefined}
      />
    </section>
  );
}
