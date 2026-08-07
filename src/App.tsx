import { Suspense, useEffect, useState } from "react";
import { BrowserRouter } from "react-router-dom";
import { AppProviders } from "@/app/providers/AppProviders";
import { AppRoutes } from "@/app/routes";
import { CopilotLauncher } from "@/app/lazyPages";

/**
 * App còn đúng hai việc: dựng provider và dựng cây route (P1.2 của plan).
 *
 * Trước lát này file dài 373 dòng và làm bốn việc cùng lúc: khai 99 import lazy,
 * cấu hình QueryClient, khai toàn bộ route công khai, và compose provider. Hệ quả
 * đo được: mọi test điều hướng phải regex trên VĂN BẢN NGUỒN của nó, và mọi thay
 * đổi nhỏ ở một route đều đụng vào file mà cả app đi qua.
 *
 *   provider  → src/app/providers/AppProviders.tsx (+ QueryProvider)
 *   route     → src/app/routes/index.tsx (+ publicRoutes và 9 nhóm sẵn có)
 *   lazy page → src/app/lazyPages.ts
 */

/** Fallback khi đang tải chunk của route lazy. */
const RouteFallback = () => (
  <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
    Đang tải…
  </div>
);

/**
 * Nút AI Copilot nổi toàn app.
 *
 * Hoãn tới lúc trình duyệt rảnh: nó không thuộc first paint, và nạp sớm sẽ tranh
 * băng thông với chunk của route người dùng đang thật sự mở.
 */
const DeferredCopilotLauncher = () => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const idleWindow = window as unknown as {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (idleWindow.requestIdleCallback) {
      const id = idleWindow.requestIdleCallback(() => setReady(true), { timeout: 1_500 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }

    const id = window.setTimeout(() => setReady(true), 700);
    return () => window.clearTimeout(id);
  }, []);

  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <CopilotLauncher />
    </Suspense>
  );
};

const App = () => (
  <AppProviders>
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
        <AppRoutes />
      </Suspense>
      {/* AI Copilot: nút nổi toàn app — tự ẩn trên route public / khi không
          có session / không entitlement / không quyền ai_copilot.view */}
      <DeferredCopilotLauncher />
    </BrowserRouter>
  </AppProviders>
);

export default App;
