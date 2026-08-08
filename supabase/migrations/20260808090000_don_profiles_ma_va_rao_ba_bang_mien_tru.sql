-- =============================================================================
-- Dọn 7 dòng profiles ma + rào biên giới cho roles / settings / profiles
--
-- Ba bảng này nằm trong sổ miễn trừ `app_private.org_boundary_exemptions` với
-- hạn 30/11. Sổ đó ghi lý do bằng SỐ ĐO của ngày 07/08 — và số đo đã đổi, vì
-- hai tổ chức Test/Demo bị xoá (20260808080000) và bộ đo rò được sửa để tự dựng
-- tổ chức tổng hợp (thay vì dựa vào chính hai tổ chức rác đó).
--
-- ĐO LẠI 08/08 bằng bộ đo mới — nhân vật "tổ chức VỪA SINH RA, chưa có một dòng
-- nào", nên mọi dòng nó thấy đều là rò, không cần diễn giải:
--
--   bảng                | người thật (bosshuy) | tổ chức vừa sinh
--   roles               | 5 của mình / 0 ngoài | 0 / 0
--   settings            | 5 / 0                | 0 / 0
--   profiles            | 4 / 0                | 2 / 1  ← còn rò
--   ai_providers        | 10 / 0               | 10 / 10
--   ai_copilot_settings | 1 / 0                | 1 / 1
--
-- roles và settings KHÔNG còn rò. Lý do miễn trừ cũ ("bản ghi theo người",
-- "demo.chunha 7 → 2") nói về dữ liệu của hai tổ chức nay đã không còn. Kế hoạch
-- từng phỏng đoán "miễn trừ hiện tại có thể đang quá thận trọng"; nay đo được.
--
-- ai_providers và ai_copilot_settings thì KHÔNG đụng tới: chúng thật sự là bảng
-- dùng chung toàn hệ (một cái khoá chính là PRIMARY KEY(provider), cái kia là
-- PRIMARY KEY(id boolean) nên cả CSDL tối đa 2 dòng). Rào chúng là giết Copilot.
-- Miễn trừ của hai bảng đó giữ nguyên.
--
-- ------------------------- profiles: LỖI DỮ LIỆU ----------------------------
--
-- profiles còn rò, nhưng gốc không phải thiếu biên giới mà là NHÃN SAI — đúng
-- như sổ miễn trừ đã ghi. Đo hôm nay: 7 trong 11 dòng mang
-- organization_id = aaaa (CÔNG TY THẬT) trong khi chủ nhân KHÔNG có membership
-- nào. Tức danh sách nhân sự của công ty thật đang có 7 người ma:
--   • 6 tài khoản demo.* — tổ chức Demo của họ đã bị xoá hôm nay
--   • phanboichauthcs@gmail.com — đăng ký 26/04, đăng nhập đúng một lần ngày
--     tạo, không quay lại
-- Cả 7 đều: 0 membership, 0 việc, 0 hoá đơn, 0 hợp đồng, không phải super admin.
--
-- Lỗi này CÓ TRƯỚC việc xoá hôm nay, không phải do nó gây ra.
--
-- VÌ SAO XOÁ CHỨ KHÔNG ĐẶT organization_id = NULL: công thức biên giới là
-- `organization_id IS NULL OR is_super_admin() OR organization_id IN my_org_ids()`
-- — NULL nghĩa là AI CŨNG THẤY. Đặt NULL để "gỡ nhãn sai" sẽ biến 7 dòng từ
-- "thuộc nhầm một công ty" thành "thuộc về tất cả", tệ hơn hẳn.
-- KHÔNG đụng auth.users: 7 tài khoản vẫn còn, chỉ mất dòng profile. Đó là quyết
-- định riêng, không gộp vào đây.
--
-- Xoá 7 dòng đó xong thì MỌI dòng profiles còn lại đều có membership ACTIVE
-- khớp org của mình — và đó chính là điều kiện làm cho việc rào profiles trở nên
-- an toàn. Sổ miễn trừ ghi "demo.chunha MẤT CHÍNH DÒNG CỦA MÌNH (own 1 → 0)":
-- đúng vào thời điểm đó, vì dòng của cô ấy mang nhãn sai. Hết nhãn sai thì hết
-- tác dụng phụ.
-- =============================================================================

BEGIN;

DO $preflight$
DECLARE
  v_n     bigint;
  v_null  bigint;
  r       record;
BEGIN
  -- (1) 7 dòng sắp xoá phải THẬT SỰ trống. Chốt này là thứ làm cho file an toàn
  --     THEO CẤU TRÚC chứ không theo lời hứa: nếu tới lúc apply mà một trong
  --     bảy người đã được cấp membership hoặc đã tạo dữ liệu, file DỪNG.
  SELECT count(*) INTO v_n
    FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.organization_memberships m
                      WHERE m.user_id = p.id AND m.status = 'ACTIVE'
                        AND m.organization_id = p.organization_id)
     AND (EXISTS (SELECT 1 FROM public.organization_memberships m WHERE m.user_id = p.id)
       OR EXISTS (SELECT 1 FROM public.jobs j            WHERE j.user_id = p.id)
       OR EXISTS (SELECT 1 FROM public.invoices i        WHERE i.user_id = p.id)
       OR EXISTS (SELECT 1 FROM public.contracts c       WHERE c.user_id = p.id)
       OR EXISTS (SELECT 1 FROM public.super_admins s    WHERE s.user_id = p.id));
  IF v_n > 0 THEN
    RAISE EXCEPTION '% trong số dòng profiles sai nhãn có membership hoặc dữ liệu nghiệp vụ — không phải người ma. DỪNG.', v_n;
  END IF;

  -- (2) Số dòng sai nhãn phải đúng bằng thứ đã đo. Lệch nghĩa là dữ liệu đã đổi
  --     giữa lúc đo và lúc chạy, và mọi lập luận ở trên phải được đo lại.
  SELECT count(*) INTO v_n
    FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.organization_memberships m
                      WHERE m.user_id = p.id AND m.status = 'ACTIVE'
                        AND m.organization_id = p.organization_id);
  IF v_n <> 7 THEN
    RAISE EXCEPTION 'Đo được % dòng profiles sai nhãn, kỳ vọng 7. Dữ liệu đã đổi — đo lại trước khi chạy. DỪNG.', v_n;
  END IF;

  -- (3) roles không được có dòng organization_id NULL, vì NULL lọt qua biên giới.
  SELECT count(*) INTO v_null FROM public.roles WHERE organization_id IS NULL;
  IF v_null > 0 THEN
    RAISE EXCEPTION 'roles còn % dòng organization_id NULL — rào xong chúng vẫn ai cũng thấy. DỪNG.', v_null;
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- settings: vá dòng organization_id NULL TRƯỚC khi rào.
-- Rào mà để NULL thì dòng đó lọt qua biên giới (nhánh IS NULL) — rào hình thức.
-- ---------------------------------------------------------------------------
DO $settings_null$
DECLARE
  v_n bigint;
BEGIN
  UPDATE public.settings s
     SET organization_id = m.org
    FROM (SELECT user_id, (array_agg(organization_id))[1] AS org
            FROM public.organization_memberships
           WHERE status = 'ACTIVE'
           GROUP BY user_id
          HAVING count(DISTINCT organization_id) = 1) m
   WHERE m.user_id = s.user_id AND s.organization_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'settings: điền organization_id cho % dòng theo membership của chính chủ.', v_n;

  SELECT count(*) INTO v_n FROM public.settings WHERE organization_id IS NULL;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'settings còn % dòng organization_id NULL không suy được từ membership — rào lúc này là rào hình thức. DỪNG.', v_n;
  END IF;
END
$settings_null$;

-- ---------------------------------------------------------------------------
-- Xoá 7 dòng profiles ma.
-- ---------------------------------------------------------------------------
DO $don_profiles$
DECLARE
  v_n bigint;
BEGIN
  DELETE FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.organization_memberships m
                      WHERE m.user_id = p.id AND m.status = 'ACTIVE'
                        AND m.organization_id = p.organization_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Đã xoá % dòng profiles không có membership ACTIVE khớp nhãn tổ chức.', v_n;

  SELECT count(*) INTO v_n
    FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.organization_memberships m
                      WHERE m.user_id = p.id AND m.status = 'ACTIVE'
                        AND m.organization_id = p.organization_id);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Còn % dòng profiles sai nhãn sau khi dọn. DỪNG.', v_n;
  END IF;
END
$don_profiles$;

-- ---------------------------------------------------------------------------
-- Rào biên giới. Công thức chép ĐÚNG bản đang chạy trên 297 bảng khác — không
-- sáng tác biến thể, vì lệch một nhánh là lệch nghĩa trên toàn hệ.
-- ---------------------------------------------------------------------------
DO $rao$
DECLARE
  b text;
BEGIN
  FOREACH b IN ARRAY ARRAY['roles','settings','profiles'] LOOP
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
-- Rút ba bảng khỏi sổ miễn trừ. Rào rồi mà vẫn để trong sổ thì sổ nói dối, và
-- gate đọc sổ sẽ bỏ qua đúng những bảng vừa được rào.
-- ---------------------------------------------------------------------------
DELETE FROM app_private.org_boundary_exemptions
 WHERE table_name IN ('roles','settings','profiles');

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — đo HAI MỆNH ĐỀ bằng chính vai người dùng thật, ngay trong
-- transaction này. Chỉ hỏi "hết rò chưa" là chưa đủ: rào sạch mọi người cũng
-- cho ra 0 rò, và đó là cách hỏng tệ nhất vì nó trông giống thành công.
-- ---------------------------------------------------------------------------
DO $chuan_bi$
BEGIN
  CREATE TEMP TABLE _nt(bang text, so bigint);
  GRANT INSERT, SELECT ON _nt TO PUBLIC;
END
$chuan_bi$;

CREATE FUNCTION pg_temp._dem() RETURNS void LANGUAGE plpgsql AS $d$
DECLARE b text; v bigint;
BEGIN
  FOREACH b IN ARRAY ARRAY['roles','settings','profiles'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', b) INTO v;
    INSERT INTO _nt VALUES (b, v);
  END LOOP;
END $d$;

DO $nghiem_thu$
DECLARE
  v_uid uuid;
  v_n   bigint;
  b     text;
BEGIN
  -- Người thật để giả lập: suy TỪ DATABASE, không hard-code — người có thể nghỉ.
  SELECT m.user_id INTO v_uid
    FROM public.organization_memberships m
   WHERE m.status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = m.user_id)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = m.user_id)
   ORDER BY m.user_id
   LIMIT 1;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Không tìm được người dùng thường nào để nghiệm thu. DỪNG.';
  END IF;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp._dem();
  RESET ROLE;

  FOREACH b IN ARRAY ARRAY['roles','settings','profiles'] LOOP
    SELECT so INTO v_n FROM _nt WHERE bang = b;
    IF v_n IS NULL OR v_n = 0 THEN
      RAISE EXCEPTION 'Sau khi rào, người dùng thường KHÔNG còn thấy dòng nào ở % — rào đã cắt mất dữ liệu của chính chủ. DỪNG.', b;
    END IF;
    RAISE NOTICE 'Nghiệm thu %: người dùng thường vẫn thấy % dòng.', b, v_n;
  END LOOP;

  -- Ba bảng phải có biên giới thật, đúng dạng RESTRICTIVE FOR ALL.
  SELECT count(*) INTO v_n
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname IN ('roles','settings','profiles')
     AND p.polname = c.relname || '_org_boundary'
     AND p.polpermissive = false AND p.polcmd = '*';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'Chỉ %/3 bảng có biên giới đúng dạng RESTRICTIVE FOR ALL. DỪNG.', v_n;
  END IF;

  -- Và phải hết tên trong sổ miễn trừ.
  SELECT count(*) INTO v_n FROM app_private.org_boundary_exemptions
   WHERE table_name IN ('roles','settings','profiles');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Còn % bảng vừa rào nhưng vẫn nằm trong sổ miễn trừ — sổ đang nói dối. DỪNG.', v_n;
  END IF;
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- SAU KHI CHẠY: node scripts/measure-org-leak.mjs --write
--   Kỳ vọng: chỉ còn ai_providers(10) và ai_copilot_settings(1) trong danh sách
--   rò đã khai — profiles biến mất khỏi đó.
--
-- ROLLBACK: file này XOÁ 7 dòng profiles, không có đường lùi tự động. Khôi phục
-- từ bản dump lane tự chụp ngay trước lúc apply. 7 tài khoản auth.users KHÔNG bị
-- đụng nên có thể tạo lại profile bằng đường đăng nhập bình thường.
-- =============================================================================
