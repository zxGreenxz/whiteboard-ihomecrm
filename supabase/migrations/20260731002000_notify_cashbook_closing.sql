-- =====================================================================
-- PA4 (C/5) — HỌ SỰ KIỆN E6: NHẮC & DẪN NGƯỜI DÙNG QUA NGHI THỨC CHỐT SỔ
--
-- Đây là phần "lực đẩy" của PA4. Nghi thức Đợt 6 đã đủ chức năng nhưng prod 0
-- closure vì không ai được nhắc, và không màn nào cho biết "có đề nghị chờ tôi
-- ký". Ba sự kiện:
--
--   E6a  bàn giao tiền mặt được XÁC NHẬN  → nhắc NGƯỜI GIAO đếm quỹ & chốt sổ
--   E6b  có đề nghị chốt sổ (PENDING)     → gọi NGƯỜI KÝ vào ký
--   E6c  đã chốt xong                     → báo NGƯỜI ĐỀ NGHỊ + link biên bản
--
-- BA NGUYÊN TẮC sao nguyên từ 20260729161000_notify_event_triggers.sql:11-20:
--   1. Trigger tên z95_* để chạy SAU toàn bộ trigger nghiệp vụ.
--   2. SECURITY DEFINER + search_path cố định; EXCEPTION WHEN OTHERS bọc ở CẤP
--      TỪNG NGƯỜI NHẬN, KHÔNG bọc cả thân hàm; luôn RAISE WARNING để không
--      "chết câm". Đây là đường ĐI KÈM bảng tiền — thông báo hỏng KHÔNG được
--      làm hỏng giao dịch chốt sổ.
--   3. channel BẮT BUỘC 'IN_APP' (useNotifications.ts:78,129 đều
--      .eq('channel','IN_APP') — sai channel là VÔ HÌNH), organization_id
--      truyền TƯỜNG MINH.
--
-- KHÔNG thêm giá trị enum notification_type mới: E6a/E6b dùng ACTION_REQUIRED
-- (việc chờ CHÍNH TÔI làm), E6c dùng APPROVAL_RESULT (kết quả việc của tôi).
--
-- KHÔNG sửa propose/confirm_cashbook_closing_v1. Trigger đứng ngoài, nên nếu
-- sau này writer đổi thì thông báo vẫn đúng.
-- =====================================================================

BEGIN;

------------------------------------------------------------------------------
-- 0) NỚI HỌ SỰ KIỆN 'E6' VÀO CẤU HÌNH
--    notification_preferences.event_key CHECK chỉ nhận E1..E5
--    (20260729150000:87). Không nới thì notify_gate_v1 vẫn chạy (tra rỗng ⇒
--    mặc định MỞ) nhưng người dùng KHÔNG TẮT ĐƯỢC E6 — có nút mà không có công
--    tắc là thiết kế nửa vời.
--
--    Ba hàm normalize/read hardcode danh sách khoá. Vá theo nếp nhà của repo:
--    pg_get_functiondef + replace + RAISE nếu không khớp mẫu, thay vì
--    CREATE OR REPLACE từ file (thân hàm trên prod có thể đã trôi so với file
--    migration — án lệ cầu a85).
------------------------------------------------------------------------------

ALTER TABLE public.notification_preferences
  DROP CONSTRAINT IF EXISTS notification_preferences_event_key_ck;
ALTER TABLE public.notification_preferences
  ADD CONSTRAINT notification_preferences_event_key_ck
  CHECK (event_key IN ('E1','E2','E3','E4','E5','E6'));

DO $patch$
DECLARE
  v_src text;
  v_new text;
  v_fn  text;
  v_n   int;
BEGIN
  -- (a) hai hàm normalize — mảng khoá + câu lỗi
  FOREACH v_fn IN ARRAY ARRAY[
    'app_private.notification_events_normalize_v1(jsonb)',
    'app_private.notification_prefs_normalize_v1(jsonb)'
  ] LOOP
    v_src := pg_get_functiondef(v_fn::regprocedure);

    IF position('''E6''' IN v_src) > 0 THEN
      RAISE NOTICE '% đã có E6, bỏ qua', v_fn;
      CONTINUE;
    END IF;

    v_new := replace(
      v_src,
      'array[''E1'',''E2'',''E3'',''E4'',''E5'']',
      'array[''E1'',''E2'',''E3'',''E4'',''E5'',''E6'']');
    v_new := replace(
      v_new,
      'Chỉ nhận E1, E2, E3, E4, E5.',
      'Chỉ nhận E1, E2, E3, E4, E5, E6.');

    IF v_new = v_src THEN
      RAISE EXCEPTION
        'Không tìm thấy mẫu mảng khoá trong % — thân hàm đã đổi, DỪNG thay vì vá bừa', v_fn;
    END IF;
    EXECUTE v_new;
    RAISE NOTICE 'Đã nới % lên E6', v_fn;
  END LOOP;

  -- (b) hàm đọc prefs — danh sách VALUES
  v_src := pg_get_functiondef('app_private.notification_prefs_read_v1(uuid,uuid)'::regprocedure);
  IF position('''E6''' IN v_src) = 0 THEN
    v_new := replace(v_src,
      '(values (''E1''),(''E2''),(''E3''),(''E4''),(''E5''))',
      '(values (''E1''),(''E2''),(''E3''),(''E4''),(''E5''),(''E6''))');
    IF v_new = v_src THEN
      RAISE EXCEPTION 'Không tìm thấy mẫu VALUES trong notification_prefs_read_v1 — DỪNG';
    END IF;
    EXECUTE v_new;
    -- functiondef KHÔNG mang theo ACL ⇒ cấp lại đúng khối gốc (20260729150000:340-343)
    REVOKE ALL ON FUNCTION app_private.notification_prefs_read_v1(uuid,uuid)
      FROM public, anon, authenticated, service_role;
    RAISE NOTICE 'Đã nới notification_prefs_read_v1 lên E6';
  END IF;

  -- (c) cổng sở thích — ánh xạ HỌ. E6a/E6b/E6c phải quy về 'E6' giống cách
  --     E2b/E2c quy về 'E2' (20260729161000:71), nếu không tra ra rỗng.
  v_src := pg_get_functiondef('app_private.notify_gate_v1(uuid,uuid,text,numeric)'::regprocedure);
  IF position('like ''E6%''' IN v_src) = 0 THEN
    v_new := replace(v_src,
      'case when p_event like ''E2%'' then ''E2'' else p_event end',
      'case when p_event like ''E2%'' then ''E2'' when p_event like ''E6%'' then ''E6'' else p_event end');
    IF v_new = v_src THEN
      RAISE EXCEPTION 'Không tìm thấy mẫu ánh xạ họ trong notify_gate_v1 — DỪNG';
    END IF;
    EXECUTE v_new;
    REVOKE ALL ON FUNCTION app_private.notify_gate_v1(uuid,uuid,text,numeric)
      FROM public, anon, authenticated, service_role;
    RAISE NOTICE 'Đã nới notify_gate_v1: mọi E6* quy về họ E6';
  END IF;

  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private'
    AND p.proname IN ('notification_events_normalize_v1','notification_prefs_normalize_v1',
                      'notification_prefs_read_v1','notify_gate_v1')
    AND position('E6' IN pg_get_functiondef(p.oid)) > 0;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'Chỉ %/4 hàm cấu hình biết E6 — nới không trọn, DỪNG', v_n;
  END IF;
END
$patch$;

------------------------------------------------------------------------------
-- 1) BA INDEX DEDUPE. Tên cố định theo mẫu uq_notif_* (20260729161000:31-56).
--    notifications.status NULLABLE ⇒ predicate dùng `status is distinct from 'READ'`.
------------------------------------------------------------------------------

-- E6a: mỗi phiên bàn giao nhắc chốt ĐÚNG MỘT lần cho người giao.
create unique index if not exists uq_notif_closing_nudge
  on public.notifications (user_id, (metadata->>'handover_id'))
  where (metadata->>'event') = 'E6a' and status is distinct from 'READ';

-- E6b: mỗi đề nghị gọi người ký đúng một lần. Đề nghị bị huỷ rồi lập lại sinh
-- request_id MỚI nên vẫn nhắc lại được — đúng ý.
create unique index if not exists uq_notif_closing_request
  on public.notifications (user_id, (metadata->>'request_id'))
  where (metadata->>'event') = 'E6b' and status is distinct from 'READ';

-- E6c: biên bản là append-only, một closure_id chỉ báo một lần. KHÔNG kẹp
-- status ở đây: đọc rồi vẫn không được đẻ dòng thứ hai cho cùng biên bản.
create unique index if not exists uq_notif_closing_done
  on public.notifications (user_id, (metadata->>'closure_id'))
  where (metadata->>'event') = 'E6c';

------------------------------------------------------------------------------
-- 2) E6a — bàn giao ĐÃ XÁC NHẬN ⇒ nhắc NGƯỜI GIAO chốt sổ của mình
--
-- Đúng nhịp vận hành PA4: tiền vừa rời két, người giao còn nhớ số lẻ còn lại
-- trong tay. Đây là thời điểm duy nhất việc đếm quỹ là tự nhiên.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.notify_closing_nudge_v1()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'pg_catalog','app_private','public'
AS $fn$
DECLARE
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_book   record;
  v_ct     date;
  v_recv   text := 'người nhận';
  v_amount text;
  v_in_app boolean;
  v_push   boolean;
BEGIN
  -- SUY ORG, ĐỪNG TIN CỘT: cash_handovers.organization_id nullable, bảng KHÔNG
  -- có trg_autofill_org và create_cash_handover không gán (20260729161000:532-534).
  v_org := coalesce(NEW.organization_id,
                    (select a.organization_id from public.accounts a where a.id = NEW.from_account_id));
  IF v_org IS NULL OR NEW.giver_id IS NULL OR NEW.from_account_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT a.id, a.name, a.is_virtual, a.deleted_at
    INTO v_book
    FROM public.accounts a
   WHERE a.id = NEW.from_account_id;

  -- Sổ ảo (Thối/Làm tròn) không có két ⇒ propose_cashbook_closing_v1 từ chối
  -- thẳng (blocker VIRTUAL_CASHBOOK). Nhắc là dẫn người dùng vào tường.
  IF v_book.id IS NULL OR v_book.deleted_at IS NOT NULL OR COALESCE(v_book.is_virtual,false) THEN
    RETURN NULL;
  END IF;

  -- Đã chốt tới hôm nay rồi thì im. Chống ồn khi một ngày có nhiều phiên.
  v_ct := app_private.cashbook_closed_through_v1(NEW.from_account_id);
  IF v_ct IS NOT NULL AND v_ct >= CURRENT_DATE THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_recv := coalesce(nullif(NEW.receiver_name,''),
                       app_private.notif_actor_label_v1(NEW.receiver_id), 'người nhận');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify E6a: notif_actor_label_v1 lỗi (handover=%): % %', NEW.id, sqlstate, sqlerrm;
    v_recv := coalesce(nullif(NEW.receiver_name,''), 'người nhận');
  END;
  v_amount := replace(to_char(coalesce(NEW.total_amount,0),'FM999,999,999,999'), ',', '.');

  BEGIN
    SELECT g.g_in_app, g.g_push INTO v_in_app, v_push
      FROM app_private.notify_gate_v1(NEW.giver_id, v_org, 'E6a', NEW.total_amount) g;

    IF coalesce(v_in_app, true) THEN
      INSERT INTO public.notifications
        (user_id, organization_id, type, channel, status, subject, content, metadata, push_state)
      VALUES (NEW.giver_id, v_org, 'ACTION_REQUIRED', 'IN_APP', 'PENDING',
              'Đã bàn giao xong — chốt sổ ' || v_book.name || '?',
              v_recv || ' đã nhận ' || v_amount || ' đ (' || coalesce(NEW.code,'—')
                || '). Đếm số còn lại trong két và chốt sổ ' || v_book.name
                || ' để khoá kỳ, kẻo cuối tháng phải dò lại.',
              jsonb_build_object(
                'event','E6a',
                'handover_id', NEW.id::text,
                'cashbook_id', NEW.from_account_id::text,
                'amount', NEW.total_amount,
                'url','/finance/cashbooks?close=' || NEW.from_account_id::text,
                'actor_id', v_actor),
              case when coalesce(v_push,true) then 'QUEUED' else 'SKIPPED' end)
      ON CONFLICT (user_id, (metadata->>'handover_id'))
        WHERE (metadata->>'event') = 'E6a' and status is distinct from 'READ'
      DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify E6a: bỏ qua người nhận % (handover=%): % %',
      NEW.giver_id, NEW.id, sqlstate, sqlerrm;
  END;

  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION app_private.notify_closing_nudge_v1()
  FROM public, anon, authenticated, service_role;

------------------------------------------------------------------------------
-- 3) E6b — có đề nghị chốt sổ chờ TÔI ký
--
-- Đây là mảnh thiếu đã giết nghi thức đối soát thế hệ 1: nó có bước đề nghị
-- nhưng không có màn nào để bên kia bấm (xem CashbookClosingInbox.tsx:1-10).
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.notify_closing_request_v1()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'pg_catalog','app_private','public'
AS $fn$
DECLARE
  v_actor  uuid := auth.uid();
  v_name   text;
  v_who    text := 'người giữ sổ';
  v_amount text;
  v_diff   numeric;
  v_extra  text := '';
  v_in_app boolean;
  v_push   boolean;
BEGIN
  IF NEW.confirmer_user_id IS NULL OR NEW.organization_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT a.name INTO v_name FROM public.accounts a WHERE a.id = NEW.cashbook_id;

  BEGIN
    v_who := coalesce(app_private.notif_actor_label_v1(NEW.proposed_by), 'người giữ sổ');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify E6b: notif_actor_label_v1 lỗi (request=%): % %', NEW.id, sqlstate, sqlerrm;
  END;

  v_amount := replace(to_char(coalesce(NEW.counted_balance,0),'FM999,999,999,999'), ',', '.');
  v_diff   := coalesce(NEW.counted_balance,0) - coalesce(NEW.system_balance,0);
  IF v_diff <> 0 THEN
    v_extra := ' · ' || case when v_diff > 0 then 'THỪA ' else 'THIẾU ' end
               || replace(to_char(abs(v_diff),'FM999,999,999,999'), ',', '.') || ' đ so với sổ';
  END IF;

  BEGIN
    SELECT g.g_in_app, g.g_push INTO v_in_app, v_push
      FROM app_private.notify_gate_v1(NEW.confirmer_user_id, NEW.organization_id, 'E6b',
                                      NEW.counted_balance) g;

    IF coalesce(v_in_app, true) THEN
      INSERT INTO public.notifications
        (user_id, organization_id, type, channel, status, subject, content, metadata, push_state)
      VALUES (NEW.confirmer_user_id, NEW.organization_id, 'ACTION_REQUIRED', 'IN_APP', 'PENDING',
              'Chờ bạn ký chốt sổ ' || coalesce(v_name,'—'),
              v_who || ' đề nghị chốt sổ ' || coalesce(v_name,'—') || ' tới '
                || to_char(NEW.closed_through,'DD/MM/YYYY') || ' — đã đếm ' || v_amount || ' đ'
                || v_extra || '. Ký là kỳ này khoá VĨNH VIỄN.',
              jsonb_build_object(
                'event','E6b',
                'request_id', NEW.id::text,
                'cashbook_id', NEW.cashbook_id::text,
                'amount', NEW.counted_balance,
                'url','/finance/cashbooks?confirm=' || NEW.id::text,
                'actor_id', v_actor),
              case when coalesce(v_push,true) then 'QUEUED' else 'SKIPPED' end)
      ON CONFLICT (user_id, (metadata->>'request_id'))
        WHERE (metadata->>'event') = 'E6b' and status is distinct from 'READ'
      DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify E6b: bỏ qua người nhận % (request=%): % %',
      NEW.confirmer_user_id, NEW.id, sqlstate, sqlerrm;
  END;

  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION app_private.notify_closing_request_v1()
  FROM public, anon, authenticated, service_role;

------------------------------------------------------------------------------
-- 4) E6c — đã chốt xong, gửi biên bản cho người đề nghị
--
-- app_private.cashbook_closures là APPEND-ONLY (trigger a00_..._append_only
-- chặn UPDATE/DELETE/TRUNCATE) ⇒ INSERT = đã ký xong, không cần xét trạng thái.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.notify_closing_done_v1()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'pg_catalog','app_private','public'
AS $fn$
DECLARE
  v_name   text;
  v_signer text := 'bên nhận';
  v_diff   numeric;
  v_body   text;
  v_in_app boolean;
  v_push   boolean;
BEGIN
  IF NEW.proposed_by IS NULL OR NEW.organization_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT a.name INTO v_name FROM public.accounts a WHERE a.id = NEW.cashbook_id;

  BEGIN
    v_signer := coalesce(app_private.notif_actor_label_v1(NEW.confirmed_by), 'bên nhận');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify E6c: notif_actor_label_v1 lỗi (closure=%): % %', NEW.id, sqlstate, sqlerrm;
  END;

  v_diff := coalesce(NEW.counted_balance,0) - coalesce(NEW.system_balance,0);
  v_body := v_signer || ' đã ký nhận sổ ' || coalesce(v_name,'—') || ' tới '
            || to_char(NEW.closed_through,'DD/MM/YYYY') || '. ';
  IF v_diff = 0 THEN
    v_body := v_body || 'Số đếm khớp sổ. Xem biên bản.';
  ELSE
    v_body := v_body || case when v_diff > 0 then 'Thừa quỹ ' else 'Thiếu quỹ ' end
              || replace(to_char(abs(v_diff),'FM999,999,999,999'), ',', '.')
              || ' đ đã được lập phiếu điều chỉnh ngoài KQKD. Xem biên bản.';
  END IF;

  BEGIN
    SELECT g.g_in_app, g.g_push INTO v_in_app, v_push
      FROM app_private.notify_gate_v1(NEW.proposed_by, NEW.organization_id, 'E6c',
                                      NEW.counted_balance) g;

    IF coalesce(v_in_app, true) THEN
      INSERT INTO public.notifications
        (user_id, organization_id, type, channel, status, subject, content, metadata, push_state)
      VALUES (NEW.proposed_by, NEW.organization_id, 'APPROVAL_RESULT', 'IN_APP', 'PENDING',
              'Đã chốt sổ ' || coalesce(v_name,'—'),
              v_body,
              jsonb_build_object(
                'event','E6c',
                'closure_id', NEW.id::text,
                'cashbook_id', NEW.cashbook_id::text,
                'amount', NEW.counted_balance,
                'url','/finance/cashbooks/closure/' || NEW.id::text,
                'actor_id', NEW.confirmed_by),
              case when coalesce(v_push,true) then 'QUEUED' else 'SKIPPED' end)
      ON CONFLICT (user_id, (metadata->>'closure_id'))
        WHERE (metadata->>'event') = 'E6c'
      DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify E6c: bỏ qua người nhận % (closure=%): % %',
      NEW.proposed_by, NEW.id, sqlstate, sqlerrm;
  END;

  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION app_private.notify_closing_done_v1()
  FROM public, anon, authenticated, service_role;

------------------------------------------------------------------------------
-- 5) TRIGGER. Postgres KHÔNG có CREATE TRIGGER IF NOT EXISTS ⇒ mỗi create phải
--    có drop … if exists đứng trước, nếu không chạy lại lần hai là 42710.
------------------------------------------------------------------------------

-- E6a: chỉ nhịp PENDING → CONFIRMED. KHÔNG bắt INSERT (phiên mới đã có E5 lo)
-- và KHÔNG bắt CANCELLED.
DROP TRIGGER IF EXISTS z95_notify_closing_nudge ON public.cash_handovers;
CREATE TRIGGER z95_notify_closing_nudge
AFTER UPDATE OF status ON public.cash_handovers
FOR EACH ROW WHEN (NEW.status = 'CONFIRMED' AND OLD.status = 'PENDING')
EXECUTE FUNCTION app_private.notify_closing_nudge_v1();

DROP TRIGGER IF EXISTS z95_notify_closing_request ON app_private.cashbook_closure_requests;
CREATE TRIGGER z95_notify_closing_request
AFTER INSERT ON app_private.cashbook_closure_requests
FOR EACH ROW WHEN (NEW.status = 'PENDING')
EXECUTE FUNCTION app_private.notify_closing_request_v1();

DROP TRIGGER IF EXISTS z95_notify_closing_done ON app_private.cashbook_closures;
CREATE TRIGGER z95_notify_closing_done
AFTER INSERT ON app_private.cashbook_closures
FOR EACH ROW
EXECUTE FUNCTION app_private.notify_closing_done_v1();

COMMIT;

NOTIFY pgrst, 'reload schema';
