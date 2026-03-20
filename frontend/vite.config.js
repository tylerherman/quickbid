import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/upload": "http://localhost:8000",
      "/extract": "http://localhost:8000",
      "/save": "http://localhost:8000",
      "/scans": "http://localhost:8000",
      "/default-prompt": "http://localhost:8000",
      "/scan-with-prompt": "http://localhost:8000",
    },
  },
});
