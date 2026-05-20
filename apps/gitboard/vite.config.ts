import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/dashboard",
  base: "/gitboard/",
  build: {
    outDir: "../../dist/dashboard/gitboard",
    emptyOutDir: true,
  },
  server: {
    fs: {
      allow: ["."],
    },
    proxy: {
      "/api/console/terminal/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
});