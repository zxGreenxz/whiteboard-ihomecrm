-- =============================================================
-- Link công khai "Phòng trống": thêm bí danh /r/dsphongtrong
--
-- Trang /r/:token đã có sẵn route nên chỉ cần một dòng token mới trỏ về ĐÚNG
-- owner/organization của token "demo". GIỮ NGUYÊN token "demo" — cả hai link
-- vào cùng một trang, cùng một dữ liệu:
--   https://ptcrm.vercel.app/r/demo
--   https://ptcrm.vercel.app/r/dsphongtrong
--
-- Idempotent: chạy lại không nhân bản, và nếu token đã tồn tại thì đồng bộ lại
-- owner/organization theo "demo" rồi bỏ cờ thu hồi.
-- =============================================================

INSERT INTO public.public_room_share_tokens (token, owner_id, label, revoked, organization_id)
SELECT
  'dsphongtrong',
  t.owner_id,
  'Danh sách phòng trống (link thương hiệu)',
  false,
  t.organization_id
FROM public.public_room_share_tokens t
WHERE t.token = 'demo'
ON CONFLICT (token) DO UPDATE
  SET owner_id        = EXCLUDED.owner_id,
      organization_id = EXCLUDED.organization_id,
      revoked         = false;

COMMENT ON TABLE public.public_room_share_tokens IS
'Token chia sẻ công khai cho trang "Phòng trống" (/r/:token). owner_id = chủ data
được lộ ra (chỉ phía server, KHÔNG gửi ra client). revoked=true để thu hồi link.
Bí danh cùng owner được phép: "demo" và "dsphongtrong" trỏ chung một dữ liệu.';
