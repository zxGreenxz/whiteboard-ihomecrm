import { supabase } from '@/integrations/supabase/client';

export const ONBOARDING_KEY = 'onboarding_completed';

// Cờ onboarding là cờ THEO USER. BẮT BUỘC lọc user_id khi đọc: RLS của bảng
// settings cho super admin và staff thấy row của user khác
// (settings_super_admin_all / settings_select_staff), nên chỉ lọc theo key thì
// khi có ≥2 row cùng key, maybeSingle() dính lỗi PGRST116 "multiple rows",
// data = null → cờ bị đọc thành false vĩnh viễn và bảng Chào mừng hiện lại mãi
// cho tài khoản cũ (bug 26/08/2026, tài khoản nguyentamca165).
export async function fetchOnboardingCompleted(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', ONBOARDING_KEY)
    .eq('user_id', userId)
    .maybeSingle();
  return data?.value === true;
}
