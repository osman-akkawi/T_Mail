import React from "react";

interface BadgeProps {
  value: number;
}

export function Badge({ value }: BadgeProps) {
  if (value <= 0) {
    return null;
  }
  return <span className="tmail-badge">{value}</span>;
}
