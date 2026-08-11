-- =============================================================================
-- ai_providers / ai_copilot_settings: gỡ nhãn tổ chức SAI, rồi rào biên giới
--
-- Hai bảng này là hai dòng cuối cùng trong sổ miễn trừ, hạn 30/11. Kế hoạch xếp
-- chúng vào loại "câu hỏi MÔ HÌNH — bảng này thuộc về ai?" và ghi rằng chỉ trả
-- lời được khi có công ty thứ hai. ĐO RA LÀ KHÔNG CẦN: chính khoá chính của
-- chúng đã trả lời.
--
--   ai_providers        PRIMARY KEY (provider)   ⇒ toàn CSDL chỉ có MỘT dòng cho
--                                                  mỗi tên provider. Không thể
--                                                  có "openrouter của công ty A"
--                                                  và "openrouter của công ty B".
--   ai_copilot_settings PRIMARY KEY (id boolean) ⇒ toàn CSDL tối đa HAI dòng.
--
-- Nội dung cũng nói đúng điều đó: ai_providers là DANH MỤC nhà cung cấp LLM
-- (OpenRouter, OpenAI, Qwen, Gemini, Mock) kèm danh sách model và đơn giá —
-- không có gì thuộc về một công ty. ai_copilot_settings là một dòng singleton
-- chứa chat_enabled, rate_per_min, daily_usd_cap_*.
--
-- VẬY MÀ MỌI DÒNG ĐỀU MANG organization_id = aaaa (công ty thật). Đó là NHÃN
-- SAI, cùng lớp lỗi với 7 dòng profiles ma đã dọn ở 20260808090000: một cột
-- được điền cho đủ chứ không vì dữ liệu thuộc về ai.
--
-- Nhãn sai đó chính là thứ làm bộ đo báo "rò": tổ chức nào khác cũng đọc được
-- 10 dòng mang nhãn của aaaa. Nhưng đọc được là ĐÚNG — đây là danh mục dùng
-- chung. Cái sai là cái nhãn, không phải cái quyền đọc.
--
-- ------------------------------- CÁCH XỬ ------------------------------------
--
-- 1. Đặt organization_id = NULL. Công thức biên giới có nhánh
--    `organization_id IS NULL` nghĩa là AI CŨNG THẤY — với dữ liệu toàn hệ thì
--    đó chính là ngữ nghĩa đúng, không phải lỗ hổng.
--
--    (Ngược hẳn với profiles ở 20260808090000, nơi đặt NULL là SAI vì dòng
--    profile thật sự thuộc về một người trong một tổ chức. Cùng một thao tác,
--    đúng hay sai tuỳ dữ liệu thuộc về ai — nên phải hỏi câu đó trước.)
--
-- 2. RÀO biên giới cho cả hai bảng. Nghe ngược đời khi vừa đặt NULL, nhưng đây
--    mới là phần có giá trị lâu dài: hôm nay mọi dòng NULL nên ai cũng thấy,
--    còn NGÀY MAI ai đó thêm một dòng CÓ nhãn tổ chức thì nó tự động bị giới
--    hạn đúng tổ chức đó. Miễn trừ thì không làm được điều này — nó tắt hẳn
--    việc kiểm tra.
--
-- 3. Rút khỏi sổ miễn trừ. Sổ miễn trừ hết sạch dòng.
--
-- KHÔNG bỏ hẳn cột organization_id, dù khoá chính khiến nó vô dụng hôm nay: giữ
-- cột lại thì bước 2 mới có chỗ bám, và nếu sau này mô hình đổi (mỗi công ty một
-- bộ provider riêng) thì đường đi đã sẵn. Bỏ cột là đóng cửa đó lại.
--
-- Đường GHI không bị ảnh hưởng: AiCopilotAdminPage.tsx chỉ .update() các trường
-- cấu hình, không đụng organization_id; hai bảng không có trigger nào (đã kiểm
-- pg_trigger, kết quả rỗng) nên không có gì tự điền lại nhãn.
-- =============================================================================

BEGIN;

-- Lane đặt lock_timeout = 5s cho mọi migration. Hợp lý làm mặc định, nhưng quá
-- ngắn cho DDL cần ACCESS EXCLUSIVE trên bảng đang có người đọc: lần apply đầu
-- chết đúng ở `DROP POLICY ... ON ai_providers` với 55P03 vì một phiên qua
-- Supavisor đang đọc bảng đó.
--
-- 15s là mức có cân nhắc, không phải con số tuỳ tiện: đủ để vượt một truy vấn
-- đọc thoáng qua, mà nếu có thứ gì ôm khoá lâu hơn thế thì DỪNG mới đúng — nới
-- vô hạn là biến một lỗi đọc được thành một cú treo cả bảng cấu hình AI.
SET LOCAL lock_timeout = '15s';

DO $preflight$
DECLARE
  v_n bigint;
BEGIN
  -- Khoá chính phải đúng như lập luận ở trên. Nếu ai đó đã đổi PK thành
  -- (organization_id, provider) thì mô hình đã khác và toàn bộ file này sai.
  SELECT count(*) INTO v_n
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
   WHERE k.contype = 'p' AND c.relnamespace = 'public'::regnamespace
     AND ((c.relname = 'ai_providers'        AND pg_get_constraintdef(k.oid) = 'PRIMARY KEY (provider)')
       OR (c.relname = 'ai_copilot_settings' AND pg_get_constraintdef(k.oid) = 'PRIMARY KEY (id)'));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'Khoá chính của hai bảng AI không còn như lúc phân tích (khớp %/2) — mô hình đã đổi, đọc lại trước khi chạy. DỪNG.', v_n;
  END IF;

  -- Không được có trigger tự điền lại nhãn sau khi ta gỡ.
  SELECT count(*) INTO v_n
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('ai_providers', 'ai_copilot_settings');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Hai bảng AI nay có % trigger — có thể tự điền lại organization_id sau khi gỡ. Đọc lại trước khi chạy. DỪNG.', v_n;
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. Gỡ nhãn tổ chức sai.
-- ---------------------------------------------------------------------------
DO $go_nhan$
DECLARE
  v_a bigint;
  v_b bigint;
BEGIN
  UPDATE public.ai_providers SET organization_id = NULL WHERE organization_id IS NOT NULL;
  GET DIAGNOSTICS v_a = ROW_COUNT;
  UPDATE public.ai_copilot_settings SET organization_id = NULL WHERE organization_id IS NOT NULL;
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RAISE NOTICE 'Đã gỡ nhãn tổ chức: ai_providers % dòng, ai_copilot_settings % dòng.', v_a, v_b;
END
$go_nhan$;

-- ---------------------------------------------------------------------------
-- 2. Rào biên giới. Công thức chép ĐÚNG bản đang chạy trên 300 bảng khác.
-- ---------------------------------------------------------------------------
DO $rao$
DECLARE b text;
BEGIN
  FOREACH b IN ARRAY ARRAY['ai_providers','ai_copilot_settings'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', b || '_org_boundary', b);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING (organization_id IS NULL OR (SELECT public.is_super_admin()) '
      '       OR organization_id IN (SELECT unnest(public.my_org_ids()))) '
      'WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) '
      '       OR organization_id IN (SELECT unnest(public.my_org_ids())))',
      b || '_org_boundary', b);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', b);
    RAISE NOTICE 'Đã rào biên giới tổ chức cho %.', b;
  END LOOP;
END
$rao$;

-- ---------------------------------------------------------------------------
-- 3. Rút khỏi sổ miễn trừ.
-- ---------------------------------------------------------------------------
DELETE FROM app_private.org_boundary_exemptions
 WHERE table_name IN ('ai_providers','ai_copilot_settings');

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — đo HAI MỆNH ĐỀ bằng một tổ chức VỪA SINH RA, dựng ngay trong
-- transaction này rồi biến mất theo COMMIT... không, theo chính phép xoá ở cuối
-- khối. Mệnh đề quan trọng nhất KHÔNG phải "hết rò" mà là "Copilot còn sống":
-- rào sai thì ô chọn model rỗng trắng và không ai dùng được Copilot nữa.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_uid  uuid := '99999999-0000-4000-8000-0000000000aa';
  v_org  uuid := '99990000-0000-4000-8000-0000000000aa';
  v_prov bigint;
  v_bat  bigint;
  v_ro   bigint;
  v_n    bigint;
BEGIN
  -- Không còn dòng nào mang nhãn tổ chức.
  SELECT (SELECT count(*) FROM public.ai_providers        WHERE organization_id IS NOT NULL)
       + (SELECT count(*) FROM public.ai_copilot_settings WHERE organization_id IS NOT NULL)
    INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Còn % dòng mang nhãn tổ chức sau khi gỡ. DỪNG.', v_n;
  END IF;

  -- Hai bảng phải có biên giới đúng dạng.
  SELECT count(*) INTO v_n
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname IN ('ai_providers','ai_copilot_settings')
     AND p.polname = c.relname || '_org_boundary'
     AND p.polpermissive = false AND p.polcmd = '*';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'Chỉ %/2 bảng có biên giới đúng dạng RESTRICTIVE FOR ALL. DỪNG.', v_n;
  END IF;

  -- Sổ miễn trừ phải sạch tên hai bảng này.
  SELECT count(*) INTO v_n FROM app_private.org_boundary_exemptions
   WHERE table_name IN ('ai_providers','ai_copilot_settings');
  IF v_n > 0 THEN
    RAISE EXCEPTION '% bảng vừa rào vẫn nằm trong sổ miễn trừ — sổ đang nói dối. DỪNG.', v_n;
  END IF;

  -- Dựng một tổ chức mới tinh và soi bằng đúng vai authenticated.
  INSERT INTO auth.users (id) VALUES (v_uid);
  INSERT INTO public.organizations (id, slug, name)
  VALUES (v_org, 'zz-nghiem-thu-ai', 'ZZ nghiệm thu bảng AI');
  INSERT INTO public.organization_memberships (organization_id, user_id, member_type, status)
  VALUES (v_org, v_uid, 'STAFF', 'ACTIVE');

  CREATE TEMP TABLE _nt(k text, v bigint);
  GRANT INSERT, SELECT ON _nt TO PUBLIC;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO _nt
  SELECT 'provider_thay', count(*) FROM public.ai_providers
  UNION ALL
  SELECT 'provider_bat',  count(*) FROM public.ai_providers WHERE enabled
  UNION ALL
  SELECT 'setting_thay',  count(*) FROM public.ai_copilot_settings
  UNION ALL
  SELECT 'con_ro',        count(*) FROM public.ai_providers
                           WHERE organization_id IS NOT NULL AND organization_id <> v_org;
  RESET ROLE;

  SELECT v INTO v_prov FROM _nt WHERE k = 'provider_thay';
  SELECT v INTO v_bat  FROM _nt WHERE k = 'provider_bat';
  SELECT v INTO v_n    FROM _nt WHERE k = 'setting_thay';
  SELECT v INTO v_ro   FROM _nt WHERE k = 'con_ro';

  -- MỆNH ĐỀ 1 — Copilot còn sống. Đây là vế dễ mất nhất: án lệ đã ghi
  -- "demo.chunha 10 → 0, lọc enabled=true → 0 nên ô chọn model rỗng trắng".
  IF v_prov = 0 OR v_bat = 0 THEN
    RAISE EXCEPTION 'Tổ chức mới thấy % provider (% đang bật) — Copilot sẽ có ô chọn model rỗng. DỪNG.', v_prov, v_bat;
  END IF;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Tổ chức mới thấy % dòng ai_copilot_settings (cần đúng 1) — maybeSingle() sẽ trả null. DỪNG.', v_n;
  END IF;

  -- MỆNH ĐỀ 2 — không dòng nào của tổ chức KHÁC lọt sang.
  IF v_ro > 0 THEN
    RAISE EXCEPTION 'Tổ chức mới thấy % dòng mang nhãn tổ chức khác. DỪNG.', v_ro;
  END IF;

  RAISE NOTICE 'Nghiệm thu đạt: tổ chức vừa sinh ra thấy % provider (% bật) và 1 dòng cấu hình, 0 dòng mang nhãn tổ chức khác.', v_prov, v_bat;

  -- Dọn sạch tổ chức nghiệm thu — file này COMMIT nên không có ROLLBACK đỡ.
  DELETE FROM public.organization_memberships WHERE user_id = v_uid;
  DELETE FROM public.organizations WHERE id = v_org;
  DELETE FROM auth.users WHERE id = v_uid;
  DROP TABLE _nt;

  SELECT count(*) INTO v_n FROM public.organizations WHERE id = v_org;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Tổ chức nghiệm thu chưa được dọn. DỪNG.';
  END IF;
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- SAU KHI CHẠY: node scripts/measure-org-leak.mjs --write
--   Kỳ vọng: danh sách "rò đã khai trong sổ miễn trừ" RỖNG, và sổ miễn trừ hết
--   sạch dòng.
--
-- ROLLBACK: file này đổi DỮ LIỆU (gỡ nhãn) và POLICY. Muốn lùi thì đặt lại
-- organization_id = 'aaaa0000-0000-4000-8000-000000000001' cho hai bảng, DROP
-- hai policy *_org_boundary, và INSERT lại hai dòng miễn trừ. Bản dump lane tự
-- chụp ngay trước lúc apply là đường lùi đầy đủ.
-- =============================================================================
