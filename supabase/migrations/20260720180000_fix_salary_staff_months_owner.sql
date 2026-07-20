-- =============================================
-- Migration: salary_staff_months() giai sai chu so huu → override cua admin
--            khong bao gio toi duoc nhan vien.
--
-- BUG: ham dung COALESCE theo thu tu
--   super_admins → buildings(user_id = me) → staff_assignments → auth.uid()
-- Nhanh `buildings` khop NGAY khi nhan vien tinh co dung ten mot dong buildings
-- (vd NATHAN co 1 toa dung ten minh) → owner giai ra thanh CHINH NHAN VIEN →
-- khong co dong salary_bonus_rules → tra '{}' → man "Thang hien thi cho nhan
-- vien" cua admin bat/tat bao nhieu cung vo nghia.
--
-- FIX: giu NGUYEN thu tu uu tien, chi them dieu kien ung vien phai THUC SU co
-- dong salary_bonus_rules. Ung vien khong co cau hinh bi bo qua thay vi lam
-- ham dung lai o do. Voi NATHAN: buildings→NATHAN (khong rules) bi bo qua →
-- staff_assignments→chu (co rules) duoc chon. Chu that su van khop o nhanh 1/2
-- nhu cu nen khong doi hanh vi.
-- =============================================

BEGIN;

CREATE OR REPLACE FUNCTION public.salary_staff_months()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH cand AS (
    SELECT 1 AS pri, 0::bigint AS w, sa.user_id
      FROM public.super_admins sa
     WHERE sa.user_id = auth.uid()
    UNION ALL
    SELECT 2, 0::bigint, b.user_id
      FROM public.buildings b
     WHERE b.user_id = auth.uid() AND b.deleted_at IS NULL
    UNION ALL
    SELECT 3, count(*), sa.user_id
      FROM public.staff_assignments sa
     WHERE sa.staff_id = auth.uid()
     GROUP BY sa.user_id
    UNION ALL
    SELECT 4, 0::bigint, auth.uid()
  )
  SELECT COALESCE(
    (
      SELECT r.rules -> 'staffMonths'
        FROM cand c
        JOIN public.salary_bonus_rules r ON r.user_id = c.user_id
       ORDER BY c.pri, c.w DESC, c.user_id
       LIMIT 1
    ),
    '{}'::jsonb
  );
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';
