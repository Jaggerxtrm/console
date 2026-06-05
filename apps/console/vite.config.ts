import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/dashboard",
  base: "/console/",
  build: {
    outDir: "../../dist/dashboard/console",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,
    fs: {
      allow: ["."],
    },
    proxy: {
      "/api/console/terminal/ws": {
        target: "ws://localhost:3030",
        ws: true,
      },
      "/api": {
        target: "http://localhost:3030",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:3030",
        ws: true,
      },
    },
  },
});
