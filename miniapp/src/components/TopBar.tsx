import React from "react";
import { useNavigate } from "react-router-dom";
import type { TMailUser } from "../types";
import { Avatar } from "./Avatar";

interface TopBarProps {
  onSearch: (query: string) => void;
  user: TMailUser;
  onLogout: () => void;
  onToggleSidebar: () => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

export function TopBar({
  onSearch,
  user,
  onLogout,
  onToggleSidebar,
  theme,
  onToggleTheme,
}: TopBarProps) {
  const navigate = useNavigate();
  const [value, setValue] = React.useState("");

  return (
    <header className="tmail-topbar">
      <button
        type="button"
        className="sidebar-toggle-btn"
        onClick={onToggleSidebar}
        aria-label="Open menu"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="12" x2="21" y2="12"></line>
          <line x1="3" y1="6" x2="21" y2="6"></line>
          <line x1="3" y1="18" x2="21" y2="18"></line>
        </svg>
      </button>

      <div className="brand">
        <span className="brand-logo" aria-hidden="true">✉</span>
        <span className="brand-name">T-Mail</span>
      </div>

      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch(value);
          navigate(`/search?q=${encodeURIComponent(value)}`);
        }}
      >
        <div className="search-input-wrap">
          <span className="search-input-icon" aria-hidden="true">🔍</span>
          <input
            placeholder="Search mail…"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label="Search mail"
          />
          <button type="submit" className="search-submit-btn" aria-label="Run search">
            Search
          </button>
        </div>
      </form>

      <div className="topbar-actions">
        <button
          type="button"
          className="theme-toggle-btn"
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? "Light" : "Dark"}
        </button>

        <button
          type="button"
          className="topbar-profile"
          onClick={() => navigate("/settings")}
          aria-label="Account settings"
        >
          <Avatar name={user.displayName} size={30} />
          <div className="topbar-profile-meta">
            <span>{user.displayName}</span>
            <span>{user.tmailAddress}</span>
          </div>
        </button>

        <button type="button" className="logout-btn" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </header>
  );
}
