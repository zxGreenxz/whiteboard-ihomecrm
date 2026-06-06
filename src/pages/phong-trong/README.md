# Trang "Phòng trống" (Sale view) — bản 100% mock, data mẫu

Trang React tự chứa, **không phụ thuộc shadcn** (dùng `phongTrong.css` của mock) nên hiển thị
**giống y hệt** thiết kế. Chạy ngay với data mẫu; nối Supabase sau.

## Cài vào repo (Vite + React + TS)
1. Copy nguyên thư mục này vào `src/pages/phong-trong/`.
2. Mở `src/App.tsx`, thêm route **công khai** (không qua ProtectedRoute):
   ```tsx
   import PhongTrongPage from "@/pages/phong-trong/PhongTrongPage";
   // ...trong <Routes>, đặt cùng nhóm các route public:
   <Route path="/r/:token" element={<PhongTrongPage />} />
   ```
3. `npm run dev` → mở `http://localhost:5173/r/abc` (token tùy ý, bản mock chưa kiểm tra token).

## Các file
| File | Vai trò |
|---|---|
| `phongTrong.css` | Toàn bộ style (đã nhúng @import font Be Vietnam Pro + Space Mono) |
| `sampleData.ts` | Types (`Building`/`Room`/`Fixture`/`FloorPlan`) + data mẫu + **`layoutFloor`** (tự xếp sơ đồ theo tọa độ) |
| `icons.tsx` | Bộ icon SVG (gồm Thang máy/Cầu thang) |
| `PhongTrongParts.tsx` | Summary, FilterBar, ListView, **FloorPlan** (canvas tọa độ, scale-to-fit) |
| `PhongTrongSheet.tsx` | Bottom-sheet chi tiết + Toast (Gọi/Zalo/Copy/Chia sẻ/Chỉ đường) |
| `PhongTrongPage.tsx` | Trang chính (header/live/chips kéo ngang/lọc/2 chế độ xem) |

> Lưu ý: `phongTrong.css` đặt style cho `body`, `#stage`, `.app` (full màn hình) — đúng cho trang
> share link đứng riêng. Nếu nhúng trong shell có sidebar, nên bọc trang ở route riêng (đã làm).

## SĐT/Zalo liên hệ
Sửa `MANAGER` trong `sampleData.ts` (hoặc map theo từng toà khi nối dữ liệu thật).

## Nối Supabase (bước sau)
Giữ NGUYÊN toàn bộ UI; chỉ thay nguồn dữ liệu trong `PhongTrongPage.tsx`:
```tsx
// thay:  const buildings = SAMPLE_BUILDINGS;
// bằng:  const { data: buildings = [] } = usePhongTrong(token);
```
Trong hook `usePhongTrong`:
1. Gọi RPC public (vd `get_public_available_rooms`) trả phòng theo token.
2. Map mỗi phòng sang type `Room` (status: `free | soon | rented`).
3. Nhóm theo toà → mỗi toà gọi **`layoutFloor(floor, rooms)`** (export sẵn trong `sampleData.ts`)
   để **tự sinh sơ đồ tọa độ** — không cần editor. Khi dựng lại editor kéo-thả, thay bằng
   toạ độ thật (`layout_x/y/w/h`).

## Map trạng thái nội bộ → public
- Nội bộ `AVAILABLE` (trống) → `free`
- Nội bộ `EXPIRING_SOON` (sắp hết HĐ) → `soon`
- Còn lại (`OCCUPIED`/`RESERVED`/`MAINTENANCE`) → `rented`

---

### Prompt cho Claude Code (chạy trong repo, sau khi đã đặt thư mục handoff vào gốc repo)
> Đọc `phong-trong-handoff/README.md`. Copy toàn bộ thư mục `phong-trong-handoff/src/pages/phong-trong`
> vào `src/pages/phong-trong`. Mở `src/App.tsx` thêm route công khai
> `<Route path="/r/:token" element={<PhongTrongPage />} />` (import default từ
> `@/pages/phong-trong/PhongTrongPage`), đặt cùng nhóm route public, KHÔNG bọc ProtectedRoute.
> Chạy `npm run lint` và `npm run build`, sửa nếu thiếu import và báo lại. Cuối cùng xoá thư mục
> `phong-trong-handoff/`.

---

## NỐI DATA THẬT SUPABASE (đã có sẵn file)
Giao diện giữ nguyên 100%; chỉ thay nguồn data. Các file mới trong thư mục này:
- `phong_trong_rpc.sql` — tạo bảng token + RPC `get_public_available_rooms(p_token)` (anon). Có TODO.
- `supabaseData.ts` — adapter map payload RPC → type `Building/Room` (gọi `layoutFloor` tự sinh sơ đồ).
- `usePhongTrong.ts` — hook React Query gọi RPC.
- `PhongTrongPage.tsx` — đã sửa: dùng `usePhongTrong(token)`, có loading/lỗi; chưa có token vẫn xem được data mẫu.

### Các bước
1. **DB:** mở `phong_trong_rpc.sql`, chỉnh phần TODO (đặc biệt: nguồn liên hệ, cờ "sắp trống" từ `contracts`,
   có giấu phòng đã thuê không), chạy trong Supabase. Tạo 1 token test rồi mở `/r/<token>`.
2. **Storage ảnh:** sửa `IMAGES_BUCKET` trong `supabaseData.ts` đúng tên bucket chứa `room.images`.
   (Adapter tự đổi storage-path → public URL; nếu `images` đã là URL đầy đủ thì giữ nguyên.)
3. **Liên hệ:** `buildings` hiện KHÔNG có cột SĐT. Hoặc (a) sửa `HOTLINE` trong `supabaseData.ts` cho 1 số chung,
   hoặc (b) thêm cột liên hệ vào `buildings` + bỏ comment ở RPC + adapter tự nhận.
4. **Trạng thái:** mặc định `AVAILABLE → Trống`, còn lại `Đã thuê`. Muốn "Sắp trống" thì bật nhánh `soon`
   trong RPC (suy từ `contracts` sắp hết hạn) — adapter đã sẵn sàng nhận `status_public='soon'`.

### Prompt cho Claude Code (nối Supabase)
> Trong repo đã có sẵn `src/pages/phong-trong/` (giao diện) và các file `supabaseData.ts`, `usePhongTrong.ts`,
> `phong_trong_rpc.sql`. Hãy: (1) xem schema thật của bảng `rooms`, `buildings`, `areas`, `contracts`,
> đối chiếu & chỉnh các TODO trong `phong_trong_rpc.sql` (nguồn liên hệ, nhánh `soon` từ contracts, có
> giấu phòng đã thuê không), rồi tạo migration và áp lên Supabase. (2) Xác nhận tên bucket Storage chứa ảnh
> phòng và sửa `IMAGES_BUCKET` trong `supabaseData.ts`. (3) Đảm bảo `PhongTrongPage` đang dùng
> `usePhongTrong(token)`. (4) Tạo 1 token test trong bảng `phong_trong_tokens`, chạy `npm run build`,
> mở `/r/<token>` và báo lại kết quả + các quyết định schema đã chọn. Giữ nguyên toàn bộ UI/UX.

