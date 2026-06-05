import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function getAllowedHosts(): string[] {
  const extraHosts = (process.env.VITE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return [
    "karaoke-enhance-chess-infinite.trycloudflare.com",
    ".trycloudflare.com",
    ...extraHosts,
  ];
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: getAllowedHosts(),
  },
});
