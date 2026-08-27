BEGIN;
-- ============================================================
-- salary_monthly · salary_adjustments: điền nhãn tổ chức + chặn tái diễn
--
-- VÌ SAO CÓ FILE NÀY — gate measure-org-leak đỏ trên CI run 33072401830
-- (27/08/2026), đúng thứ nó sinh ra để bắt:
--     ❌ 6 dòng organization_id NULL ở bảng CHƯA KHAI
--        ✗ salary_adjustments — 4 dòng
--        ✗ salary_monthly     — 2 dòng
--   Công thức biên giới tổ chức có nhánh `organization_id IS NULL`, nên 6 dòng
--   này — 4 khoản thưởng tay kỳ 7/2026 và 2 bản ghi lương DRAFT sinh kèm —
--   HIỂN THỊ CHO MỌI CÔNG TY. Đây là rò dữ liệu tiền lương xuyên tenant, không
--   phải phiền toái hiển thị.
--
--   Nguồn: useManagerSalary.ts ghi thẳng vào hai bảng này mà không set
--   organization_id (ensureMonthly + insert salary_adjustments). Bản sửa FE đi
--   cùng commit này đọc org từ manager_salary_config như writer canonical
--   lock_salary_month_v1 vẫn làm. Nhưng sửa FE chỉ bịt MỘT đường ghi — nên
--   file này bịt ở tầng dữ liệu, nơi mọi đường ghi đều phải đi qua.
--
-- SUY ORG THEO staff_id, KHÔNG THEO user_id. Trên hai bảng lương, `user_id` là
--   CHỦ bảng lương (tài khoản hệ thống), không phải người hưởng lương; chủ có
--   thể thuộc nhiều org nên suy từ đó là đoán. `manager_salary_config.staff_id`
--   là đúng nguồn mà lock_salary_month_v1 dùng — hai đường ghi cùng một câu trả
--   lời thì số mới không lệch nhau.
--
-- KHÔNG dùng public._autofill_org(): nó chỉ biết building/room/contract/... và
--   user_id, không biết staff_id, nên trên bảng lương nó sẽ rơi xuống nhánh
--   PROD_DEFAULT_FALLBACK và gán org mặc định — đúng số hôm nay, sai ngay khi
--   có công ty thứ hai dùng bảng lương.
--
-- CHẠY ĐƯỢC TRÊN DATABASE RỖNG: mọi UPDATE đều lọc IS NULL (rỗng → 0 dòng), hai
--   trigger dùng DROP IF EXISTS + CREATE, và phép kiểm cuối chỉ soi CATALOG chứ
--   không khẳng định gì trên dữ liệu. Bài học từ 20260827120000: smoke đòi dữ
--   liệu làm Restore Drill cuộn nguyên file và đánh mất luôn trigger.
-- ============================================================

CREATE OR REPLACE FUNCTION public._autofill_org_salary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  j jsonb := to_jsonb(NEW);
  v uuid;
  n_orgs int;
BEGIN
  IF NEW.organization_id IS NOT NULL THEN RETURN NEW; END IF;

  -- salary_monthly: staff_id nằm ngay trên dòng.
  IF (j->>'staff_id') IS NOT NULL THEN
    SELECT organization_id INTO v
      FROM public.manager_salary_config
     WHERE staff_id = (j->>'staff_id')::uuid AND organization_id IS NOT NULL
     ORDER BY is_active DESC, created_at DESC
     LIMIT 1;

    IF v IS NULL THEN
      SELECT (array_agg(DISTINCT organization_id))[1], count(DISTINCT organization_id)
        INTO v, n_orgs
        FROM public.organization_memberships
       WHERE user_id = (j->>'staff_id')::uuid AND status = 'ACTIVE';
      IF n_orgs IS DISTINCT FROM 1 THEN v := NULL; END IF;
    END IF;
  END IF;

  -- salary_adjustments: đi qua bản ghi lương tháng mà nó treo vào.
  IF v IS NULL AND (j->>'salary_monthly_id') IS NOT NULL THEN
    SELECT organization_id INTO v
      FROM public.salary_monthly
     WHERE id = (j->>'salary_monthly_id')::uuid;
  END IF;

  -- KHÔNG có nhánh fallback org mặc định: thà chặn dòng ghi còn hơn dán nhãn
  -- đoán lên một dòng tiền. NOT NULL ở đây là cố ý gây lỗi cho người gọi.
  IF v IS NULL THEN
    RAISE EXCEPTION
      'Không suy được tổ chức cho dòng % — thiếu manager_salary_config cho nhân viên?',
      TG_TABLE_NAME
      USING ERRCODE = '23502';
  END IF;

  NEW.organization_id := v;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public._autofill_org_salary() FROM PUBLIC;

-- Backfill: lương tháng trước (adjustments đọc ngược từ nó ở bước sau).
UPDATE public.salary_monthly sm
   SET organization_id = c.organization_id
  FROM public.manager_salary_config c
 WHERE c.staff_id = sm.staff_id
   AND sm.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

UPDATE public.salary_adjustments a
   SET organization_id = sm.organization_id
  FROM public.salary_monthly sm
 WHERE sm.id = a.salary_monthly_id
   AND a.organization_id IS NULL
   AND sm.organization_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_autofill_org_salary ON public.salary_monthly;
CREATE TRIGGER trg_autofill_org_salary
  BEFORE INSERT ON public.salary_monthly
  FOR EACH ROW EXECUTE FUNCTION public._autofill_org_salary();

DROP TRIGGER IF EXISTS trg_autofill_org_salary ON public.salary_adjustments;
CREATE TRIGGER trg_autofill_org_salary
  BEFORE INSERT ON public.salary_adjustments
  FOR EACH ROW EXECUTE FUNCTION public._autofill_org_salary();

-- Kiểm bằng catalog, không bằng dữ liệu.
DO $kiem$
DECLARE
  v_so integer;
BEGIN
  SELECT count(*) INTO v_so
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid IN ('public.salary_monthly'::regclass, 'public.salary_adjustments'::regclass)
    AND p.proname = '_autofill_org_salary'
    AND NOT t.tgisinternal;

  IF v_so <> 2 THEN
    RAISE EXCEPTION 'Kỳ vọng 2 trigger _autofill_org_salary (salary_monthly + salary_adjustments), đếm được %', v_so;
  END IF;
END
$kiem$;

COMMIT;
