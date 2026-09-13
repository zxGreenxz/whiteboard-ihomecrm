# Sơ đồ căn hộ hiển thị giá theo hợp đồng đang hiệu lực

Ngày: 2026-09-13 · Trạng thái: đã chốt với chủ

## Vấn đề

Thẻ phòng trên Sơ đồ căn hộ hiển thị `rooms.rent_price` — giá **niêm yết** của
phòng — kể cả khi phòng đang có hợp đồng với giá khác. Hợp đồng mới ký lại, giảm
giá giữ khách, hay tăng giá khi gia hạn đều không lộ ra trên sơ đồ.

Đo trên production ngày 13/09/2026: **129/292 hợp đồng ACTIVE có giá khác giá
niêm yết** (50 cao hơn, 79 thấp hơn) — 44%. Ví dụ toà 950NK: PARIS 2 hợp đồng
6.100.000 nhưng sơ đồ hiện 6.600.000; PARIS 3 hợp đồng 6.000.000 hiện 6.600.000.

Mỗi phòng có đúng một hợp đồng ACTIVE (đã kiểm: 292/292), nên không có tình
huống phải chọn giữa nhiều hợp đồng.

Cùng lỗi có ở Danh mục căn hộ bản mobile — cũng đọc `rooms.rent_price`.

## Luật hiển thị

| Phòng | Số chính (đậm) | Số phụ (mờ, nhỏ) |
|---|---|---|
| Có hợp đồng ACTIVE, giá khác niêm yết | giá hợp đồng | giá niêm yết |
| Có hợp đồng ACTIVE, giá bằng niêm yết | giá hợp đồng | — |
| Không hợp đồng (Trống / Đặt cọc / Ngừng hoạt động) | giá niêm yết | — |

Hai số trùng nhau thì không in số phụ — in ra chỉ là nhiễu.

Hậu tố `/tháng` **bỏ khỏi mọi thẻ phòng trên sơ đồ và mọi dòng danh sách căn
hộ**, kể cả thẻ chỉ có một số, để mọi thẻ cùng một kiểu (chủ chốt). Bản mobile
giữ chữ `tr` vì đó là đơn vị (triệu), chỉ bỏ `/th`. Hai bottom-sheet chi tiết
vẫn ghi đủ `/ tháng` vì ở đó không chật.

## Kiến trúc

**`src/lib/roomPrice.ts` (mới)** — hàm thuần `resolveRoomPrice({ roomRentPrice,
contractRentPrice })` trả `{ primary, listed }`, cài đúng bảng luật trên. Tách
riêng để ba màn dùng chung một luật và kiểm được bằng unit test thay vì bằng mắt.
Kèm `src/lib/__tests__/roomPrice.test.ts`.

**`src/hooks/useRoomsWithContracts.ts`** — select thêm `rent_price` trong nhánh
`contracts(...)`, thêm vào kiểu `RoomWithContract['activeContract']`. Chỉ thêm
trường, nên 5 màn đang dùng hook không màn nào phải đổi theo.

**Ba màn áp dụng**

- `src/components/building-map/RoomCard.tsx` — thêm prop `listedPrice?: number |
  null`, render số phụ khi có. Bỏ `/tháng`.
- `src/pages/building-map/BuildingMapPage.tsx` — truyền giá đã giải.
- `src/pages/building-map/BuildingMapMobilePage.tsx` — thẻ phòng + dòng "Giá
  thuê" trong bottom-sheet.
- `src/pages/rooms/RoomsMobilePage.tsx` — dòng danh sách + dòng "Tiền thuê"
  trong bottom-sheet. Map `contractByRoom` hiện chỉ giữ `end`/`tenant`, thêm giá.

## Ngoài phạm vi

`RoomDetailDialog` (desktop) đã hiện đúng cả hai số ở hai khối riêng — giá phòng
ở khối căn hộ, giá hợp đồng ở khối hợp đồng — giữ nguyên. `RoomsPage` desktop
không hiển thị giá thuê.

Không đổi schema, không đổi RPC, không migration. Đường lùi là `git revert`.
