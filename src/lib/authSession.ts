// =============================================================================
// authSession — đọc user từ session LOCAL (localStorage) thay cho
// supabase.auth.getUser() vốn round-trip mạng tới /auth/v1/user mỗi lần gọi.
// Chỉ dùng để gate UI / lấy user.id trong queryFn: mọi request dữ liệu vẫn
// mang JWT và bị RLS kiểm phía server, nên không cần server re-validate ở đây.
// getSession() tự refresh token khi hết hạn (chỉ lúc đó mới có network call).
// =============================================================================

import { supabase } from '@/integrations/supabase/client';
import type { User } from '@supabase/supabase-js';

/** User từ session local (đủ id/email/user_metadata) — null nếu chưa đăng nhập. */
export async function getSessionUser(): Promise<User | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user ?? null;
}

/** user.id từ session local — null nếu chưa đăng nhập. */
export async function getSessionUserId(): Promise<string | null> {
  const user = await getSessionUser();
  return user?.id ?? null;
}
