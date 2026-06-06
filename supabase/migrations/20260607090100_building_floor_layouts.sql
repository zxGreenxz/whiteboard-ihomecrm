-- =============================================
-- Migration: Sơ đồ tọa độ thủ công cho từng tầng (editor kéo-thả "Sale Phòng").
-- - Lưu 1 jsonb trên buildings, key = số tầng (chuỗi). RLS kế thừa từ buildings
--   (đã owner-scoped: user_id = auth.uid()), nên KHÔNG cần policy mới.
-- - Phòng KHÔNG có trong bucket của tầng => client tự sinh layoutFloor() (fallback).
--   Vì vậy trang công khai luôn vẽ đủ phòng dù layout chỉ đặt một phần.
-- =============================================

ALTER TABLE public.buildings
  ADD COLUMN IF NOT EXISTS floor_layouts jsonb;

COMMENT ON COLUMN public.buildings.floor_layouts IS
'Sơ đồ thủ công per-tầng cho trang công khai /r/:token. Shape:
{ "<floor>": {
    "canvasW": int, "canvasH": int,
    "corridor": {"x":n,"y":n,"w":n,"h":n},
    "fixtures": [{"id":str,"kind":"elevator"|"stairs","x":n,"y":n,"w":n,"h":n}],
    "rooms":    { "<room_id>": {"x":n,"y":n,"w":n,"h":n} }   -- chỉ phòng đã đặt
  }, ... }
NULL / thiếu tầng / thiếu phòng => client tự sinh layoutFloor() (fallback). Khoá phòng
mồ côi (đã xoá/đổi tầng) bị bỏ qua khi render, dọn ở lần Lưu kế tiếp.';
