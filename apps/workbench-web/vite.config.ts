import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwind()],
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
  // Never let a repeated build permanently clear the previous output.
  build: { emptyOutDir: false, sourcemap: true },
});
