import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// Các gói @radix-ui mà ENTRY import tĩnh (qua Toaster/Tooltip/Label/Checkbox/
// Slot của màn auth) — đo bằng build chẩn đoán 2026-07-26: tách mỗi gói Radix
// thành 1 chunk riêng rồi đọc danh sách <link rel="modulepreload"> trong
// dist/index.html. Nếu entry thêm/bớt component Radix thì đo lại theo cách đó;
// thiếu 1 helper trong danh sách này sẽ kéo cả vendor-ui-lazy vào preload boot.
const RADIX_ENTRY_CORE = new Set([
  "primitive",
  "react-arrow",
  "react-checkbox",
  "react-collection",
  "react-compose-refs",
  "react-context",
  "react-dismissable-layer",
  "react-id",
  "react-label",
  "react-popper",
  "react-portal",
  "react-presence",
  "react-primitive",
  "react-slot",
  "react-toast",
  "react-tooltip",
  "react-use-callback-ref",
  "react-use-controllable-state",
  "react-use-escape-keydown",
  "react-use-layout-effect",
  "react-use-previous",
  "react-use-size",
  "react-visually-hidden",
]);

// https://vitejs.dev/config/
// SHA của commit dựng ra bản build. Vercel cấp `VERCEL_GIT_COMMIT_SHA`; build
// cục bộ có thể truyền `VITE_BUILD_SHA=$(git rev-parse HEAD)`. Không có thì để
// rỗng — E2E coi rỗng là THẤT BẠI, không phải "bỏ qua" (xem src/buildMetadata.ts).
const BUILD_SHA =
  process.env.VITE_BUILD_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? '';

const BUILD_SHA_META_PLUGIN = {
  name: 'build-sha-meta',
  transformIndexHtml(html: string) {
    return html.replaceAll('%VITE_BUILD_SHA%', BUILD_SHA);
  },
};

export default defineConfig(() => ({
  define: {
    'import.meta.env.VITE_BUILD_SHA': JSON.stringify(BUILD_SHA),
  },
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react(), BUILD_SHA_META_PLUGIN],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // .e2e-fleet/*.spec.ts are Playwright specs (see .e2e-fleet/playwright.config.ts),
    // not vitest unit tests — keep them out of `vitest run` so the CI quality gate
    // does not fail on Playwright-only APIs (test.use, FLEET_BASE_URL, ...).
    //
    // .claude/worktrees/** are git worktrees of OTHER branches (gitignored). Without
    // this, `npx vitest run` picks up their test files and reports them as failures of
    // the current branch — measured 29/07/2026: 9 file "đỏ" đều từ worktree
    // mikrotik-center, 0 lỗi thật trong src/. `npx vitest run src` does NOT help
    // (the argument is a name pattern, not a path filter).
    //
    // The vendored fork's upstream/artifacts/.work trees carry the upstream
    // package's own tests. Running them would report another project's suite as
    // this one's, and `verify:upstream` already covers that code.
    exclude: [
      ...configDefaults.exclude,
      ".e2e-fleet/**",
      "**/.claude/worktrees/**",
      // Same class as the line above: `vitest run` takes NAME patterns, not paths,
      // so any scratch checkout left in the repo root gets swept in and its
      // failures are reported as this project's. `.tmp-openclaw-host/` is a copy of
      // the upstream OpenClaw tree and brings ~40 red files that have nothing to do
      // with this repo.
      ".tmp-*/**",
      "services/openclaw-zalo-cell/vendor/zalouser-bridge/upstream/package/**",
      "services/openclaw-zalo-cell/vendor/zalouser-bridge/artifacts/**",
      "services/openclaw-zalo-cell/vendor/zalouser-bridge/.work/**",
    ],
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
          // Radix tách 2 tầng — MainLayout là chunk LAZY nên phần lớn Radix
          // không cần nằm trên critical path /login:
          //   - vendor-ui-core: đúng các gói entry import tĩnh (danh sách đo
          //     ở RADIX_ENTRY_CORE trên đầu file) — bị modulepreload lúc boot
          //     nên phải giữ nhỏ.
          //   - vendor-ui-lazy: phần @radix-ui còn lại + cmdk — vẫn gom 1
          //     chunk ổn định để cache dài hạn giữa các lần deploy, nhưng chỉ
          //     tải khi page lazy đầu tiên cần tới.
          // lucide-react KHÔNG đưa vào manualChunks: icon để Rollup rải theo
          // chunk sử dụng, tránh preload cả bộ icon toàn app lúc boot.
          const rdx = id.match(/[\\/]node_modules[\\/]@radix-ui[\\/]([^\\/]+)[\\/]/);
          if (rdx) {
            return RADIX_ENTRY_CORE.has(rdx[1]) ? "vendor-ui-core" : "vendor-ui-lazy";
          }
          if (/[\\/]node_modules[\\/]cmdk[\\/]/.test(id)) {
            return "vendor-ui-lazy";
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
