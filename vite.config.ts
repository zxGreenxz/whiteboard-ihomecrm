import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // .e2e-fleet/*.spec.ts are Playwright specs (see .e2e-fleet/playwright.config.ts),
    // not vitest unit tests — keep them out of `vitest run` so the CI quality gate
    // does not fail on Playwright-only APIs (test.use, FLEET_BASE_URL, ...).
    exclude: [...configDefaults.exclude, ".e2e-fleet/**"],
  },
  build: {
    rollupOptions: {
      output: {
        // Tách vendor ổn định để cache lâu dài giữa các lần deploy.
        // DÙNG DẠNG FUNCTION + match đúng thư mục package: dạng object kéo cả
        // deps dùng chung (clsx của recharts trùng với cn() toàn app) vào
        // vendor-charts → mọi page chunk import vendor-charts tĩnh và bị
        // modulepreload ngay từ đầu, phá tác dụng lazy.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return "vendor-react";
          }
          if (id.includes(`${"node_modules"}/@supabase/`) || /[\\/]node_modules[\\/]@supabase[\\/]/.test(id)) {
            return "vendor-supabase";
          }
          if (/[\\/]node_modules[\\/]@tanstack[\\/]react-query/.test(id)) {
            return "vendor-query";
          }
          // UI kit + form stack: dùng bởi entry (auth/MainLayout) nên vốn đã
          // nằm trong chunk đầu — tách riêng để deploy app-code KHÔNG bust
          // cache ~30 gói ổn định này (an toàn với ghi chú recharts bên dưới:
          // các gói này được import tĩnh từ entry, không phá lazy).
          if (/[\\/]node_modules[\\/](@radix-ui|lucide-react|cmdk|vaul|embla-carousel|embla-carousel-react)[\\/]/.test(id)) {
            return "vendor-ui";
          }
          if (/[\\/]node_modules[\\/](react-hook-form|@hookform|zod)[\\/]/.test(id)) {
            return "vendor-forms";
          }
          // recharts KHÔNG đưa vào manualChunks: mọi consumer của nó đều lazy
          // nên Rollup tự tách thành chunk chia sẻ chỉ tải khi mở chart;
          // ép vào vendor-charts từng khiến entry import tĩnh + modulepreload
          // 433 kB ngay từ đầu (dep chung bị gộp nhầm).
          return undefined;
        },
      },
    },
  },
}));
