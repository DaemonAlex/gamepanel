import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  // In development the API runs on :3000.
  server: { proxy: { "/api": { target: "http://127.0.0.1:3000", ws: true } } },
});
