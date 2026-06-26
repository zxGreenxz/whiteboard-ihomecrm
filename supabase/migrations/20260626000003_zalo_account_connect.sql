-- =============================================================
-- Chat Zalo — luồng KẾT NỐI tài khoản cá nhân (đăng nhập QR qua worker zca-js).
--
-- Web bấm "Kết nối" → RPC đặt account.status='connecting'. Worker (chạy local→VPS)
-- poll → loginQR → ghi qr_data (data URL) + status='waiting_scan'. Web hiện QR
-- (Realtime). User quét bằng app Zalo → worker set status='connected' + tên/uid,
-- xoá qr_data. Cookie phiên do WORKER giữ ở FILE local (KHÔNG lưu DB).
-- Idempotent.
-- =============================================================

BEGIN;

-- Cột phục vụ luồng đăng nhập QR
ALTER TABLE public.zalo_accounts ADD COLUMN IF NOT EXISTS qr_data            text;
ALTER TABLE public.zalo_accounts ADD COLUMN IF NOT EXISTS qr_expires_at      timestamptz;
ALTER TABLE public.zalo_accounts ADD COLUMN IF NOT EXISTS last_error         text;
ALTER TABLE public.zalo_accounts ADD COLUMN IF NOT EXISTS login_requested_at timestamptz;

-- Mở rộng trạng thái: thêm 'connecting' + 'waiting_scan'
ALTER TABLE public.zalo_accounts DROP CONSTRAINT IF EXISTS zalo_accounts_status_check;
ALTER TABLE public.zalo_accounts ADD CONSTRAINT zalo_accounts_status_check
  CHECK (status IN ('connected','disconnected','error','connecting','waiting_scan'));

-- Realtime cho accounts (web hiện QR + trạng thái tức thì)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='zalo_accounts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.zalo_accounts;
  END IF;
END $$;

-- ── RPC: yêu cầu kết nối (tạo mới hoặc kết nối lại 1 tài khoản) ──
CREATE OR REPLACE FUNCTION public.zalo_request_connect(
  p_account_id uuid DEFAULT NULL,
  p_name       text DEFAULT NULL
)
RETURNS public.zalo_accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_row public.zalo_accounts;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  IF p_account_id IS NULL THEN
    -- tạo tài khoản mới ở trạng thái chờ đăng nhập
    INSERT INTO public.zalo_accounts(user_id, kind, name, status, login_requested_at)
    VALUES (auth.uid(), 'personal', COALESCE(NULLIF(btrim(p_name),''), 'Zalo cá nhân'), 'connecting', now())
    RETURNING * INTO v_row;
  ELSE
    SELECT * INTO v_row FROM public.zalo_accounts WHERE id = p_account_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tài khoản không tồn tại'; END IF;
    IF NOT (v_row.user_id = auth.uid() OR public.is_super_admin() OR public.is_admin()) THEN
      RAISE EXCEPTION 'Bạn không có quyền với tài khoản này' USING ERRCODE = '42501';
    END IF;
    UPDATE public.zalo_accounts
       SET status='connecting', qr_data=NULL, last_error=NULL, login_requested_at=now(),
           name=COALESCE(NULLIF(btrim(p_name),''), name), updated_at=now()
     WHERE id = p_account_id
     RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_request_connect(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_request_connect(uuid, text) FROM anon;

-- ── RPC: ngắt kết nối / huỷ phiên đăng nhập ──
CREATE OR REPLACE FUNCTION public.zalo_disconnect_account(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  UPDATE public.zalo_accounts
     SET status='disconnected', qr_data=NULL, qr_expires_at=NULL, updated_at=now()
   WHERE id = p_account_id
     AND (user_id = auth.uid() OR public.is_super_admin() OR public.is_admin());
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_disconnect_account(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_disconnect_account(uuid) FROM anon;

NOTIFY pgrst, 'reload schema';
COMMIT;
