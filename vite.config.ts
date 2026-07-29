import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri drives the dev server; a fixed port and a hard failure on collision keep
// the Rust side's devUrl honest instead of silently pointing at the wrong app.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
});
