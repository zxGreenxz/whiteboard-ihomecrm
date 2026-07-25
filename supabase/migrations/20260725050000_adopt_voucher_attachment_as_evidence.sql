-- Finance V2 — 7ai: dùng LUÔN ảnh đính kèm của phiếu làm CHỨNG TỪ chi.
--
-- OWNER BÁO (25/07): "ảnh có sẵn tôi bấm vào vẫn bắt thêm ảnh — nó không hiểu là
-- tôi muốn dùng ảnh có sẵn làm chứng từ luôn. Nếu có kèm ảnh thì ảnh đó là ảnh
-- chứng từ, cần bổ sung thì thêm mới, không thì bấm lưu luôn."
--
-- VÌ SAO TRƯỚC ĐÂY KHÔNG DÙNG ĐƯỢC
--   Hai khái niệm khác nhau ở tầng dữ liệu:
--     • income_expenses.attachments — mảng URL file của phiếu (người tạo đính kèm);
--     • finance_evidence_objects    — bản ghi CHỨNG TỪ có vòng đời
--       UPLOAD_INTENT → FINALIZED → ATTACHED, và finance_v2_post_manual_voucher
--       đòi "ít nhất 1 evidence FINALIZED đúng tenant".
--   Ảnh đính kèm không có bản ghi evidence ⇒ không đếm là chứng từ.
--   MAY MẮN: cả hai dùng CHUNG bucket 'income-expense-attachments' nên chỉ cần
--   lập bản ghi evidence trỏ vào đúng file đã có, KHÔNG phải upload lại.
--
-- RPC MỚI: adopt_voucher_attachments_as_evidence_v2(p_voucher)
--   Nhận diện file từ URL công khai đang lưu trong attachments
--   (…/storage/v1/object/public/<bucket>/<object>), kiểm file CÓ THẬT trong
--   storage.objects, rồi lập/lấy bản ghi evidence FINALIZED cho từng ảnh.
--
-- RÀO CHẮN
--   • Actor phải có membership ACTIVE trong ĐÚNG org của phiếu (chống chéo tenant).
--   • Chỉ nhận file NẰM TRONG attachments của CHÍNH phiếu đó — không cho trỏ bừa
--     vào object khác trong bucket.
--   • Bucket giới hạn allowlist.
--   • KHÔNG đòi owner = auth.uid(): người đính kèm (người lập phiếu) thường khác
--     người chi (thủ quỹ) — đó là luồng bình thường, không phải lỗ hổng, vì ràng
--     buộc thật nằm ở "file thuộc phiếu này".
--   • Evidence đã ở trạng thái ATTACHED (đã dùng cho lần ghi sổ trước) thì BỎ QUA
--     và báo lý do — mỗi lần ghi sổ cần chứng từ riêng, đúng thiết kế one-shot.
--   • Chỉ ĐỌC storage + ghi bản ghi evidence. Không đụng tiền, không đụng phiếu.

BEGIN;

CREATE OR REPLACE FUNCTION public.adopt_voucher_attachments_as_evidence_v2(
  p_voucher uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_ie      public.income_expenses;
  v_actor   record;
  v_url     text;
  v_prefix  text := '/storage/v1/object/public/';
  v_pos     integer;
  v_path    text;
  v_bucket  text;
  v_object  text;
  v_meta    jsonb;
  v_row     public.finance_evidence_objects;
  v_ids     jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_ie FROM public.income_expenses ie
  WHERE ie.id = p_voucher AND ie.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'adopt_voucher_attachments_as_evidence_v2: phiếu % không tồn tại', p_voucher
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_ie.organization_id);
  IF v_actor.membership_id IS NULL THEN
    RAISE EXCEPTION 'adopt_voucher_attachments_as_evidence_v2: không có membership active trong organization của phiếu'
      USING ERRCODE = '42501';
  END IF;

  IF v_ie.attachments IS NULL OR jsonb_typeof(v_ie.attachments) <> 'array' THEN
    RETURN jsonb_build_object('evidence_ids', v_ids, 'skipped', v_skipped);
  END IF;

  FOR v_url IN SELECT jsonb_array_elements_text(v_ie.attachments) LOOP
    v_pos := position(v_prefix IN COALESCE(v_url, ''));
    IF v_pos = 0 THEN
      v_skipped := v_skipped || jsonb_build_object('url', v_url, 'reason', 'KHONG_PHAI_FILE_STORAGE');
      CONTINUE;
    END IF;

    v_path   := substring(v_url FROM v_pos + length(v_prefix));
    v_path   := split_part(v_path, '?', 1);
    v_bucket := split_part(v_path, '/', 1);
    v_object := substring(v_path FROM length(v_bucket) + 2);

    IF v_bucket NOT IN ('income-expense-attachments', 'payment-receipts')
       OR COALESCE(v_object, '') = '' THEN
      v_skipped := v_skipped || jsonb_build_object('url', v_url, 'reason', 'BUCKET_KHONG_HOP_LE');
      CONTINUE;
    END IF;

    SELECT o.metadata INTO v_meta
    FROM storage.objects o
    WHERE o.bucket_id = v_bucket AND o.name = v_object;
    IF v_meta IS NULL THEN
      v_skipped := v_skipped || jsonb_build_object('url', v_url, 'reason', 'FILE_KHONG_CON_TRONG_STORAGE');
      CONTINUE;
    END IF;

    -- Chặn mượn file CHÉO TENANT: nếu file đã gắn với org khác thì không nhận.
    -- (Sửa phiếu để trỏ attachments sang file của org bạn là đường tấn công duy
    --  nhất còn lại; chốt này đóng nó lại.)
    IF EXISTS (
      SELECT 1 FROM app_private.storage_object_links l
      WHERE l.bucket_id = v_bucket AND l.object_name = v_object
        AND l.organization_id IS NOT NULL
        AND l.organization_id <> v_ie.organization_id
    ) THEN
      v_skipped := v_skipped || jsonb_build_object('url', v_url, 'reason', 'FILE_THUOC_TO_CHUC_KHAC');
      CONTINUE;
    END IF;

    INSERT INTO public.finance_evidence_objects (
      organization_id, bucket_id, object_name, uploader_membership_id, uploader_user_id,
      provenance_kind, state, finalized_at, byte_size, mime_type
    ) VALUES (
      v_ie.organization_id, v_bucket, v_object, v_actor.membership_id, v_actor.user_id,
      'UPLOAD', 'FINALIZED', now(),
      NULLIF(v_meta->>'size', '')::bigint, v_meta->>'mimetype'
    )
    ON CONFLICT (organization_id, bucket_id, object_name) DO NOTHING;

    SELECT * INTO v_row FROM public.finance_evidence_objects e
    WHERE e.organization_id = v_ie.organization_id
      AND e.bucket_id = v_bucket AND e.object_name = v_object
    FOR UPDATE;

    -- Intent cũ bỏ dở trên đúng file này: nâng lên FINALIZED thay vì tạo trùng.
    IF v_row.state = 'UPLOAD_INTENT' THEN
      UPDATE public.finance_evidence_objects e
         SET state = 'FINALIZED', finalized_at = now(),
             byte_size = NULLIF(v_meta->>'size', '')::bigint,
             mime_type = v_meta->>'mimetype'
       WHERE e.id = v_row.id;
      v_row.state := 'FINALIZED';
    END IF;

    IF v_row.state <> 'FINALIZED' THEN
      -- ATTACHED: đã dùng cho lần ghi sổ trước; QUARANTINED: bị cách ly.
      v_skipped := v_skipped || jsonb_build_object('url', v_url, 'reason', v_row.state);
      CONTINUE;
    END IF;

    -- Shield đọc storage (đối xứng finalize_finance_evidence_v2).
    INSERT INTO app_private.storage_object_links
      (bucket_id, object_name, organization_id, owner_user_id, derivation)
    VALUES (v_bucket, v_object, v_ie.organization_id, v_actor.user_id, 'FINANCE_V2_EVIDENCE')
    ON CONFLICT DO NOTHING;

    v_ids := v_ids || to_jsonb(v_row.id);
  END LOOP;

  RETURN jsonb_build_object('evidence_ids', v_ids, 'skipped', v_skipped);
END
$fn$;

REVOKE ALL ON FUNCTION public.adopt_voucher_attachments_as_evidence_v2(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.adopt_voucher_attachments_as_evidence_v2(uuid) TO authenticated;
COMMENT ON FUNCTION public.adopt_voucher_attachments_as_evidence_v2(uuid) IS
  '7ai: lập bản ghi chứng từ FINALIZED trỏ vào ảnh đã đính kèm sẵn của phiếu (không upload lại). Chỉ nhận file nằm trong attachments của chính phiếu đó.';

COMMIT;

NOTIFY pgrst, 'reload schema';
