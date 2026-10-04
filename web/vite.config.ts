import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
      },
      "/session": {
        target: "http://127.0.0.1:8080",
        ws: true,
        bypass(req) {
          const pathOnly = (req.url ?? "").split("?")[0] ?? "";
          // Keep the SPA shell for /session/:id; proxy /session/:id/view/*
          if (/^\/session\/[^/]+\/?$/.test(pathOnly)) {
            return req.url;
          }
        },
      },
    },
  },
});
