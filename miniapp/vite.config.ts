import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

interface ProcessEnv {
  [key: string]: string | undefined;
}
declare const process: {
  env: ProcessEnv;
};

function getAllowedHosts(): string[] {
  const extraHosts = (process.env.VITE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return [
    ".vercel.app",
    ".onrender.com",
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
