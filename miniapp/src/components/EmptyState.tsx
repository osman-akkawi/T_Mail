import React from "react";

interface EmptyStateProps {
  title: string;
  description: string;
  icon?: string;
}

export function EmptyState({ title, description, icon = "📭" }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state-illustration" aria-hidden>
        {icon}
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
