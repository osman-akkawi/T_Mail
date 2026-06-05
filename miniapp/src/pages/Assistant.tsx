import React from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { MailButlerInsights } from "../types";

export default function AssistantPage() {
  const [insights, setInsights] = React.useState<MailButlerInsights | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await api.assistant.insights();
        setInsights(response.insights);
      } catch (loadError: unknown) {
        const message = loadError instanceof Error ? loadError.message : "Failed to load Mail Butler";
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, []);

  return (
    <section className="page assistant-page">
      <div className="page-header">
        <h1>Mail Butler</h1>
      </div>

      {loading && <p>Reading your mailbox signals...</p>}
      {!loading && error && <p className="auth-error">{error}</p>}

      {!loading && insights && (
        <>
          <div className="assistant-grid">
            <div className="assistant-stat"><span>Unread</span><strong>{insights.unreadCount}</strong></div>
            <div className="assistant-stat"><span>Actions</span><strong>{insights.actionCount}</strong></div>
            <div className="assistant-stat"><span>Attachments</span><strong>{insights.attachmentCount}</strong></div>
            <div className="assistant-stat"><span>Drafts</span><strong>{insights.draftCount}</strong></div>
            <div className="assistant-stat"><span>Spam</span><strong style={{ color: insights.spamCount > 0 ? "var(--color-danger, #e74c3c)" : undefined }}>{insights.spamCount}</strong></div>
          </div>

          <div className="settings-card assistant-card">
            <h3>Today's Digest</h3>
            <div className="assistant-digest">
              {insights.digest.map((item) => (
                <p key={item}>{item}</p>
              ))}
            </div>
          </div>

          <div className="settings-card assistant-card">
            <h3>Priority Inbox</h3>
            {insights.priority.length === 0 ? (
              <p>No priority messages right now.</p>
            ) : (
              <div className="assistant-list">
                {insights.priority.map((item) => (
                  <Link
                    key={item.id}
                    className="assistant-item"
                    to={`/email/${item.folder}/${item.id}`}
                  >
                    <strong>{item.subject}</strong>
                    <span>{item.from} · {new Date(item.date).toLocaleString()}</span>
                    <p>{item.preview}</p>
                    <em>{item.reason}</em>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="settings-card assistant-card">
            <h3>Suggested Replies</h3>
            {insights.suggestedReplies.length === 0 ? (
              <p>No reply suggestions right now.</p>
            ) : (
              <div className="assistant-list">
                {insights.suggestedReplies.map((item) => (
                  <Link
                    key={item.id}
                    className="assistant-item"
                    to={`/email/${item.folder}/${item.id}`}
                  >
                    <strong>{item.subject}</strong>
                    <span>{item.from}</span>
                    <p>{item.replySuggestion}</p>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
