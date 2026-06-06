-- =============================================
-- Migration: RPC tạo token chia sẻ trang "Phòng trống" cho CHỦ tài khoản.
-- - Tái dùng gen_contract_public_code (base-57, không ký tự dễ nhầm) + retry chống
--   trùng giống set_contract_public_code (20260530000003). >10 lần trùng → len 8.
-- - SECURITY DEFINER để tự gán owner_id = auth.uid() (bảng RLS owner-only). GRANT
--   chỉ cho authenticated (KHÔNG anon — anon chỉ đọc phòng qua get_public_available_rooms).
-- =============================================

CREATE OR REPLACE FUNCTION public.create_public_room_token(p_label text DEFAULT NULL)
RETURNS public.public_room_share_tokens
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner     uuid := auth.uid();
  candidate   text;
  tries       int := 0;
  v_row       public.public_room_share_tokens;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Không xác định được người dùng (auth.uid is null)';
  END IF;

  LOOP
    candidate := public.gen_contract_public_code(6);
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.public_room_share_tokens WHERE token = candidate
    );
    tries := tries + 1;
    IF tries >= 10 THEN
      candidate := public.gen_contract_public_code(8);
      EXIT;
    END IF;
  END LOOP;

  INSERT INTO public.public_room_share_tokens (token, owner_id, label)
  VALUES (candidate, v_owner, NULLIF(btrim(coalesce(p_label, '')), ''))
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.create_public_room_token(text) IS
'Tạo 1 token chia sẻ /r/:token cho owner hiện tại (auth.uid). Mã base-57 6 ký tự
(retry chống trùng, bump 8). Trả về dòng vừa tạo. Chỉ authenticated gọi được.';

REVOKE EXECUTE ON FUNCTION public.create_public_room_token(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_public_room_token(text) TO authenticated;
