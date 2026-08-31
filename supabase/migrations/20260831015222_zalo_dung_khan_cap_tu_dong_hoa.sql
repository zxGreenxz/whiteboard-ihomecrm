-- =============================================================================
-- Chat Zalo — NÚT DỪNG KHẨN CẤP cho tự động hoá.
--
-- LỖ HỔNG ĐÃ CẮN THẬT (31/08/2026, ngay lượt chạy đầu tiên trên production).
-- Engine xếp CẢ LÔ tin vào `zalo_send_queue` với `not_before` rải sẵn — thiết kế
-- đó có chủ đích và vẫn đúng: nó khiến việc rải nhịp là DỮ LIỆU, nên worker
-- restart giữa chừng thì phần chưa gửi vẫn còn và vẫn đúng giờ.
--
-- Nhưng nó tạo ra một hệ quả không ai lường: **tắt công tắc không dừng được lô
-- đang bay**. Công tắc chỉ ngăn LƯỢT MỚI; 32 tin đã nằm trong hàng đợi vẫn lần
-- lượt đi ra trong ~2,5 phút sau đó. Chủ dự án bấm tắt và thấy tin vẫn tiếp tục
-- nhắn — đúng như báo cáo. Với một lô đầy đủ gửi nhiều nhóm, khoảng đó là hàng
-- chục phút, và người dùng không có cách nào chặn ngoài việc tắt nguồn máy chạy
-- worker.
--
-- Một công tắc mà bấm xong thứ nó điều khiển vẫn chạy tiếp thì không phải công
-- tắc. Migration này cấp cái phanh thật:
--
--   `zalo_dung_khan_cap(org)` — một lần bấm làm BA việc, trong MỘT giao dịch:
--     1. huỷ mọi job tự động còn `queued` (chưa ai claim) của công ty;
--     2. đánh dấu các tin đang `pending` của những job đó thành `failed` — nếu
--        không, khung chat treo vĩnh viễn mấy chục dòng "đang gửi" cho những tin
--        sẽ không bao giờ đi;
--     3. TẮT cả hai công tắc — dừng mà để công tắc bật thì lượt sau lại chạy.
--
-- CỐ Ý KHÔNG đụng job `processing`: worker đang cầm nó trên tay, giữa chừng một
-- lời gọi zca. Xoá dòng dưới chân nó chỉ tạo ra tin gửi rồi mà DB tưởng chưa gửi.
-- Số job đó nhiều nhất là 1 tại một thời điểm (tick xử lý tuần tự).
--
-- Thêm `mode='stopped'` vào nhật ký: dừng khẩn cấp là sự kiện phải NHÌN THẤY
-- được khi đọc lại sổ, không được lẫn vào 'skipped' (bỏ lượt vì danh sách không
-- đổi) — hai thứ đó khác nhau hoàn toàn về ý nghĩa vận hành.
--
-- Idempotent. Chạy SAU 20260830163815.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Nhật ký nhận thêm chế độ 'stopped'
-- ---------------------------------------------------------------------------
ALTER TABLE public.zalo_automation_runs DROP CONSTRAINT IF EXISTS zalo_automation_runs_mode_check;
ALTER TABLE public.zalo_automation_runs ADD CONSTRAINT zalo_automation_runs_mode_check
  CHECK (mode IN ('full','compact','event','reply','skipped','off','failed','stopped'));

COMMENT ON COLUMN public.zalo_automation_runs.mode IS
  'full/compact = hai chế độ broadcast · event = gửi bổ sung khi có phòng mới trống trong ngày · reply = auto-reply · skipped = tới giờ nhưng bỏ lượt · off = lịch tắt ngày đó · failed = lỗi · stopped = người dùng bấm DỪNG KHẨN CẤP.';

-- ---------------------------------------------------------------------------
-- 2. RPC dừng khẩn cấp
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_dung_khan_cap(p_organization_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org      uuid;
  v_orgs     uuid[];
  v_job_ids  uuid[];
  v_msg_ids  uuid[];
  v_so_job   int := 0;
  v_so_tin   int := 0;
  v_dang_gui int := 0;
  v_acc      uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  IF p_organization_id IS NOT NULL THEN
    IF NOT public.zalo_can('manage_automation', p_organization_id) THEN
      RAISE EXCEPTION 'Bạn không có quyền quản lý tự động hoá trong tổ chức này' USING ERRCODE = '42501';
    END IF;
    v_org := p_organization_id;
  ELSE
    SELECT array_agg(o) INTO v_orgs FROM public.zalo_authorized_org_ids('manage_automation') o;
    IF v_orgs IS NULL OR array_length(v_orgs, 1) IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'Không xác định được tổ chức — truyền p_organization_id.' USING ERRCODE = '23502';
    END IF;
    v_org := v_orgs[1];
  END IF;

  -- (a) Chốt danh sách job sẽ huỷ. FOR UPDATE SKIP LOCKED: job nào worker đang
  --     claim dở thì bỏ qua thay vì chờ — nút khẩn cấp không được phép treo.
  SELECT array_agg(id), array_agg(message_id) FILTER (WHERE message_id IS NOT NULL)
    INTO v_job_ids, v_msg_ids
    FROM (
      SELECT id, message_id
        FROM public.zalo_send_queue
       WHERE organization_id = v_org
         AND status = 'queued'
         AND payload ? 'tu_dong'
       FOR UPDATE SKIP LOCKED
    ) t;

  v_so_job := COALESCE(array_length(v_job_ids, 1), 0);

  IF v_so_job > 0 THEN
    DELETE FROM public.zalo_send_queue WHERE id = ANY(v_job_ids);

    -- Tin của job vừa huỷ: `failed` chứ không xoá. Người dùng vừa thấy chúng
    -- hiện ra trong khung chat — cho biến mất không dấu vết còn khó hiểu hơn là
    -- để lại một dòng báo không gửi được.
    IF v_msg_ids IS NOT NULL THEN
      UPDATE public.zalo_messages
         SET status = 'failed'
       WHERE id = ANY(v_msg_ids) AND status = 'pending';
      GET DIAGNOSTICS v_so_tin = ROW_COUNT;
    END IF;
  END IF;

  -- (b) Còn bao nhiêu job worker đang cầm — KHÔNG đụng, chỉ báo cho người dùng
  --     biết vì sao có thể còn một tin nữa đi ra sau khi bấm.
  SELECT count(*) INTO v_dang_gui
    FROM public.zalo_send_queue
   WHERE organization_id = v_org AND status = 'processing' AND payload ? 'tu_dong';

  -- (c) Tắt cả hai công tắc.
  UPDATE public.zalo_automations
     SET enabled = false, updated_at = now()
   WHERE organization_id = v_org AND enabled;

  -- (d) Ghi sổ. Lấy một account của công ty cho trigger org; không có thì thôi,
  --     nhật ký không được phép chặn phanh khẩn cấp.
  SELECT id INTO v_acc FROM public.zalo_accounts WHERE organization_id = v_org LIMIT 1;
  BEGIN
    INSERT INTO public.zalo_automation_runs(
      organization_id, account_id, kind, mode, reason, messages_count, detail)
    VALUES (
      v_org, v_acc, 'broadcast_vacant', 'stopped',
      format('DỪNG KHẨN CẤP: huỷ %s tin đang chờ gửi, tắt cả hai công tắc.', v_so_job),
      v_so_job,
      jsonb_build_object('so_job_huy', v_so_job, 'so_tin_danh_dau_that_bai', v_so_tin,
                         'con_dang_gui', v_dang_gui, 'boi', auth.uid()));
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Không ghi được nhật ký dừng khẩn cấp: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'da_huy', v_so_job,
    'tin_danh_dau_that_bai', v_so_tin,
    'con_dang_gui', v_dang_gui);
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_dung_khan_cap(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zalo_dung_khan_cap(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.zalo_dung_khan_cap(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_dung_khan_cap(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chỉ soi catalog, chạy được trên database rỗng.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE v_n bigint;
BEGIN
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.zalo_automation_runs'::regclass
         AND conname = 'zalo_automation_runs_mode_check') NOT LIKE '%stopped%' THEN
    RAISE EXCEPTION 'mode CHECK chưa nhận ''stopped''. DỪNG.';
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'zalo_dung_khan_cap';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'zalo_dung_khan_cap phải có đúng 1 bản (thấy %). DỪNG.', v_n;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'zalo_dung_khan_cap'
                    AND has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'zalo_dung_khan_cap còn anon-executable. DỪNG.';
  END IF;

  RAISE NOTICE 'Nghiệm thu dừng-khẩn-cấp đạt: mode stopped hợp lệ, RPC đúng 1 bản, ACL sạch anon.';
END
$nghiem_thu$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- =============================================================================
-- ROLLBACK (tay):
--   DROP FUNCTION public.zalo_dung_khan_cap(uuid);
--   ALTER TABLE public.zalo_automation_runs DROP CONSTRAINT zalo_automation_runs_mode_check;
--   ALTER TABLE public.zalo_automation_runs ADD CONSTRAINT zalo_automation_runs_mode_check
--     CHECK (mode IN ('full','compact','event','reply','skipped','off','failed'));
--   (chỉ lùi được khi chưa có dòng mode='stopped' nào)
-- =============================================================================
