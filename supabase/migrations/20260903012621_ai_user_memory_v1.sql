-- Bộ nhớ dài hạn của Copilot: `public.ai_user_memory` + ba RPC.
--
-- VÌ SAO CÓ BẢNG NÀY
--   Trước lát này Copilot chỉ nhớ trong PHẠM VI MỘT HỘI THOẠI (`ai_chat_threads`
--   / `ai_chat_messages`). Thứ duy nhất sống qua các phiên là
--   `profiles.ui_preferences.copilotModel` — một trường cấu hình, không phải trí
--   nhớ. Nên "toà tôi hay xem là DEMO A" phải nói lại ở mỗi cuộc trò chuyện mới.
--
-- BA RANH GIỚI, VÀ VÌ SAO TỪNG CÁI CÓ MẶT
--
--   1. RIÊNG TỪNG NGƯỜI (RLS own-row). Ghi nhớ là lời người dùng nói về CHÍNH
--      HỌ. Không ai — kể cả người cùng công ty, kể cả chủ công ty — có lý do
--      nghiệp vụ để đọc ghi nhớ của người khác, nên chính sách là
--      `user_id = auth.uid()` chứ không phải một phép kiểm theo tổ chức.
--
--   2. RIÊNG TỪNG CÔNG TY (`organization_id` NOT NULL). Một người có thể thuộc
--      nhiều công ty, và "toà ưu tiên", "cách tôi hay lọc hoá đơn" là những thứ
--      chỉ đúng trong MỘT công ty. Không tách thì ghi nhớ của công ty A rò sang
--      câu trả lời cho công ty B — không phải rò dữ liệu sổ sách, nhưng vẫn là
--      một câu trả lời sai mà người đọc không có cách nào nhận ra.
--
--      Cột này KHÔNG dựa vào `trg_autofill_org_strict`: cả ba RPC đều nêu tường
--      minh `organization_id` (hàm autofill return ngay khi giá trị đã có), và
--      chúng kiểm nó thuộc `public.my_org_ids()` TRƯỚC khi ghi. Suy tổ chức từ
--      `user_id` như nhánh cuối của `_autofill_org` sẽ lấy `LIMIT 1` — tức một
--      công ty bất kỳ trong số các công ty người đó thuộc về.
--
--   3. CÓ TRẦN (30 mục/người/công ty). Trần nằm ở TRIGGER, không chỉ ở RPC. Bảng
--      này cấp DML cho `authenticated` (RLS own-row là hàng rào), nên một trần
--      chỉ viết trong RPC là trần mà PostgREST đi vòng qua được trong một dòng.
--      Trigger đếm các khoá KHÁC `NEW.key`, nên upsert một khoá đã có không bao
--      giờ chạm trần — nếu đếm cả nó thì người dùng đủ 30 mục sẽ không sửa được
--      chính mục họ đang có, một lỗi trông y hệt "hệ thống hỏng".
--
--      VÀ TRẦN PHẢI KHOÁ TRƯỚC KHI ĐẾM. "Đếm rồi chèn" là đọc-rồi-ghi: hai tab
--      của cùng một người chèn gần như đồng thời thì cả hai đếm được 29 rồi cả
--      hai chèn, ra 31. UNIQUE không cứu vì hai khoá khác nhau, và không lỗi nào
--      nổ ra — cái trần lặng lẽ thôi là trần. `pg_advisory_xact_lock` theo
--      (người, công ty) đóng cửa sổ đó mà không bắt hai người khác nhau xếp hàng.
--
--   4. KHÔNG KÝ TỰ ĐIỀU KHIỂN TRONG `value`, cưỡng chế bằng CHECK trên bảng chứ
--      không chỉ trong RPC — cùng lý do với mục 3. Xem đoạn dưới.
--
-- VÌ SAO SECURITY INVOKER, KHÔNG PHẢI DEFINER
--   Ba RPC chỉ đọc/ghi hàng của chính người gọi, và RLS own-row đã nói đúng điều
--   đó ở tầng thấp nhất. Một hàm DEFINER ở đây sẽ TẮT lớp bảo vệ ấy rồi phải tự
--   dựng lại bằng tay `user_id = auth.uid()` trong từng câu lệnh — nhiều chỗ để
--   quên hơn, và quên một chỗ là đọc được ghi nhớ của người khác. INVOKER giữ
--   RLS làm lớp chặn cuối; RPC chỉ thêm phần chuẩn hoá và thông báo lỗi.
--
-- GHI NHỚ LÀ DỮ LIỆU, KHÔNG PHẢI MỆNH LỆNH
--   Nội dung ở đây đi thẳng vào system prompt của Copilot, nên nó là một đường
--   prompt-injection tiềm năng do chính người dùng nạp. Ranh giới ấy được dựng ở
--   phía client (khối "GHI NHỚ CỦA NGƯỜI DÙNG" nói rõ đây là dữ liệu) cộng với
--   trần 500 ký tự ở đây: một đoạn văn dài mới đủ chỗ cho một chỉ thị có sức
--   thuyết phục.
--
--   Lớp thứ ba, và là lớp duy nhất KHÔNG dựa vào chỗ gọi nhớ gọi bộ lọc: CHECK
--   `ai_user_memory_value_ctrl_chk`. Một ký tự xuống dòng trong `value` dựng ra
--   một DÒNG MỚI giữa khối luật của system prompt, trông y hệt luật do hệ thống
--   viết — đúng lỗ hổng mà `giaTriLocAnToan` đã chặn cho đường bộ lọc URL. Bản
--   đầu của client gom khoảng trắng bằng `.replace(/\s+/g, ' ')`, và `\s` của
--   JavaScript KHÔNG bao gồm U+0085 (NEL) hay các mã C1 khác, nên chuỗi đó đi
--   qua nguyên vẹn. Chặn ở tầng dữ liệu thì không có phiên bản client nào quên
--   được.
--
-- NGHIỆM THU CHỈ SOI CATALOG
--   Khối cuối đọc `pg_class`/`pg_proc`/`pg_policy`/ACL, không đọc dữ liệu, nên
--   migration chạy được trên DB rỗng (Restore Drill replay lên baseline
--   schema-only) và chạy được hai lượt liên tiếp.
BEGIN;
SET LOCAL lock_timeout = '15s';

-- 1. Bảng ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_user_memory (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key             text NOT NULL,
  value           text NOT NULL,
  source          text NOT NULL DEFAULT 'copilot',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_user_memory_key_format_chk
    CHECK (key ~ '^[a-z0-9_]{1,40}$'),
  CONSTRAINT ai_user_memory_value_len_chk
    CHECK (char_length(value) BETWEEN 1 AND 500),
  -- KÝ TỰ ĐIỀU KHIỂN BỊ CHẶN Ở CHÍNH BẢNG, không chỉ ở RPC.
  --
  -- Giá trị ở đây đi thẳng vào system prompt của MỌI lượt chat sau. Một ký tự
  -- xuống dòng — hay U+0085 (NEL), thứ mà `\s` của JavaScript KHÔNG bắt — dựng
  -- ra một dòng mới trong khối luật, trông y hệt luật do hệ thống viết. Bảng
  -- này cấp DML cho `authenticated`, nên một phép kiểm chỉ nằm trong RPC là
  -- phép kiểm PostgREST đi vòng qua được trong một dòng, y như trần 30 mục.
  --
  -- U+2028/U+2029 không thuộc C0/C1 nhưng JavaScript coi chúng là ký tự KẾT
  -- THÚC DÒNG, nên chúng ngắt dòng y hệt `\n`.
  CONSTRAINT ai_user_memory_value_ctrl_chk
    CHECK (
      value !~ '[\x00-\x1F\x7F-\x9F]'
      AND position(chr(8232) IN value) = 0
      AND position(chr(8233) IN value) = 0
    ),
  CONSTRAINT ai_user_memory_source_chk
    CHECK (source IN ('user', 'copilot'))
);

-- UNIQUE là thứ làm cho "ghi nhớ" là GHI ĐÈ chứ không phải chồng chất: hỏi lại
-- cùng một khoá phải thay giá trị cũ, không đẻ ra hai câu mâu thuẫn nhau.
CREATE UNIQUE INDEX IF NOT EXISTS ai_user_memory_owner_key_uidx
  ON public.ai_user_memory (user_id, organization_id, key);

CREATE INDEX IF NOT EXISTS ai_user_memory_owner_updated_idx
  ON public.ai_user_memory (user_id, organization_id, updated_at DESC);

COMMENT ON TABLE public.ai_user_memory IS
  'Ghi nhớ dài hạn của Copilot theo NGƯỜI DÙNG và CÔNG TY. RLS own-row; trần 30 mục do trigger cưỡng chế.';

-- 2. Trần 30 mục — cưỡng chế ở TRIGGER ----------------------------------------
CREATE OR REPLACE FUNCTION public.ai_user_memory_cap_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $cap$
DECLARE
  v_khac integer;
BEGIN
  -- KHOÁ TRƯỚC KHI ĐẾM — nếu không, trần 30 là một phép đọc rồi ghi (TOCTOU).
  --
  -- Hai tab của cùng một người, hai lệnh INSERT gần như đồng thời: cả hai đếm
  -- được 29 rồi cả hai chèn, ra 31 mục. UNIQUE không cứu được vì hai khoá KHÁC
  -- nhau, và không lỗi nào nổ ra — chỉ có một cái trần lặng lẽ không phải trần
  -- nữa. Đây không phải giả thuyết xa vời: `ghi_nho` chạy từ khung chat, và
  -- người dùng mở nhiều tab là chuyện thường.
  --
  -- Khoá theo (người, công ty) chứ không khoá cả bảng: hai người khác nhau, hay
  -- cùng một người ở hai công ty, không có lý do gì phải xếp hàng sau nhau.
  -- `pg_advisory_xact_lock` tự nhả khi transaction kết thúc, nên không có đường
  -- nào rò một cái khoá ra ngoài.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.user_id::text || ':' || NEW.organization_id::text, 0)
  );

  -- Đếm các khoá KHÁC: upsert một khoá đã tồn tại không được coi là "thêm mục".
  SELECT count(*) INTO v_khac
    FROM public.ai_user_memory m
   WHERE m.user_id = NEW.user_id
     AND m.organization_id = NEW.organization_id
     AND m.key <> NEW.key;
  IF v_khac >= 30 THEN
    RAISE EXCEPTION 'memory_limit_reached' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$cap$;

REVOKE ALL ON FUNCTION public.ai_user_memory_cap_v1() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_ai_user_memory_cap ON public.ai_user_memory;
CREATE TRIGGER trg_ai_user_memory_cap
  BEFORE INSERT ON public.ai_user_memory
  FOR EACH ROW EXECUTE FUNCTION public.ai_user_memory_cap_v1();

-- 3. RLS own-row --------------------------------------------------------------
ALTER TABLE public.ai_user_memory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_user_memory_own ON public.ai_user_memory;
CREATE POLICY ai_user_memory_own ON public.ai_user_memory
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND organization_id = ANY (public.my_org_ids())
  );

-- Bảng KHÔNG mở cho `anon`; `authenticated` ghi được nhưng chỉ hàng của chính
-- mình, và chỉ trong công ty họ là thành viên (WITH CHECK ở trên).
REVOKE ALL ON TABLE public.ai_user_memory FROM PUBLIC;

DO $acl_bang$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.ai_user_memory FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.ai_user_memory FROM authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_user_memory TO authenticated;
  END IF;
END
$acl_bang$;

-- 4. RPC ----------------------------------------------------------------------
--
-- Ba hàm dùng chung một phần mở đầu: có người đăng nhập, và công ty được truyền
-- vào phải là công ty người đó là thành viên ACTIVE. Không kiểm bước hai thì một
-- người vẫn ghi được ghi nhớ gắn `organization_id` của công ty họ không thuộc —
-- RLS `USING` không chặn (hàng vẫn là của họ), chỉ `WITH CHECK` chặn, và một lỗi
-- RLS trần trụi là thứ không giải thích được cho người dùng.

CREATE OR REPLACE FUNCTION public.copilot_memory_upsert_v1(
  p_organization_id uuid,
  p_key text,
  p_value text,
  -- AI viết mục này: người dùng gõ tay ở mục "Ghi nhớ" ('user'), hay Copilot tự
  -- suy ra từ câu chuyện ('copilot'). Không phải trường trang trí — giao diện
  -- gắn nhãn theo nó, và khối prompt đánh dấu mục 'copilot' để một câu Copilot
  -- nghe nhầm rồi tự ghi lại không mang cùng sức nặng với một câu người dùng
  -- gõ tay. DEFAULT 'copilot' vì đường gọi đông nhất là tool `ghi_nho`.
  p_source text DEFAULT 'copilot'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_key    text := lower(btrim(coalesce(p_key, '')));
  v_value  text := btrim(coalesce(p_value, ''));
  v_source text := lower(btrim(coalesce(p_source, 'copilot')));
  v_tong   integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  IF NOT (p_organization_id = ANY (public.my_org_ids())) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[a-z0-9_]{1,40}$' THEN
    RAISE EXCEPTION 'khoa_khong_hop_le' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_value) < 1 OR char_length(v_value) > 500 THEN
    RAISE EXCEPTION 'noi_dung_khong_hop_le' USING ERRCODE = '22023';
  END IF;
  -- Cùng luật với CONSTRAINT trên bảng, nhưng nêu ở đây để thông báo lỗi nói
  -- được bằng tiếng người thay vì ném tên constraint vào mặt người dùng.
  IF v_value ~ '[\x00-\x1F\x7F-\x9F]'
     OR position(chr(8232) IN v_value) > 0
     OR position(chr(8233) IN v_value) > 0 THEN
    RAISE EXCEPTION 'noi_dung_co_ky_tu_dieu_khien' USING ERRCODE = '22023';
  END IF;
  IF v_source NOT IN ('user', 'copilot') THEN
    RAISE EXCEPTION 'nguon_khong_hop_le' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ai_user_memory (user_id, organization_id, key, value, source)
  VALUES (v_actor, p_organization_id, v_key, v_value, v_source)
  ON CONFLICT (user_id, organization_id, key) DO UPDATE
     SET value = EXCLUDED.value,
         source = EXCLUDED.source,
         updated_at = now();

  SELECT count(*) INTO v_tong
    FROM public.ai_user_memory m
   WHERE m.user_id = v_actor
     AND m.organization_id = p_organization_id;

  RETURN jsonb_build_object('key', v_key, 'value', v_value, 'source', v_source, 'total', v_tong);
END
$fn$;

CREATE OR REPLACE FUNCTION public.copilot_memory_forget_v1(
  p_organization_id uuid,
  p_key text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_key   text := lower(btrim(coalesce(p_key, '')));
  v_so    integer;
  v_tong  integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  IF NOT (p_organization_id = ANY (public.my_org_ids())) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[a-z0-9_]{1,40}$' THEN
    RAISE EXCEPTION 'khoa_khong_hop_le' USING ERRCODE = '22023';
  END IF;

  -- Khoá không tồn tại KHÔNG phải lỗi: người dùng bảo quên một thứ vốn đã quên
  -- thì kết quả họ muốn đã đúng. Trả `found` để chỗ gọi nói câu cho đúng.
  WITH bo AS (
    DELETE FROM public.ai_user_memory m
     WHERE m.user_id = v_actor
       AND m.organization_id = p_organization_id
       AND m.key = v_key
    RETURNING 1
  )
  SELECT count(*) INTO v_so FROM bo;

  SELECT count(*) INTO v_tong
    FROM public.ai_user_memory m
   WHERE m.user_id = v_actor
     AND m.organization_id = p_organization_id;

  RETURN jsonb_build_object('key', v_key, 'found', v_so > 0, 'total', v_tong);
END
$fn$;

CREATE OR REPLACE FUNCTION public.copilot_memory_list_v1(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_rows  jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  IF NOT (p_organization_id = ANY (public.my_org_ids())) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- ORDER BY nằm TRONG `jsonb_agg`, không chỉ trong subquery: thứ tự của một
  -- subquery không phải cam kết của SQL, và ở đây thứ tự là thứ quyết định mục
  -- nào bị cắt khi client chỉ lấy 20 mục đầu cho prompt.
  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'key', s.key,
               'value', s.value,
               'source', s.source,
               'updated_at', s.updated_at
             )
             ORDER BY s.updated_at DESC
           ),
           '[]'::jsonb
         )
    INTO v_rows
    FROM (
      SELECT m.key, m.value, m.source, m.updated_at
        FROM public.ai_user_memory m
       WHERE m.user_id = v_actor
         AND m.organization_id = p_organization_id
       ORDER BY m.updated_at DESC
       LIMIT 30
    ) s;

  RETURN jsonb_build_object('items', v_rows);
END
$fn$;

-- 5. ACL của RPC --------------------------------------------------------------
--
-- REVOKE FROM PUBLIC KHÔNG cắt `anon` trên Supabase: `anon` và `authenticated`
-- giữ grant riêng, nên mọi vai được nêu đích danh. `to_regrole` cho phép khối
-- này chạy trên cluster trần chưa có hai vai đó.
REVOKE ALL ON FUNCTION public.copilot_memory_upsert_v1(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_memory_forget_v1(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_memory_list_v1(uuid) FROM PUBLIC;

DO $acl$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_memory_upsert_v1(uuid, text, text, text) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_memory_forget_v1(uuid, text) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_memory_list_v1(uuid) FROM anon;
  END IF;

  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_memory_upsert_v1(uuid, text, text, text) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_memory_forget_v1(uuid, text) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_memory_list_v1(uuid) FROM authenticated;

    GRANT EXECUTE ON FUNCTION public.copilot_memory_upsert_v1(uuid, text, text, text) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_memory_forget_v1(uuid, text) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_memory_list_v1(uuid) TO authenticated;
  END IF;
END
$acl$;

COMMENT ON FUNCTION public.copilot_memory_upsert_v1(uuid, text, text, text) IS
  'Ghi/ghi đè MỘT ghi nhớ của chính người gọi trong công ty đã chọn; trần 30 mục do trigger cưỡng chế.';
COMMENT ON FUNCTION public.copilot_memory_forget_v1(uuid, text) IS
  'Bỏ MỘT ghi nhớ của chính người gọi theo khoá; khoá không có thì trả found=false, không báo lỗi.';
COMMENT ON FUNCTION public.copilot_memory_list_v1(uuid) IS
  'Liệt kê tối đa 30 ghi nhớ mới nhất của chính người gọi trong công ty đã chọn.';

-- 6. Nghiệm thu: chỉ soi catalog ----------------------------------------------
DO $nghiem_thu$
DECLARE
  v_sig text;
  v_thieu text[] := '{}'::text[];
  v_ho text[] := '{}'::text[];
BEGIN
  IF to_regclass('public.ai_user_memory') IS NULL THEN
    RAISE EXCEPTION 'ai_user_memory missing after apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid = 'public.ai_user_memory'::regclass AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'ai_user_memory does not have RLS enabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.ai_user_memory'::regclass
       AND p.polname = 'ai_user_memory_own'
  ) THEN
    RAISE EXCEPTION 'ai_user_memory own-row policy missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.ai_user_memory'::regclass
       AND t.tgname = 'trg_ai_user_memory_cap'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'ai_user_memory cap trigger missing — tran 30 muc khong duoc cuong che';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.ai_user_memory'::regclass
       AND c.conname = 'ai_user_memory_value_ctrl_chk'
       AND c.contype = 'c'
  ) THEN
    RAISE EXCEPTION 'ai_user_memory control-character CHECK missing — system prompt khong con duoc canh o tang du lieu';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'public.ai_user_memory'::regclass
       AND i.indisunique
       AND i.indexrelid = 'public.ai_user_memory_owner_key_uidx'::regclass
  ) THEN
    RAISE EXCEPTION 'ai_user_memory unique (user, org, key) missing';
  END IF;

  IF to_regrole('anon') IS NOT NULL
     AND has_table_privilege('anon', 'public.ai_user_memory', 'SELECT') THEN
    RAISE EXCEPTION 'ai_user_memory is readable by anon';
  END IF;

  FOREACH v_sig IN ARRAY ARRAY[
    'public.copilot_memory_upsert_v1(uuid, text, text, text)',
    'public.copilot_memory_forget_v1(uuid, text)',
    'public.copilot_memory_list_v1(uuid)'
  ]
  LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      v_thieu := v_thieu || v_sig;
    ELSIF to_regrole('anon') IS NOT NULL
      AND has_function_privilege('anon', to_regprocedure(v_sig)::oid, 'EXECUTE') THEN
      v_ho := v_ho || v_sig;
    END IF;
  END LOOP;

  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'copilot memory RPC missing after apply: %', array_to_string(v_thieu, ', ');
  END IF;
  IF cardinality(v_ho) > 0 THEN
    RAISE EXCEPTION 'copilot memory RPC is anon-executable: %', array_to_string(v_ho, ', ');
  END IF;

  IF to_regprocedure('public.my_org_ids()') IS NULL THEN
    RAISE EXCEPTION 'my_org_ids missing — 20260713121000 must run first';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
