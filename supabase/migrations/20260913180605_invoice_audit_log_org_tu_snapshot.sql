-- =============================================================================
-- invoice_audit_log: bản ghi DELETE phải mang organization_id lấy từ snapshot,
-- vì lúc trigger AFTER DELETE chạy thì hoá đơn đã không còn để tra.
--
-- VÌ SAO (đo 14/09/2026 01:00 giờ VN)
--   public._invoice_audit_invoices (AFTER INSERT/UPDATE/DELETE trên invoices) ghi
--   invoice_audit_log KHÔNG kèm organization_id; trigger BEFORE INSERT
--   a90_autofill_org (app_private.autofill_pre_invoice_audit_v1) điền org bằng
--   cách tra public.invoices theo invoice_id. Với TG_OP = DELETE, dòng hoá đơn
--   đã bị xoá trước khi trigger AFTER chạy → tra không ra → organization_id NULL.
--   Gate CI "Không rò dữ liệu xuyên tổ chức" (scripts/measure-org-leak.mjs) đỏ
--   vì dòng NULL ở bảng chưa khai toàn hệ: 1 dòng DELETE của hoá đơn fixture
--   E2E DEMO bị dọn lúc 17:57 UTC 13/09. Mọi lần xoá cứng hoá đơn (fixture E2E,
--   dọn dữ liệu) đều tái diễn — không phải sự cố một lần.
--   Bảng có guard append-only (a00_audit_append_only chặn UPDATE/DELETE) nên
--   không sửa tay được; phải đi migration như 20260809020000 đã làm.
--
-- SỬA GÌ
--   1. autofill_pre_invoice_audit_v1: sau khi tra hoá đơn không ra, lấy org từ
--      snapshot NEW.before / NEW.after (jsonb có organization_id của chính dòng
--      hoá đơn, chỉ nhận uuid đúng dạng). Chép nguyên định nghĩa đang chạy trên
--      production (pg_get_functiondef 14/09/2026), chỉ thêm nhánh fallback.
--   2. Backfill các dòng đang NULL mà snapshot có org CÒN TỒN TẠI trong
--      organizations (RI trigger cũng im dưới 'replica', nên phải tự kiểm để
--      không ghi tham chiếu treo tới org đã xoá): tạm
--      session_replication_role = 'replica' trong transaction (đúng cách của
--      20260809020000), rồi chứng minh guard sống lại trước khi kết thúc.
--
-- KHÁC 20260809020000 Ở ĐÂU: file đó XOÁ dòng DELETE mồ côi (hoá đơn đã xoá,
--   actor không quy được về org); file này GIỮ và điền org từ snapshot của chính
--   hoá đơn — nguồn quy tổ chức mạnh hơn membership của actor. Không mâu thuẫn
--   về nguyên tắc "phải quy được về một tổ chức", chỉ khác kết quả cho cùng loại
--   dòng; các dòng 0809 đã xoá không lùi được.
--
-- IDEMPOTENT: CREATE OR REPLACE; backfill chỉ chạm dòng còn NULL (lần hai = 0).
-- Chạy được trên DB rỗng (Restore Drill baseline schema-only): kiểm guard bằng
-- pg_trigger, chỉ thử UPDATE thật khi bảng có dòng.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_private.autofill_pre_invoice_audit_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
begin
  if new.organization_id is null and new.invoice_id is not null then
    select i.organization_id into new.organization_id from public.invoices i where i.id = new.invoice_id;
  end if;
  -- Bản ghi DELETE: hoá đơn đã mất, org nằm trong snapshot của chính dòng đó.
  -- Chỉ nhận uuid đúng dạng để không chặn thao tác gốc trên invoices vì rác.
  if new.organization_id is null then
    new.organization_id := coalesce(
      case when lower(new.before->>'organization_id')
                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           then (new.before->>'organization_id')::uuid end,
      case when lower(new.after->>'organization_id')
                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           then (new.after->>'organization_id')::uuid end
    );
  end if;
  return new;
end $function$;

DO $backfill$
DECLARE
  v_truoc bigint;
  v_sau bigint;
  v_dien integer;
  v_treo bigint;
BEGIN
  SELECT count(*) INTO v_truoc FROM public.invoice_audit_log;

  -- Guard append-only là trigger ENABLE-ORIGIN: 'replica' làm nó im trong
  -- transaction này (SET LOCAL, tự hoàn lại khi COMMIT/ROLLBACK). RI trigger
  -- của FK organization_id cũng im theo, nên WHERE tự kiểm org còn tồn tại.
  SET LOCAL session_replication_role = 'replica';

  UPDATE public.invoice_audit_log t
     SET organization_id = s.org
    FROM (
      SELECT a.id,
             coalesce(
               case when lower(a.before->>'organization_id')
                         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then (a.before->>'organization_id')::uuid end,
               case when lower(a.after->>'organization_id')
                         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then (a.after->>'organization_id')::uuid end
             ) AS org
        FROM public.invoice_audit_log a
       WHERE a.organization_id IS NULL
    ) s
   WHERE s.id = t.id
     AND s.org IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = s.org);
  GET DIAGNOSTICS v_dien = ROW_COUNT;
  RAISE NOTICE 'invoice_audit_log: điền organization_id từ snapshot cho % dòng.', v_dien;

  SET LOCAL session_replication_role = 'origin';
  IF current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'session_replication_role chưa về origin. DỪNG.';
  END IF;

  -- Guard phải sống lại NGAY, và phải chứng minh nó sống. Trên DB rỗng
  -- (Restore Drill replay lên baseline schema-only) UPDATE không chạm dòng nào
  -- nên trigger không nổ — chỉ thử khi bảng có dòng, còn lại kiểm trạng thái
  -- trigger trực tiếp trong pg_trigger.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = 'public.invoice_audit_log'::regclass
       AND tgname = 'a00_audit_append_only' AND tgenabled IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION 'Guard append-only a00_audit_append_only của invoice_audit_log không tồn tại hoặc không bật. DỪNG.';
  END IF;
  IF v_truoc > 0 THEN
    BEGIN
      UPDATE public.invoice_audit_log SET organization_id = organization_id
       WHERE id = (SELECT id FROM public.invoice_audit_log LIMIT 1);
      RAISE EXCEPTION 'Guard append-only của invoice_audit_log KHÔNG chặn UPDATE sau khi khôi phục. DỪNG.';
    EXCEPTION WHEN sqlstate '55000' THEN
      NULL;  -- đúng như mong đợi
    END;
  END IF;

  -- Không được thêm/bớt dòng nào, và không được để tham chiếu treo.
  SELECT count(*) INTO v_sau FROM public.invoice_audit_log;
  IF v_sau <> v_truoc THEN
    RAISE EXCEPTION 'invoice_audit_log: % dòng trước, % dòng sau — có thứ khác đụng vào sổ. DỪNG.', v_truoc, v_sau;
  END IF;
  SELECT count(*) INTO v_treo
    FROM public.invoice_audit_log t
   WHERE t.organization_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id);
  IF v_treo > 0 THEN
    RAISE EXCEPTION 'invoice_audit_log: % dòng trỏ tới organization không tồn tại. DỪNG.', v_treo;
  END IF;
END
$backfill$;
