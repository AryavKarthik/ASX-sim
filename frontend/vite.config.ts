import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.ASXSIM_API ?? "http://127.0.0.1:8000";

// In development the React app runs on :5173 and forwards /api (including the replay
// WebSocket) to the FastAPI server on :8000, so the browser only ever talks to one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // ASXSIM_API points the dev server at another backend (e.g. one running on sample data).
      "/api": { target: apiTarget, ws: true },
    },
  },
});
