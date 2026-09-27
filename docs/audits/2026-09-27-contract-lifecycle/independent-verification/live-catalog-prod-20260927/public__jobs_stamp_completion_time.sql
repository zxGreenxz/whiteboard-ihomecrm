-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.jobs_stamp_completion_time() md5(prosrc)=3104d52fcc28aa9807c677c123ca4c83
CREATE OR REPLACE FUNCTION public.jobs_stamp_completion_time()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_admin  BOOLEAN := public.is_admin() OR public.is_super_admin();
  v_old_pm DATE;
  v_new_pm DATE;
BEGIN
  -- Chuyen SANG hoan thanh (insert thang COMPLETED cung tinh)
  IF NEW.status = 'COMPLETED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'COMPLETED') THEN
    -- Admin duoc phep khai gio hoan thanh (lui ngay nghiep vu); nguoi thuong thi KHONG.
    IF NOT v_admin OR NEW.completion_time IS NULL THEN
      NEW.completion_time := now();
    END IF;
    -- Chan gio tuong lai trong moi truong hop — khong ai hoan thanh viec o thi tuong lai.
    IF NEW.completion_time > now() + INTERVAL '1 minute' THEN
      RAISE EXCEPTION 'Thoi gian hoan thanh khong duoc o tuong lai (%).', NEW.completion_time
        USING HINT = 'completion_time do server dong dau; kiem tra dong ho thiet bi.';
    END IF;
    RETURN NEW;
  END IF;

  -- Sua completion_time tren dong DA hoan thanh
  IF TG_OP = 'UPDATE' AND OLD.status = 'COMPLETED'
     AND NEW.completion_time IS DISTINCT FROM OLD.completion_time THEN
    IF NOT v_admin THEN
      RAISE EXCEPTION 'Khong duoc sua thoi gian hoan thanh cua cong viec da xong.'
        USING HINT = 'Lien he quan ly neu can dieu chinh — thao tac nay co kiem soat.';
    END IF;
    -- Admin: van chan neu ky luong (cu HOAC moi) da CHOT — tranh tra hai lan.
    v_old_pm := date_trunc('month', public.vn_local_date(OLD.completion_time))::date;
    v_new_pm := date_trunc('month', public.vn_local_date(NEW.completion_time))::date;
    IF EXISTS (
      SELECT 1 FROM public.salary_monthly sm
      WHERE sm.staff_id = OLD.assignee_id
        AND sm.period_month IN (v_old_pm, v_new_pm)
        AND sm.locked_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Ky luong lien quan da chot — khong the doi thoi gian hoan thanh.'
        USING HINT = 'Mo khoa ky luong truoc, hoac dung phieu dieu chinh.';
    END IF;
  END IF;

  RETURN NEW;
END; $function$

