import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [solid()],
  // Shown in Settings → Account (package.json is bumped with each release).
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    target: "chrome120", // WebView2 is evergreen Chromium
    minify: "esbuild",
    cssMinify: true,
    modulePreload: false,
    sourcemap: false,
    reportCompressedSize: true,
    // Main window + the in-game overlay (its own small page).
    rollupOptions: { input: { main: "index.html", overlay: "overlay.html" } },
  },
});
