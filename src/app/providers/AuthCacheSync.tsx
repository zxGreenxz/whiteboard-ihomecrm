import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { syncAuthQueryCache } from "@/lib/authQueryCache";

/**
 * Đăng ký listener auth và trả về hàm huỷ.
 *
 * Tách khỏi component để test được vòng đời mà không cần DOM: repo chạy vitest
 * ở environment `node` và không có @testing-library, nên một component chỉ có
 * useEffect là thứ không kiểm được. Ở dạng hàm thuần thì đăng ký, huỷ và việc
 * chuyển tiếp sự kiện đều quan sát trực tiếp được.
 *
 * CẢNH BÁO: callback phải SYNC — `await supabase.*` trong đó gây deadlock
 * (supabase-js giữ lock nội bộ khi dispatch sự kiện auth).
 */
export function subscribeAuthCacheSync(queryClient: QueryClient): () => void {
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    syncAuthQueryCache(queryClient, event, session);
  });

  return () => data.subscription.unsubscribe();
}

/**
 * Listener auth DUY NHẤT giữ cache ['auth','user'] / ['auth','session'] tươi
 * (INITIAL_SESSION khi boot, SIGNED_IN, TOKEN_REFRESHED, SIGNED_OUT, cross-tab)
 * → useAuth/useSession dùng staleTime: Infinity, không round-trip mạng.
 *
 * Trước đây listener này đăng ký ở MODULE SCOPE trong App.tsx và vứt luôn
 * subscription — không có đường huỷ. Production thường chỉ nạp module một lần
 * nên không lộ, nhưng HMR lúc dev, test isolation, hay một lần import lặp là đủ
 * tạo listener trùng, và mỗi listener lại ghi vào cùng một cache key.
 *
 * Đăng ký muộn (trong useEffect thay vì lúc import) KHÔNG làm mất sự kiện boot:
 * supabase-js gọi `_emitInitialSession` riêng cho TỪNG subscriber mới, nên
 * listener nào đăng ký cũng nhận được INITIAL_SESSION của chính nó.
 * Đã kiểm trên @supabase/auth-js 2.81.1.
 */
export function AuthCacheSync(): null {
  const queryClient = useQueryClient();

  useEffect(() => subscribeAuthCacheSync(queryClient), [queryClient]);

  return null;
}
