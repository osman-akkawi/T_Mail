import React from "react";
import { useEmailStore } from "../store/emailStore";

export function useSearch() {
  const { search, searchResults, searchQuery } = useEmailStore();
  const [query, setQuery] = React.useState(searchQuery);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      void search(query);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, search]);

  return { query, setQuery, searchResults };
}
