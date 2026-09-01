# 19. SOP tiền & sổ quỹ — quy trình vận hành chuẩn

> **Phạm vi file này:** quy trình VẬN HÀNH cho người cầm tiền (ai thu, nộp về đâu, kiểm kê thế nào).
> **KHÔNG nói về:** cấu trúc dữ liệu phiếu/sổ — `08-thu-chi-so-quy.md`; vòng đời hoá đơn —
> `07-hoa-don-thanh-toan.md`; luật phê duyệt — `20-phe-duyet-tai-chinh.md`. Audit mới nhất:
> `docs/audits/AUDIT-THANH-TOAN-2026-08-31.md`.

> Chốt bởi chủ nhà + hội đồng cố vấn 04/07/2026 (chương trình "Thống nhất tài
> chính toàn web"). Nguyên tắc gốc: **sổ quỹ chỉ là SỔ GIỮ TIỀN THẬT** — doanh
> thu, tiền cọc đang giữ, lợi nhuận đều đếm **theo hạng mục** (engine
> `kqkd_amount` item-level + module cọc), KHÔNG đọc từ số dư sổ.

## 0. Mô hình 2 loại sổ

| Loại | Cờ `accounts.is_virtual` | Ý nghĩa | Ví dụ |
|---|---|---|---|
| **Sổ tiền thật** | `false` | Két/tài khoản có tiền sờ được — số dư phải khớp kiểm kê | Hiển Thu, Hiệp Thu, TK939, TKHIEP, AG810 |
| **Sổ theo dõi (ảo)** | `true` | Chỉ chứa bút toán kỹ thuật, net 0 mỗi thương vụ, KHÔNG phải tiền | Cấn trừ thanh lý (nội bộ), CỌC (giữ hộ khách — đã đóng), Làm tròn, %Thối |

Phiếu trên trang Thu chi chia 3 lớp (suy tự động, không chọn tay):
- **Tiền thật** (mặc định): APPROVED + sổ thực + không phải nguồn nội bộ → duy nhất lớp này cộng vào thẻ Thu/Chi.
- **Nội bộ**: bút toán trên sổ ảo hoặc nguồn cấn cọc/backfill/điều chỉnh — hiển thị trung tính, không cộng tổng.
- **Chờ xử lý**: phiếu nháp hoặc chưa chọn sổ — phải xử lý, chưa được tính.

## 1. Sáu nghiệp vụ tiền chuẩn

### 1.1 Thu tiền khách (hoá đơn / cọc)
- Thu bằng sổ **"<Tên> Thu"** của chính người thu (auto-pick theo `is_default`). CK thì vào đúng sổ ngân hàng nhận.
- Tiền cọc: thu **tách phiếu** đánh dấu cọc (engine tự loại khỏi doanh thu). Tiền cọc nhận về là **vốn lưu động hợp pháp** — không cần két riêng; "đang giữ cọc bao nhiêu" xem module Tiền cọc (đếm theo hợp đồng), KHÔNG xem số dư sổ.

### 1.2 Chi vận hành
- Chi từ đúng sổ đang cầm tiền; phiếu chi ghi rõ hạng mục (điện/nước/sửa chữa/lương…) — hạng mục quyết định P&L, không phải sổ.

### 1.3 Bàn giao tiền (sale/quản lý → két chính)
- Nhịp **T2 & T5 hằng tuần** (hoặc khi két cá nhân vượt trần **20–30 triệu**).
- Dùng chức năng Bàn giao (1 phiếu CHI sổ giao + 1 phiếu THU sổ nhận, `system_source='handover.transfer'`). Đây là tiền thật di chuyển — vẫn thuộc lớp Tiền thật, không phải doanh thu/chi phí.

### 1.4 Thanh lý hợp đồng
- **Cấn cọc → doanh thu**: hệ tự sinh CẶP bút toán trên **một sổ ảo duy nhất** "Cấn trừ thanh lý (nội bộ)" (net 0) — không đụng két thật.
- **Khách trả thêm**: tiền thật — chọn **sổ nhận ngay trong form thanh lý** (mặc định sổ Thu của người bấm).
- **Hoàn khách**: 1 phiếu chi nháp `[HOÀN KHÁCH THANH LÝ]` **chưa gắn sổ**; người duyệt chọn sổ thực nào chi ra rồi mới duyệt được (nghiệp vụ: rút từ dòng vốn đang vận hành, không "đợi đúng két cọc").

### 1.5 Chia lợi nhuận cổ đông
- Theo nhịp tháng ở mục 2; phiếu chi từ **sổ thực của chủ**, hạng mục chia LN (ngoài KQKD), toà ảo Chung.

### 1.6 Chốt sổ & bàn giao quỹ (nghi thức HAI BÊN)

> ⚠️ **Luồng cũ đã chết** (30/07/2026): "Báo cáo bàn giao → Chốt số → tick *Chốt số & KHOÁ SỔ*" khoá sổ TRƯỚC khi bên kia đồng ý, và `create_opening_adjustment` đằng sau nó **đã bị REVOKE** nên bấm chỉ ăn `42501` sau khi đã kịp ghi một dòng rác. Nút đó đã gỡ. Phiếu "Điều chỉnh số dư đầu kỳ" chỉ còn giá trị tra cứu lịch sử.

Luồng hiện hành — trang **Tài chính → Sổ quỹ** (cả desktop lẫn app điện thoại):

1. **Người đang giữ sổ** bấm *Chốt sổ & bàn giao quỹ*: hệ liệt kê rào chặn (phiếu chờ duyệt, phiếu đã duyệt chưa ghi sổ, phiên bàn giao đang treo…), rồi nhập **số đếm thật trong két** — sổ ngân hàng thì nhập **số dư trên sao kê** — chọn người ký, gõ `CHOT SO`. Bước này **chưa khoá gì cả**.
2. **Người nhận** (Chủ sở hữu tổ chức hoặc Kế toán) thấy đề nghị trong hộp thư đầu trang Sổ quỹ + thông báo `E6b`, đếm lại, **gõ lại con số** rồi ký. Lúc này kỳ mới khoá.
3. Lệch số → hệ tự lập phiếu **"Thừa quỹ / Thiếu quỹ khi chốt sổ"** (`system_source = cashbook.closing.diff`, ngoài KQKD nên không đụng số đã chia cho cổ đông) và ghi **biên bản in được** (`/finance/cashbooks/closure/<id>`).
4. **Khoá là VĨNH VIỄN** — không ai mở lại, kể cả chủ. Sai sót phát hiện sau xử lý bằng phiếu điều chỉnh ở kỳ hiện tại. Vẫn bổ sung được ảnh chứng từ + ghi chú cho phiếu cũ.

- Người ký phải **khác** người đề nghị (CHECK ở tầng bảng). Sổ nào chỉ một người dính líu thì phải gán ai đó vào vai trò **Kế toán** (Cài đặt → Thành viên, phạm vi *toàn tổ chức*) mới chốt được.
- **KHÔNG bao giờ** sửa phiếu quá khứ hay `initial_amount` để "ép" số dư — `a00_accounts_closed_book_guard` chặn cứng sau khi sổ đã chốt.

## 2. Nhịp vận hành

| Nhịp | Việc |
|---|---|
| Hằng ngày | Thu tiền đúng sổ cá nhân; phiếu nháp không để quá 3 ngày (trang Thu chi lớp "Chờ xử lý" phải về 0) |
| T2 & T5 | Bàn giao tiền mặt về két chính/ngân hàng |
| Sau mỗi lần bàn giao | Người giao nhận thông báo *"đã bàn giao xong — chốt sổ?"* → đếm số còn lại trong két và chốt sổ luôn (§1.6). Bỏ qua được, nhưng bỏ nhiều thì cuối tháng phải dò lại |
| Cuối tháng | **Chốt sổ từng sổ (§1.6) → chốt LN tháng → chi LN** — đúng thứ tự |

> ⚠️ **Chốt LN SAU KHI HẾT THÁNG.** Chốt giữa tháng là chốt trên số liệu còn thiếu ngày, và mọi phiếu ghi sau đó bị **trigger khoá**; muốn ghi tiếp phải "Mở khoá tháng", mà mở khoá thì **XOÁ phần đã phân bổ cho cổ đông/quản lý** và phải chốt lại. Tab *Chốt LN tháng* đã cảnh báo cả hai việc này (tháng chưa kết thúc · còn sổ quỹ chưa chốt) nhưng **không chặn** — quyết định cuối là của chủ.

## 3. Cut-over ngày D (chuẩn hoá két lần đầu)

1. Chọn ngày D (đề xuất **01/08/2026**), thông báo trước cho Hiển/Hiệp.
2. Cuốn chiếu từng sổ: đếm két thật / chụp sao kê → nhập "Chốt số & KHOÁ SỔ".
   Thứ tự: Hiển Thu, Hiệp Thu → TK939 / AG810 / TKHIEP → ATam / HKD* / Chung.
3. Sau D: mọi sổ thực có `lock_date = D`; số dư sổ = tiền đếm được; chênh lịch sử nằm gọn trong các phiếu "Điều chỉnh số dư đầu kỳ" (tra cứu được, ngoài P&L).
4. Sổ "CỌC (giữ hộ khách)" đã đóng (bút toán `adjustment.close_coc` net về 0) — chỉ còn tra cứu.

## 4. Thanh kiểm chứng (tin số trước khi chia tiền)

Trang **Phân bổ lợi nhuận** có thanh Kiểm chứng (desktop + mobile):
- `Tổng = Σ dòng hiển thị ✓` — tổng thẻ luôn cộng tay lại được.
- `Không nằm trong tổng:` N phiếu nháp · khoản ngoài-KQKD (cọc, điều chỉnh…) · phiếu chưa chọn sổ — trả lời "thiếu gì".
- `Khớp engine chia cổ đông ±0 ✓` — đối chiếu với `fa_monthly_pnl_accrual` (engine snapshot chia LN); **LỆCH đỏ thì DỪNG chia LN, điều tra trước**.
- Tiền đã thu hoá đơn kỳ (đối chiếu dòng tiền — lệch với doanh thu ghi nhận là bình thường do thu trước/sau kỳ).

## 5. Việc chưa quyết (theo dõi)

- Sale cầm tiền mặt: cấp sổ "X Thu" + vào lịch bàn giao, hay bắt CK thẳng — chủ quyết khi ký SOP.
- Trần két cá nhân chính xác (20 hay 30 triệu).
