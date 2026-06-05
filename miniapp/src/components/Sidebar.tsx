import React from "react";
import { NavLink } from "react-router-dom";
import type { TMailFolder, TMailUser } from "../types";
import { Badge } from "./Badge";
import { Avatar } from "./Avatar";

interface SidebarProps {
  unreadCounts: Record<TMailFolder, number>;
  onCompose: () => void;
  user: TMailUser;
  isOpen: boolean;
  onClose: () => void;
  onLogout: () => void;
}

const links: Array<{
  label: string;
  path: string;
  key: TMailFolder | "assistant" | "settings";
  icon: string;
}> = [
  { label: "Inbox", path: "/", key: "inbox", icon: "IN" },
  { label: "Butler", path: "/assistant", key: "assistant", icon: "AI" },
  { label: "Sent", path: "/sent", key: "sent", icon: "SE" },
  { label: "Drafts", path: "/drafts", key: "drafts", icon: "DR" },
  { label: "Starred", path: "/starred", key: "starred", icon: "ST" },
  { label: "Spam", path: "/spam", key: "spam", icon: "SP" },
  { label: "Trash", path: "/trash", key: "trash", icon: "TR" },
  { label: "Settings", path: "/settings", key: "settings", icon: "GE" },
];

export function Sidebar({ unreadCounts, onCompose, user, isOpen, onClose, onLogout }: SidebarProps) {
  return (
    <aside className={`tmail-sidebar ${isOpen ? "open" : ""}`}>
      <div className="sidebar-brand" onClick={onClose} style={{ cursor: "pointer" }}>
        <img className="sidebar-brand-icon" src="/logo.png" alt="T-Mail Logo" />
        <span className="sidebar-brand-name">T-Mail</span>
        <button
          type="button"
          className="sidebar-close-btn"
          onClick={onClose}
          aria-label="Close menu"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div className="sidebar-profile">
        <Avatar name={user.displayName} size={38} />
        <div className="sidebar-profile-meta">
          <div className="sidebar-profile-name">{user.displayName}</div>
          <div className="sidebar-profile-address">{user.tmailAddress}</div>
        </div>
      </div>

      <button
        type="button"
        className="compose-btn"
        onClick={() => {
          onCompose();
          onClose();
        }}
      >
        <span className="compose-btn-plus" aria-hidden="true">+</span>
        <span className="compose-btn-label">Compose</span>
      </button>

      <div className="sidebar-section-label">Mailbox</div>

      <nav>
        {links.map((link) => (
          <NavLink
            key={link.path}
            to={link.path}
            className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}
            onClick={onClose}
            end={link.path === "/"}
          >
            <span className="sidebar-link-inner">
              <span className="sidebar-link-icon" aria-hidden="true">{link.icon}</span>
              <span>{link.label}</span>
            </span>
            {link.key !== "settings" && link.key !== "assistant" && (
              <Badge value={unreadCounts[link.key as TMailFolder]} />
            )}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-logout-container">
        <button
          type="button"
          className="sidebar-logout-btn"
          onClick={() => {
            onClose();
            onLogout();
          }}
        >
          <span className="sidebar-link-icon" aria-hidden="true">OUT</span>
          <span>Sign Out</span>
        </button>
      </div>
    </aside>
  );
}
