import React from "react";

interface AvatarProps {
  name: string;
  size?: number;
}

// Vibrant gradient palettes derived from name hash
const GRADIENTS: Array<[string, string]> = [
  ["#4f8ef7", "#7b5bf5"],  // blue-purple
  ["#ff6b6b", "#ff8e53"],  // coral-orange
  ["#34d399", "#059669"],  // green
  ["#fbbf24", "#f59e0b"],  // amber
  ["#a78bfa", "#7c3aed"],  // purple
  ["#06b6d4", "#0284c7"],  // cyan-blue
  ["#f472b6", "#ec4899"],  // pink
  ["#fb923c", "#ef4444"],  // orange-red
];

function gradientFromName(name: string): [string, string] {
  const code = Array.from(name).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return GRADIENTS[code % GRADIENTS.length];
}

export function Avatar({ name, size = 32 }: AvatarProps) {
  const initial = (name.trim().charAt(0) || "?").toUpperCase();
  const [from, to] = gradientFromName(name);
  const id = `avatar-${name.replace(/\W/g, "")}-${size}`;

  return (
    <div
      className="tmail-avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, size * 0.38),
        background: `linear-gradient(135deg, ${from} 0%, ${to} 100%)`,
        flexShrink: 0,
      }}
      aria-hidden
    >
      {initial}
    </div>
  );
}
