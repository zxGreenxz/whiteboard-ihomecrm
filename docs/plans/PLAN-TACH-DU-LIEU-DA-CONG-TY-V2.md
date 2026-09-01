# Kế hoạch tách bạch dữ liệu giữa các công ty — BẢN 2

> **[LỊCH SỬ — ĐÃ SHIP phần lõi]** 304 policy biên giới tổ chức đang live trên production. Hiện hành: `../he-thong/00-tong-quan.md` (ba tổ chức) + Contract §2. Giữ làm bằng chứng.

> Bản 1 ([PLAN-TACH-DU-LIEU-DA-CONG-TY.md](./PLAN-TACH-DU-LIEU-DA-CONG-TY.md)) đã bị review chấm 10 finding.
> Bản 2 này là kết quả sau khi **kiểm chứng độc lập từng finding trên chính production** — không finding nào
> được sửa theo chỉ vì review nói vậy, và không finding nào bị bỏ qua chỉ vì bản 1 viết vậy.
> Mọi kết luận dưới đây đều đo được, mọi thử nghiệm ghi đều bọc `BEGIN … ROLLBACK`.

## TIẾN ĐỘ THỰC TẾ — chốt phiên 08/08/2026

Bảy migration đã lên production, mỗi cái qua backup thật, dry-run thật, và một
phép đo trước/sau bằng vai người dùng thật. Ba commit: `9519cd98`, `3f0b33bc`,
`efb6ad57`.

> **PHIÊN 08/08 CHIỀU–TỐI đã đóng cả 5 việc trong mục "CÒN LẠI", cộng GĐ7 và
> GĐ-R.** Số chốt mới: biên giới **300** relation · miễn trừ **4** · rò còn **2**
> (đều là bảng dùng chung có chủ ý) · hai tổ chức Test/Demo **đã xoá** · màn
> thanh toán **14,8s → 0,37s** · điểm mù 12 bảng thiếu cột org **đã đóng** · số
> điện thoại khách **đã bỏ** khỏi bề mặt công khai · rate-limit **đã chạy**
> (60 mã sai/10 phút/IP, trả 429).
>
> Mười commit: `19bb16d3`, `0d65ca5b`, `61598490`, `29096106`, `18359bf9`,
> `0efabefd`, `0ce5396c`, `bc99510b`, `bdbc3247`, `c65a3ca0`.
>
> **KẾ HOẠCH ĐÃ ĐÓNG.** Mọi bảng có `organization_id` đều có biên giới, và sổ
> miễn trừ RỖNG — không còn dòng nào, không còn hạn chót nào treo.
>
> | Chỉ số | Đầu (07/08) | Chốt (11/08) |
> |---|---|---|
> | Bảng có biên giới tổ chức | 32/304 | **304/304** |
> | Sổ miễn trừ | 7 dòng | **0** |
> | Bảng đang rò sang công ty khác | 19 | **0** |
> | Dòng `organization_id` NULL chưa khai | 3.621 (không ai đếm) | **0** |
> | Bảng bộ đo không hề quét | 12 | **0** |
> | Màn hình thanh toán | 14.821 ms | **365 ms** |
> | Bề mặt hoá đơn công khai | không giới hạn, lộ SĐT | **60 mã sai/10 phút/IP**, không SĐT |
> | Frontend biết "tổ chức hiện tại" | không | **có** |
>
> Phiên 09–11/08: `ae505187`, `979d0941`, `e54f831a`, `2398037f`, và bản cập
> nhật này.
>
> **PHIÊN 11/08 — TÁCH VAI CHỦ KHỎI VAI HỆ THỐNG, VÀ DỰNG LẠI DEMO.**
>
> Phát hiện gốc: hệ thống **chưa từng có vai chủ công ty**. Vai `Super Admin` có
> **0 quyền** trong `role_permissions` — sức mạnh của nó đến từ vế
> `is_super_admin()` nhúng trong policy. Tức quyền CHỦ SỞ HỮU và quyền TÀI KHOẢN
> HỆ THỐNG lâu nay là **cùng một thứ**, và đó là gốc của chuyện báo cáo cộng gộp.
> Chứng minh trước khi sửa: membership OWNER đầy đủ nhưng không nằm trong
> `super_admins` → thấy **0 toà nhà, 0 hoá đơn, 0 hợp đồng**.
>
> - **Vai "Chủ công ty"** (`20260811030000`): 231 quyền TENANT, phạm vi
>   ORGANIZATION. Tài khoản `nguyentam@username.ihomecrm.local`. Kiểm bằng đăng
>   nhập THẬT qua HTTP: 1.143 hoá đơn / 335 hợp đồng / 18 toà, `is_super_admin`=0.
> - **Demo dựng lại** (`20260811040000`, `…050000`) như một công ty **bình
>   thường** — chủ riêng, vai riêng, **không** dùng `sandbox_org_ids` hay
>   `demo_user_ids`. Không cần giấu nữa vì chủ đã có tài khoản riêng. Cách ly đo
>   **hai chiều**: chủ Demo thấy 2 toà/8 phòng và 0 dòng công ty khác; chủ thật
>   vẫn thấy đúng 18 toà.
> - **Ba đợt chặn NULL** (`…010000`, `…020000`, `…060000`): gate bắt 177 dòng
>   NULL mới do app chạy thật sinh ra, qua ba đợt trong hai ngày. 10 bảng đã gắn
>   trigger `autofill_org_strict` fail-closed.
>
> Bộ đo nay chạy với **ba nhân vật, hai công ty thật** — lần đầu đo được rò chéo
> thật thay vì chỉ bằng tổ chức tổng hợp.
>
> **CÒN LẠI, có chủ ý không làm:** 84 bảng vẫn nhận được NULL. Gắn trigger diện
> rộng sẽ chấm dứt trò đuổi bắt, nhưng hàm fail-closed sẽ NỔ ở bảng nào có đường
> ghi không mang `user_id` lẫn bảng cha — đổi một chỗ rò im lặng lấy một chỗ hỏng
> ồn ào ở nơi chưa đo. Đáng làm khi có thời gian đo từng đường ghi của 84 bảng.
>
> **CẦN NGƯỜI QUYẾT:** `nguyentamca165@gmail.com` vẫn giữ membership OWNER của
> công ty thật. Gỡ thì việc tách mới triệt để, nhưng `can_v3` đòi membership
> ACTIVE nên phải đo kỹ đường GHI trước khi gỡ.

> **KHÔNG CÒN VIỆC NÀO CHỜ QUYẾT ĐỊNH.** Việc cuối — xoay 334 mã công khai lên
> ≥16 ký tự (GĐ0 mục 6a(i)) — đã được chủ dự án cân nhắc và **quyết KHÔNG làm**
> ngày 09/08/2026, chấp nhận rủi ro tồn đọng và lấy rate-limit làm biện pháp
> giảm nhẹ. Đừng đề xuất lại; chi tiết ở mục tương ứng bên dưới.
> Hai việc còn lại (GĐ9 frontend, hai bảng miễn trừ AI) chỉ có nghĩa khi có công
> ty thứ hai.
>
> Chi tiết từng việc nằm ngay trong mục tương ứng bên dưới.

| Chỉ số | Đầu phiên | Chốt phiên |
|---|---|---|
| Bảng có biên giới tổ chức | 32/304 | **297/304** |
| Bảng thiếu biên giới mà không rõ lý do | 272 | **0** |
| Bảng đang rò sang công ty khác | 19 | **5** (đều trong sổ miễn trừ, hạn 30/11) |
| Hàm rò PII cho người chưa đăng nhập | 1 | **0** |
| Dòng `organization_id` mồ côi | 4.189 | **3.480** |
| Tham chiếu chéo từ công ty thật sang Test/Demo | 35 | **0** |
| Cơ chế chặn bảng MỚI thiếu biên giới | không có | event trigger, đã bắn thật |
| Gate CI chống tái phát | 0 | 2 (inventory + đo rò) |

### Bằng chứng từng bước

- **GĐ0** — `get_public_latest_invoice_by_contract` gọi bằng anon key: HTTP 200
  kèm họ tên và SĐT khách thuê → **HTTP 401**. Đường chia sẻ hợp lệ `by_code`
  vẫn chạy. Lỗ này từng được vá đúng ở `20260530000003` rồi bị
  `20260601000000_remove_tax_fields.sql` chép đè một dòng `GRANT` — mở lại hơn
  hai tháng mà gate ACL không hé một tiếng, vì hàm nằm sẵn trong allowlist.
- **GĐ3** — 251 bảng: nathan 18.207 → 18.207 dòng, demo.chunha 2.887 → 2.887.
  Không ai mất một dòng nào.
- **GĐ4** — 14 bảng đang rò, đo HAI mệnh đề cùng lúc trên ba tổ chức: dòng của
  tổ chức khác 8.551 / 224 / 192 → **0**, dòng của chính mình 5→5, 8.324→8.324,
  219→219 **không đổi**. Chỉ đo "hết rò chưa" là chưa đủ — khoá sạch mọi người
  cũng cho ra 0.
- **GĐ5** — tạo bảng mới trên prod trong transaction rollback: policy tự xuất
  hiện, đúng `RESTRICTIVE` / `FOR ALL`, RLS tự bật; `ALTER TABLE` thêm cột cũng
  được bắt; bảng không có cột org thì không bị đụng.
- **GĐ6** — điền 709 dòng. 386 trong số đó (`inspection_photos` 335,
  `cash_handover_items` 32, `material_usage_items` 19) chỉ vá được vì cha của
  chúng được vá trước trong cùng transaction.
- **GĐ7** — dọn 35 tham chiếu chéo, sau đó phép chứng minh tách rời trả về
  **TÁCH RỜI HOÀN TOÀN** (0 đường FK vi phạm).
  **ĐÍNH CHÍNH 08/08 chiều — kết luận này KHÔNG còn đúng.** Chạy lại chính phép
  đo đó thấy **1 đường vi phạm**: `material_usage_items.material_id -> materials`.
  Chi tiết ở mục "CÒN LẠI" việc 1. Bài học: kết quả của phép đo này chỉ có giá
  trị tại thời điểm đo, phải chạy lại NGAY TRƯỚC transaction xoá.

### Ba lệnh kiểm chứng — đường dẫn thật, chạy được ngay

```bash
node scripts/build-org-boundary-inventory.mjs --check
node scripts/measure-org-leak.mjs
node scripts/query-sql.mjs scripts/org-split-prepared/01-chung-minh-tach-roi.sql
node scripts/query-sql.mjs scripts/org-split-prepared/02-pham-vi-xoa-hai-org.sql
```

Hai file SQL cuối trước nằm trong scratchpad tạm của phiên cũ — thư mục đó theo
session và phiên sau không có đường nào tìm ra. Nay đã nằm trong repo tại
[`scripts/org-split-prepared/`](../../scripts/org-split-prepared/).

### CÒN LẠI — theo thứ tự đáng làm trước

**1. Xoá hai công ty Test/Demo — ĐÃ XONG 08/08 chiều, đã apply prod.**
`20260808080000_xoa_hai_to_chuc_test_demo.sql`. Xoá **165.548 dòng / 174 bảng
trong 18 giây**. Xác minh sau khi xoá: `02-pham-vi-xoa-hai-org.sql` →
`so_bang_dinh = 0`; `01-chung-minh-tach-roi.sql` → `(TACH ROI HOAN TOAN)`.

Ba điều mục này từng ghi SAI, đã sửa bằng số đo (chi tiết trong đầu file
migration và trong commit `61598490`):

- "~60 bảng có guard bất biến" → thật ra toàn schema chỉ có **5 trigger
  `tgenabled='A'`**, và chỉ **3** chặn DELETE (2 + 6 + 407 dòng). Phần còn lại bị
  vô hiệu bởi `SET LOCAL session_replication_role='replica'`, chạy được với role
  `postgres` không superuser.
- "Rủi ro không loại bỏ được: tiến trình khác sẽ ghi được thứ bình thường bị
  chặn" → **không tồn tại**. GUC theo transaction nên session khác không được
  nới; ba lệnh `ALTER TABLE … DISABLE TRIGGER` giữ khoá `SHARE ROW EXCLUSIVE`
  nên session khác ĐỢI chứ không lọt. Thứ thật sự xảy ra là ứng dụng đứng hình
  vài giây.
- "Điều kiện tiên quyết đã xong" → hết đúng sau khi GĐ6 sinh tham chiếu chéo
  mới. Nên transaction xoá tự đo lại tại chỗ.

Hai khuyết tật chỉ lộ ra nhờ diễn tập: `room_price_history` để lại 12 dòng mồ côi
(12 bảng không có cột `organization_id`, và ở chế độ replica thì `ON DELETE
CASCADE` cũng không chạy); và **deadlock ba lần liên tiếp** với runtime OpenClaw
— `lock_timeout` không cứu được, phải đoạt `organizations` rồi
`openclaw_runtime_cells` ngay đầu transaction để ép thứ tự khoá.

> **HỆ QUẢ CHƯA AI LƯỜNG — `scripts/measure-org-leak.mjs` nay KHÔNG chạy được.**
> Prod chỉ còn MỘT tổ chức có người dùng, nên "rò chéo tổ chức" thành khái niệm
> không đo được. Bộ đo fail-closed đúng cách (exit 3 = "số đo không đáng tin"),
> nhưng gate `Không rò dữ liệu xuyên tổ chức` trong `ci-gates.yml` là gate CHẶN
> trên `main` → sẽ đỏ ở lần push main tiếp theo.
> Cách chữa đã chọn: cho bộ đo TỰ DỰNG một tổ chức + người dùng tổng hợp bên
> trong `BEGIN…ROLLBACK` thay vì phụ thuộc vào org sandbox có sẵn trong
> production. Đó là phép thử MẠNH HƠN — một tổ chức vừa sinh ra phải thấy đúng 0
> dòng ở mọi bảng — và nó gỡ luôn sự phụ thuộc vào dữ liệu rác nằm trong prod.

Ghi chú: `auth.users` của các tài khoản `test.*` / `demo.*` KHÔNG bị đụng tới
(ngoài schema `public`). Membership của họ đã mất theo org, nên hiện là tài khoản
không thuộc tổ chức nào — xoá hay giữ là quyết định riêng.

---

**Bản ghi cũ của mục này, giữ để đối chiếu:**
CHƯA đủ điều kiện tiên quyết (đo lại 08/08 chiều).

Phạm vi hiện tại (`02-pham-vi-xoa-hai-org.sql`): **172 bảng dính**, **27.634 dòng
Test** + **136.790 dòng Demo** = 164.424 dòng. Bốn bảng nặng nhất đều là log
máy sinh của Demo: `network_interface_samples` 57.704, `openclaw_service_nonces`
34.811, `openclaw_health_events` 16.191, `network_device_samples` 7.213.

**Chặn cứng — phải vá trước:** `01-chung-minh-tach-roi.sql` trả về 1 đường vi phạm:

| Dòng | Thuộc org | Trỏ tới | Của org |
|---|---|---|---|
| `material_usage_items` `5657131d-caae-4d27-be2a-e2b2ba993385` | aaaa (thật) | `materials` `948c2493…` "Pin 3A" | **cccc (Test)** |

Cha của nó — `material_usages` `MU-20260801-0001` "thay pin remote máy lạnh cho
202-1392qt" — thuộc org aaaa. Tồn tại một bản "Pin 3A" SONG SINH thuộc đúng org
aaaa (`3ced8ddd-4000-4eb6-b677-28c834127ae5`, cùng code/unit/mô tả/`avg_unit_cost`
13175, cùng `created_at`), nhưng đã bị xoá mềm ngày 04/08 — tức lúc phát sinh lần
dùng vật tư (01/08) nó vẫn còn sống. `updated_at` của cả ba dòng đều đúng
`2026-08-08T02:06:25.952123+00:00` — dấu vết của chính lần điền `organization_id`
ở GĐ6: lần đó gắn nhãn aaaa cho dòng con theo cha, mà để nguyên `material_id`
trỏ sang vật tư của Test.

Cách vá (một migration forward, KHÔNG cần tắt guard — `material_usage_items` chỉ
có trigger tính lại `trg_mui_recompute`, không có guard bất biến nào): trỏ lại
`material_id` sang bản aaaa `3ced8ddd…`. `unit_cost_at_usage` = 13175 khớp cả hai
bản nên không đổi tiền.

Sau khi vá, vướng còn lại đúng như đã ghi: ~60 bảng có guard bất biến
(append-only / immutable / retention / freeze tài chính) chặn cả `DELETE` lẫn
`UPDATE`, và chúng gắn theo BẢNG chứ không theo công ty — tắt là tắt luôn cho sổ
sách công ty thật trong vài giây đó.
Phương án đề xuất, trọn trong một transaction: backup → tắt trigger → xoá → bật
lại → kiểm toàn vẹn khoá ngoại → **chỉ commit khi sạch**.
Rủi ro không loại bỏ được: trong cửa sổ vài giây đó, tiến trình khác ghi vào
database sẽ ghi được thứ bình thường bị chặn.
Cùng câu trả lời này gỡ nốt 345 dòng `invoice_audit_log` và làm 3.032 dòng
`public_room_events` hết đa nghĩa.

**2. Năm bảng miễn trừ — ĐÃ XONG 08/08 chiều, đã apply prod.**
`20260808090000_don_profiles_ma_va_rao_ba_bang_mien_tru.sql`.

Đo lại bằng bộ đo mới (nhân vật "tổ chức vừa sinh ra"), rồi xử theo đúng ba loại
vấn đề mà mục này đã phân:

| Bảng | người thật | tổ chức vừa sinh | Xử lý |
|---|---|---|---|
| `roles` | 5 / 0 | **0 / 0** | Rào. Miễn trừ đúng là đã quá thận trọng |
| `settings` | 5 / 0 | **0 / 0** | Vá 1 dòng org NULL rồi rào |
| `profiles` | 4 / 0 | 2 / **1** | Dọn 7 dòng ma rồi rào |
| `ai_providers` | 10 / 0 | 10 / **10** | GIỮ miễn trừ — dùng chung toàn hệ |
| `ai_copilot_settings` | 1 / 0 | 1 / **1** | GIỮ miễn trừ — như trên |

Phỏng đoán "`roles`/`settings` có thể đang được miễn trừ quá thận trọng" của mục
này là **đúng**, và nay đo được chứ không còn là phỏng đoán.

`profiles` nặng hơn mô tả cũ: không phải 7 dòng sai nhãn cần sửa theo membership,
mà là **7 người ma trong danh sách nhân sự của công ty thật** — 6 tài khoản
`demo.*` cộng một lượt đăng ký ế từ 26/04, tất cả mang `organization_id = aaaa`
mà không có membership nào, 0 việc / 0 hoá đơn / 0 hợp đồng. Đã xoá 7 dòng
`profiles` (KHÔNG đụng `auth.users`) rồi mới rào được.

Không đặt `NULL` để "gỡ nhãn sai": công thức biên giới có nhánh
`organization_id IS NULL`, nên đặt NULL biến chúng từ "thuộc nhầm một công ty"
thành "thuộc về tất cả" — tệ hơn hẳn.

Sau khi apply: `measure-org-leak` exit 0, rò đã khai còn **2**;
`build-org-boundary-inventory --check` exit 0, **316 relation · có biên giới 300
(từ 297) · miễn trừ 4 (từ 7) · không có cột org 12**.

---

**Bản ghi cũ của mục này, giữ để đối chiếu:**
Năm bảng miễn trừ còn rò (hạn 30/11) — ba loại vấn đề khác nhau.
`roles` (12 dòng / 3 tổ chức) và `settings` (13 / 3, còn 2 chưa gắn nhãn) là dữ
liệu THEO tổ chức thật — nhiều khả năng rào được bình thường, miễn trừ hiện tại
có thể đang quá thận trọng. `profiles` là lỗi DỮ LIỆU: 7 dòng sai nhãn, 6 sửa
được theo membership của chính chủ. `ai_providers` (10 dòng / 1 tổ chức) và
`ai_copilot_settings` (1 dòng, khoá chính boolean) là câu hỏi MÔ HÌNH — bảng này
thuộc về ai? Chọn sai thì Copilot mất cấu hình.

**3. 17 giây trên màn hình thanh toán — ĐÃ XONG 08/08 chiều, đã apply prod.**
Migration `20260808070000_cat_rls_long_man_thanh_toan.sql`. Đo trên production
thật SAU khi apply, 7 vai người dùng suy từ `organization_memberships`, ms
collections/allocations — số dòng nhìn thấy khớp CHÍNH XÁC giá trị trước khi đổi
ở cả 7 vai:

| Vai | Trước | Sau | Dòng (không đổi) |
|---|---|---|---|
| bosshuy (thật) | 11.648 / 14.821 | **608 / 365** | 188 / 193 |
| nathan (thật) | 10.743 / 11.628 | **668 / 382** | 155 / 163 |
| joey (thật) | 6.777 / 6.831 | **305 / 361** | 96 / 99 |
| super admin | 311 / 775 | **146 / 67** | 251 / 262 |
| test.nathan (cccc) | 11.095 / 9.886 | **653 / 665** | 14 / 16 |
| demo.chunha (dddd) | 547 / 386 | **331 / 378** | 3 / 5 |
| demo.ketoan (dddd) | 968 / 903 | **363 / 216** | 3 / 5 |

Hai điều bắt được, cả hai đều thành lỗi thật nếu làm ẩu — chi tiết trong đầu file
migration:

- **Quyền EXECUTE trong policy kiểm theo NGƯỜI GỌI, không theo chủ bảng.** Đặt
  hàm ở `public` rồi `REVOKE … FROM authenticated` theo đúng khuyến nghị F3 thì
  policy chết `42501`. Phải đặt ở `app_private`: hàm giữ EXECUTE mặc định cho
  PUBLIC, còn gọi thẳng bị chặn vì thiếu USAGE trên schema. **F3 mục 2 cần sửa
  lại theo đây** — "revoke rồi vẫn dùng được trong policy" là sai với hàm ở
  `public`.
- **Cắt RLS lồng làm NỚI QUYỀN nếu làm thẳng tay.** Super admin thấy thêm đúng
  3 collections / 5 allocations, vì `sandbox_org_ids()` chỉ chứa `cccc` còn org
  Demo `dddd` được giấu bởi `invoices_hide_demo_admin` lọc theo NGƯỜI DÙNG — và
  policy đó chỉ có trên `invoices`. Đã dựng lại thành hai policy
  `*_hide_demo_admin` tường minh trên chính hai bảng thanh toán.

Dư địa còn lại: sàn ~350ms là 51 lần gọi `can_v3` để dựng tập toà nhà. Hạ tiếp
được thì phải đụng vào chính chuỗi `can_access_building → can_v3`, việc đó ảnh
hưởng hàng chục bảng nên tách ra khỏi phạm vi này.

Chẩn đoán gốc, giữ lại để tra cứu:
`invoice_payment_allocations` chỉ có 235 dòng mà mất 17s;
`invoice_payment_collections` 14s. Nguyên nhân là **RLS lồng RLS**: policy
`SELECT` của bảng thứ nhất là `EXISTS (SELECT 1 FROM invoice_payment_collections …)`
— chạy cho TỪNG dòng — mà bảng thứ hai lại có policy đắt của riêng nó, bên trong
gọi chuỗi `can_access_building` → `can_v3`.
**KHÔNG phải do biên giới tổ chức**: gỡ policy biên giới ra vẫn 17,07s so với
18,08s khi có (chênh 5%). Ghi lại để không ai đổ tội nhầm.
Lời giải đã có tiền lệ ngay trong dự án: `building_of_invoice` /
`building_of_contract` là hàm `SECURITY DEFINER` dùng bên trong policy chính để
cắt RLS lồng. Bảng thanh toán chưa được chuyển sang cách đó.
Đây cùng họ với các cảnh báo `[perf] CHẬM …` đầy trong console.

**4. Hai test OpenClaw đỏ — ĐÃ XONG 08/08 chiều.**
`FULL_RESET_EXPECTED_FILE_COUNT = 498` / `..._DUPLICATE_VERSION_GROUPS = 18` đóng
băng từ 31/07, nay có 640 file. Không bump tay hai con số — làm vậy thì migration
sau lại đỏ tiếp. Thay bằng giá trị **dẫn xuất từ `supabase/migration-provenance.json`**
(`deriveFrozenPlanExpectations` / `readFrozenPlanExpectations` trong
`scripts/test-openclaw-full-reset.mjs`): bộ gác nay hỏi "kế hoạch reset có khớp
manifest ĐÃ ĐƯỢC DUYỆT không", chứ không hỏi "có đúng 498 file không". Manifest
vốn đã bị `gate:migration-provenance` gác sha256 từng file và chạy blocking trong
CI, nên phép so này vẫn là phép so thật chứ không tự soi mình.
Bằng chứng: `node scripts/test-openclaw-full-reset.mjs --plan-only` →
`PASS OpenClaw full-reset plan: 640-file chain`; `openclaw-full-reset-harness.test.mjs`
→ 15/15 xanh (trước đó 7/13 đỏ). Test dò trôi số vẫn còn: dựng kế hoạch thiếu
đúng một file thì bộ gác vẫn phải đỏ.
CHƯA chạy được `test:openclaw:sql:full-reset` (`--local`) vì nó cần Docker.

**5. Các giai đoạn kiến trúc còn lại — bức tranh đã đổi sau phiên 08/08 chiều.**

- **GĐ10 (Test/Demo chung database) — KHÔNG CÒN.** Hai tổ chức đã bị xoá, câu hỏi
  hạ tầng tự tan.
- **GĐ9 (frontend chưa có `OrganizationContext`) — ĐÃ XONG, đã apply prod.**
  `20260809030000` + `src/contexts/OrganizationContext.tsx` + `OrganizationBadge`.

  **Phải đi qua RPC, không đọc thẳng bảng.** Đo bằng vai người dùng thường:
  `SELECT count(*) FROM organization_memberships` → **0**, `FROM organizations`
  → **0**, trong khi `my_org_ids()` trả đúng. RLS hai bảng đó không cho người
  dùng thường đọc dòng của *chính mình*; gọi thẳng sẽ hiện "không thuộc tổ chức
  nào" cho MỌI người mà không có lỗi nào nổ ra. `get_my_organizations()` là
  `SECURITY DEFINER`, lọc theo `auth.uid()` trong thân và **không nhận tham số**
  — hàm bỏ qua RLS thì mọi tham số từ client đều là đường hỏi thay người khác.

  Nhãn tổ chức chỉ hiện khi **nhiều tổ chức** (lúc nhầm sổ là lỗi thật) hoặc khi
  **không thuộc tổ chức nào** — trạng thái này có thật: 6 tài khoản `demo.*` rơi
  vào đúng đó sau khi xoá hai tổ chức, và nếu không báo thì họ thấy màn hình
  trống mà tưởng hệ thống hỏng.

- **ĐIỂM MÙ THỨ HAI CỦA BỘ ĐO — ĐÃ ĐÓNG.** Phát hiện khi khảo sát GĐ9, và lớn
  hơn chính GĐ9. Công thức biên giới có nhánh `organization_id IS NULL` ⇒ dòng
  NULL **ai cũng thấy**; còn bộ đo định nghĩa "dòng của tổ chức khác" là
  `IS NOT NULL AND <> org mình` nên dòng NULL bị loại khỏi phép đếm **theo đúng
  định nghĩa**. Đo lần đầu: **3.621 dòng trên 15 bảng**, gồm 345 dòng nhật ký
  kiểm toán hoá đơn.

  Đã vá còn **92 dòng, cả 92 nằm trong 3 bảng đã khai là toàn hệ**
  (`cron_runs`, `ai_providers`, `ai_copilot_settings`) qua sổ mới
  `app_private.org_null_is_global`. Gate nay đếm dòng NULL và ĐỎ nếu bảng chưa
  khai.

  **Không** gắn `_autofill_org` diện rộng cho 84 bảng suy được, dù rất cám dỗ:
  nhánh cuối của hàm đó rơi về hằng số `aaaa`, nên gắn diện rộng sẽ làm gate xanh
  trong khi âm thầm dán nhãn "công ty thật" lên dữ liệu chưa ai xác minh. Còn
  **105 bảng vẫn NHẬN được NULL** — thứ canh chỗ đó là gate, không phải trigger.
- **GĐ7 (12 bảng không có cột `organization_id`) — ĐÃ ĐO XONG, KHÔNG CÓ RÒ; điểm
  mù của bộ đo đã đóng.**

  Câu hỏi cũ của GĐ7 là "thêm cột hay chặn qua cha". Đo ra thì câu hỏi đó đặt
  sai: **không bảng nào trong 12 bảng đang rò**, nên chưa cần thêm cột cho bảng
  nào cả. Đo bằng nhân vật tổ chức-vừa-sinh-ra — với bảng không có cột org thì
  không có gì để lọc, nên mọi dòng nó đọc được đều là của người khác, ngưỡng đúng
  là 0:

  | Bảng | Dòng thật | Tổ chức vừa sinh thấy |
  |---|---|---|
  | `permission_definitions` | 231 | 0 |
  | `lucky_event_teams` | 12 | 0 |
  | `room_price_history` | 4 | 0 |
  | `authorization_migration_exceptions` | 3 | 0 |
  | `organizations` | 2 | 0 |
  | `legacy_owner_allowlist` | 0 | 0 |
  | `push_send_log` | 108 | **từ chối quyền** |
  | `income_expense_type_reference_repair_audit` | 15 | **từ chối quyền** |
  | `network_workers` | 2 | **từ chối quyền** |
  | `network_worker_credentials` | 1 | **từ chối quyền** |
  | `network_worker_heartbeats` | 0 | **từ chối quyền** |
  | `network_outbox_deliveries` | 0 | **từ chối quyền** |

  **Nhưng trước 08/08 chiều thì đây là sạch KHÔNG AI CANH.** `measure-org-leak.mjs`
  dò bảng THEO cột `organization_id`, nên 12 bảng này chưa từng được quét lần nào;
  gate inventory xếp chúng vào `NO_ORG_COLUMN` và coi là "có chỗ đứng" — đúng về
  sổ sách, nhưng *có chỗ đứng* không phải *đã đo*. Nay bộ đo quét cả 12, và
  "chưa đo được" đi lối riêng (thoát mã 3) chứ không bị đọc thành "sạch".

  Chứng minh bộ đo không kiểm chính nó:
  [`04-p6-bo-do-co-keu-khong.sql`](../../scripts/org-split-prepared/04-p6-bo-do-co-keu-khong.sql)
  dựng một bảng rò thật trong `BEGIN…ROLLBACK` → bắt đúng nó, không bắt nhầm bảng
  nào khác.

  Việc CÒN LẠI của GĐ7 không phải rò mà là **toàn vẹn tham chiếu**: bài diễn tập
  xoá tổ chức cho thấy `room_price_history` để lại 12 dòng mồ côi khi cha bị xoá,
  vì nó không có cột org nên vòng xoá bỏ qua. Đã xử trong
  `20260808080000` bằng bước 3a (xoá theo cha, dừng nếu dòng bắc cầu sang tổ chức
  khác). Bảng nào sau này treo vào dữ liệu theo tổ chức mà không có cột org thì
  cùng lớp vấn đề đó.
- **GĐ0 mục 6a(i) — XOAY 334 MÃ CÔNG KHAI LÊN ≥16 KÝ TỰ: CHỦ DỰ ÁN ĐÃ QUYẾT
  KHÔNG LÀM (09/08/2026). ĐỪNG ĐỀ XUẤT LẠI.**

  Đây là việc duy nhất thực sự ĐÓNG được lỗ, và nó đã được cân nhắc rồi bỏ qua
  một cách có ý thức — không phải bị bỏ sót. Lý do đánh đổi: xoay mã làm chết
  mọi QR đã in và mọi link đã gửi cho khách, kể cả khi có cửa sổ ân hạn. Rủi ro
  còn lại được chấp nhận, và rate-limit ở GĐ-R là biện pháp giảm nhẹ đã chọn.

  **Rủi ro tồn đọng, ghi lại để không ai quên nó tồn tại:** 57⁶ = 34.296.447.249
  tổ hợp trên 334 mã sống ⇒ ~103 triệu lần thử cho một lần trúng; trúng thì lấy
  được họ tên khách, hoá đơn, phòng, toà nhà (số điện thoại đã bỏ ở
  `20260808100000`). Rate-limit đẩy chi phí lên ~32 năm **từ MỘT IP**, nhưng kẻ
  có nhiều IP chia nhỏ hạn mức ra là đi tiếp được.

  Nếu sau này muốn làm lại thì cần: `old_public_code` + `old_code_expires_at`,
  nhánh resolve chấp nhận mã cũ tới hạn, `CHECK (length(public_code) >= 16)`, và
  một đợt phát lại QR cho khách.

  *Phần dưới đây là bối cảnh lúc chưa quyết, giữ để đối chiếu:*

  Đo 08/08: cả 334 hợp đồng vẫn mang `public_code` **6 ký tự**, không có `CHECK`
  độ dài, không có cột ân hạn, hàm chưa lọc `revoked`. Bảng chữ cái 57 ký tự ⇒
  57⁶ = 34.296.447.249 tổ hợp trên 334 mã sống ⇒ trung bình ~103 triệu lần thử
  cho một lần trúng; trúng thì lấy được họ tên khách, hoá đơn, phòng, toà nhà.

  Kế hoạch từng lập luận "sau khi GĐ0 xoay mã lên ≥16 ký tự thì brute-force bất
  khả thi, nên rate-limit tụt xuống hàng phòng thủ chiều sâu". **Tiền đề đó sai**
  vì việc xoay chưa từng chạy. Nay đã có rate-limit đỡ, nhưng rate-limit theo IP
  không chống được kẻ có nhiều IP.

  Vì sao chưa làm: xoay mã **làm chết mọi QR đã in và đã gửi cho khách**. Phải
  kèm `old_public_code` + `old_code_expires_at` và nhánh resolve chấp nhận mã cũ
  tới hạn. Chọn độ dài cửa sổ ân hạn, và chấp nhận việc phải phát lại QR cho
  khách, là quyết định kinh doanh chứ không phải kỹ thuật.

- **GĐ-R (rate-limit) — ĐÃ THI HÀNH XONG, đã apply prod.**
  `20260808130000` (bộ đếm) + `20260808140000` (trả 429 thay vì 500).
  Không cần "một lớp server đứng trước PostgREST" như mục này từng viết.

  Đo trên production qua đúng đường HTTP anon: **59–60 lượt dò mã sai lọt, chặn
  từ lượt kế tiếp với HTTP 429 `rate_limited`**, và mã ĐÚNG cũng bị chặn ở IP đã
  vượt ngưỡng — đó chính là bằng chứng ngưỡng được kiểm TRƯỚC khi tra cứu. IP
  khác dùng được ngay.

  Ba quyết định thiết kế, mỗi cái có lý do đo được:
  1. **Chỉ đếm mã SAI.** Người xem hoá đơn của mình luôn gọi đúng mã (mã tới từ
     QR/link); kẻ dò thì gọi sai gần như 100%. Đếm mọi lượt gọi sẽ phạt người
     thật mà không thêm được gì.
  2. **Kiểm ngưỡng TRƯỚC khi tra cứu.** Đảo thứ tự là thủng đúng một lần mỗi cửa
     sổ — và một lần là đủ để lấy dữ liệu một khách.
  3. **Không có IP tin cậy thì không chặn.** Đường gọi nội bộ (job, migration)
     không có `request.headers`; chặn lúc đó là tự bắn vào chân mà chẳng chặn
     được ai, vì anon chỉ vào được qua PostgREST và qua đó thì luôn có
     `cf-connecting-ip`.

  Ngưỡng **60 mã sai / 10 phút / IP** — rộng tay có chủ ý vì khách sau cùng một
  NAT/4G dùng chung IP. Với kẻ dò: 8.640 lượt/ngày ⇒ ~103 triệu lần thử cần
  **~32 năm** cho một lần trúng, từ một IP.

  **Điều phải nói thẳng:** kẻ có nhiều IP (botnet, proxy xoay vòng) chia nhỏ hạn
  mức ra là đi tiếp được. Rate-limit nâng CHI PHÍ tấn công chứ **không đóng lỗ**.
  Thứ đóng lỗ là xoay mã lên ≥16 ký tự — xem mục dưới.

  Spike `20260808110000` (đã gỡ ngay bằng `20260808120000`) trả lời cả hai vế mà
  kế hoạch đòi phải chứng minh trước khi chọn:

  1. **`request.headers` CÓ phơi** — 25 khoá, gồm `x-forwarded-for`,
     `cf-connecting-ip`, `cf-ray`, `cf-worker`, `cdn-loop`, `sb-request-id`.
  2. **Hop CUỐI của XFF là đáng tin.** Gửi XFF giả rồi xem DB nhận gì: gửi
     `9.9.9.9` → DB thấy `"9.9.9.9,113.177.142.96"`; không gửi gì → DB thấy đúng
     `"113.177.142.96"`. Hạ tầng luôn nối IP thật vào cuối; phần đầu do client
     tự đặt nên dùng nó để đếm là **limiter giả**.
  3. **`cf-connecting-ip` không giả được** — cố giả thì **HTTP 403 từ chính
     Cloudflare**, request không tới được database.

  **Điều này lật mục 1(b) của GĐ-R**, vốn ghi "Cloudflare chỉ đứng trước
  chillhome.io.vn, không trước supabase.co". Sai — Cloudflare CÓ đứng trước
  `supabase.co`. Mục 1(a) (Vercel không nhìn thấy request) thì vẫn đúng.

  **Chọn Thiết kế A (thuần DB), loại Thiết kế B (edge function)** — và không
  phải vì A ít việc hơn. Điểm yếu cốt lõi của B là kẻ tấn công cứ POST thẳng
  `/rest/v1/rpc` là đi vòng qua limiter, nên B **bắt buộc** kèm REVOKE khỏi anon
  + sửa client + sửa allow-list + sửa edge-function-surface. A không có đường
  vòng nào, vì bộ đếm nằm BÊN TRONG chính hàm mà anon gọi.

  Điểm phải nhớ khi thi hành A: đếm theo `cf-connecting-ip` thì mọi khách sau
  cùng một NAT/4G-gateway dùng chung quota. Ngưỡng phải rộng tay, và phải đếm
  theo **mã SAI** chứ không phải mọi lượt gọi — người xem hoá đơn của chính mình
  gọi đúng mã, kẻ dò thì gọi sai liên tục.
- **Hai bảng `ai_providers` / `ai_copilot_settings` — ĐÃ XỬ, không cần công ty
  thứ hai.** Mục này từng ghi "câu hỏi MÔ HÌNH chỉ trả lời được khi có công ty
  thứ hai". Sai: **chính khoá chính đã trả lời**. `PRIMARY KEY (provider)` ⇒ toàn
  CSDL chỉ một dòng mỗi provider; `PRIMARY KEY (id boolean)` ⇒ tối đa hai dòng.
  Không thể có bản riêng cho từng công ty, nên nhãn `aaaa` trên chúng là **nhãn
  sai**. Đã gỡ về NULL, rào biên giới, rút khỏi sổ miễn trừ (`20260809010000`).

- **`ai_chat_threads` / `ai_chat_messages` — ĐÃ XONG. Sổ miễn trừ nay RỖNG.**
  `20260809040000`. Lý do miễn trừ cũ: `chatEngine.ts` insert không set
  `organization_id` nên rào là chặn chính đường ghi của mình. Vá ở **tầng
  database** chứ không ở client — sửa client chỉ chặn được một đường ghi, trigger
  chặn mọi đường.

  `app_private.autofill_org_chat()` **fail-closed**: suy được thì điền, không suy
  được thì NỔ. Cố ý không dùng `_autofill_org` dùng chung vì nhánh cuối của hàm
  đó rơi về hằng số `aaaa`. Hậu quả không đối xứng: một tin nhắn Copilot không
  lưu được là phiền, còn một tin dán nhầm nhãn công ty là dữ liệu sai vĩnh viễn
  trong bảng chỉ-ghi-thêm.

  Ba nguồn giảm dần độ tin: client tự khai (nhưng **kiểm lại** người đó có
  membership ACTIVE ở tổ chức được khai) → tổ chức của luồng cha → membership duy
  nhất. Client truyền `organizationId` từ `OrganizationContext`, chỉ thật sự cần
  với người thuộc nhiều tổ chức.

---

## Bản án về 10 finding

| Mã | Review chấm | Kiểm chứng | Mức thật |
|---|---|---|---|
| F1 event-trigger-va-ci-gate | critical | **BỊ BÁC** | low |
| F2 exemptions-seed-qua-muon | critical | **ĐÚNG MỘT PHẦN** | high |
| F3 building-of-star-dependency | high | **ĐÚNG MỘT PHẦN** | medium |
| F4 vi-pham-forward-only | high | **ĐÚNG** | medium |
| F5 harness-local-khong-replay-duoc | high | **ĐÚNG MỘT PHẦN** | high |
| F6 generator-bo-sot-partitioned-va-rls | high | **ĐÚNG** | high |
| F7 rate-limit-khong-co-kien-truc | high | **ĐÚNG MỘT PHẦN** | medium |
| F8 pii-that-trong-tai-lieu | high | **ĐÚNG** | medium |
| F9 dod-gd2-khong-khop-khoi-luong | medium | **ĐÚNG MỘT PHẦN** | high |
| F10 baseline-so-dong-khong-on-dinh | medium | **ĐÚNG MỘT PHẦN** | medium |

### Vì sao từng finding được kết luận như vậy

#### F1 — event-trigger-va-ci-gate

**BỊ BÁC** · review chấm `critical`, mức thật `low`

Lõi của F1 — "GĐ4 không triển khai được vì postgres không tạo được EVENT TRIGGER" — bị bác bỏ bằng thực nghiệm trực tiếp trên chính production. Review đúng ở hai dữ kiện tiền đề (postgres có rolsuper=false; cả 6 event trigger hiện hữu đều do supabase_admin sở hữu) nhưng suy luận từ đó ra kết luận thì sai. Supabase nạp extension supautils với supautils.privileged_role=supabase_privileged_role, và postgres LÀ thành viên của role đó — cơ chế này cho phép non-superuser tạo event trigger, đúng thứ luật Postgres thuần cấm. Tôi đã chạy thật trong BEGIN…ROLLBACK: CREATE EVENT TRIGGER thành công, evtowner = postgres (không phải supabase_admin), và trigger FIRE thật trên CREATE TABLE. Chạy tiếp bài đo đúng kịch bản GĐ4 thì bảng mới có organization_id tự nhận policy RESTRICTIVE (polpermissive=false) FOR ALL (polcmd='*'), bảng ALTER thêm cột organization_id cũng nhận, bảng không có cột org thì không bị đụng — tức toàn bộ "CHỐT MẠNH NHẤT" ở dòng 151 chạy được trên prod. Lane migration cũng chính là role này: scripts/apply-reviewed-migration.mjs (migrate:forward) gọi Management API, mà Management API chạy bằng current_user='postgres'. Phần (d) của review thì đúng về sự kiện nhưng bị thổi mức: security-gates ở ci-gates.yml quả thật chỉ chạy trên push/dispatch nhánh main và đọc catalog prod — nhưng đó là tầng PHÁT HIỆN, còn tầng CƯỠNG CHẾ trước-khi-lên-prod chính là event trigger mà review tưởng đã chết. Đổi lại, tôi tìm được một khuyết tật thật mà review không thấy: event trigger viết đúng như plan mô tả sẽ ĐỆ QUY VÔ HẠN (stack depth limit exceeded), vì ALTER TABLE … ENABLE ROW LEVEL SECURITY phát ra bên trong ddl_command_end lại kích hoạt chính nó.

**Phải sửa thành:** Finding F1 phải bị BÁC ở phần lõi: xoá khẳng định "không tạo được event trigger" và hạ mức critical. Nhưng đừng vứt cả finding — giữ lại phần (d) ở mức low và thay vào ba sửa đổi CÓ CĂN CỨ ĐO ĐƯỢC: 1. GĐ4 mục 3 (dòng 151) — BẮT BUỘC thêm guard chống tái nhập, nếu không migration sẽ chết ngay lần CREATE TABLE đầu tiên với lỗi 54001. Khuôn đã chứng minh chạy: IF coalesce(current_setting('app.org_boundary_guard', true),'') = 'on' THEN RETURN; END IF; PERFORM set_config('app.org_boundary_guard','on', true); … EXECUTE ALTER TABLE … ENABLE RLS; EXECUTE CREATE POLICY … ; PERFORM set_config('app.org_boundary_guard','off', true); Lý do: ENABLE ROW LEVEL SECURITY tự nó là một ddl_command_end nên gọi lại chính hàm. 2. GĐ4 mục 5 (dòng 154) — tách MẪU DÒ khỏi THÂN POLICY. Dò bảng theo '%organization_id' để không bỏ sót, nhưng CHỈ sinh policy chuẩn khi có cột tên đúng 'organization_id'; bảng chỉ có source_/target_organization_id phải bị đẩy sang nhánh "chưa phân loại" và làm gate ĐỎ, chứ không được sinh policy tham chiếu cột không tồn tại (đã tái hiện lỗi 42703). 3. GĐ4 "Xong khi" mục 1 (dòng 159) — đổi "Ở bản local" thành "trên prod trong BEGIN…ROLLBACK". Đây chính là chỗ review có lý về tinh thần: local Supabase chạy postgres LÀ superuser nên bài đo local xanh không chứng minh được gì về quyền trên prod. Bài đo đúng là bài tôi đã chạy ở (4c). Trả lời câu "làm sao chặn bảng mới thiếu boundary TRƯỚC khi lên production": event trigger ĐÃ trả lời — nó gắn boundary trong CÙNG transaction với CREATE TABLE lúc apply, nên không tồn tại khoảnh khắc nào bảng sống trên prod mà thiếu biên giới. Đó mạnh hơn "chặn trước" vì nó không thể bị quên. Nếu vẫn muốn chặn ở CI (khuyến nghị, mức thấp): (a) thêm bước gate:org-boundary chạy ở job quality-gates (không cần secret) đọc TĨNH thư mục supabase/migrations, đỏ khi có CREATE TABLE … organization_id mà không có dòng miễn trừ tương ứng — job này chạy trên PR, khác với security-gates dòng 534 vốn chỉ chạy sau push main; (b) hoặc dựng DB dùng-một-lần (repo đã có SUPABASE_TYPES_LOCAL_ENGINE=pglite ở ci-gates.yml dòng 350) rồi apply lane forward và kiểm pg_policy. Lưu ý riêng: gate đọc prod sau push còn lệch pha hơn review nghĩ, vì supabase-migrat…

**Gánh nặng:** Nhỏ đối với việc sửa review (bỏ finding critical, hạ xuống ghi chú). Nhỏ–vừa đối với việc vá plan: thêm guard chống đệ quy + tách mẫu-dò khỏi thân-policy trong app_private.ensure_org_boundary_v1() là vài chục dòng SQL, đã có bản chạy được chứng minh ở mục (4c). Việc đổi "Xong khi" từ đo-ở-local sang đo-trên-prod là sửa một câu. Riêng đề xuất bổ sung tầng chặn pre-apply (disposable DB) là vừa, nhưn…

#### F2 — exemptions-seed-qua-muon

**ĐÚNG MỘT PHẦN** · review chấm `critical`, mức thật `high`

Lõi của F2 ĐÚNG và tôi tái lập được bằng đo thật. GĐ4 (Giai đoạn 5) có 7 bước: bước 1 TẠO bảng app_private.org_boundary_exemptions, bước 2 chạy vòng lặp sinh boundary theo catalog, bước 3 gắn event trigger ddl_command_end — không có bước nào SEED. Cả ba nằm trong CÙNG một file migration (<ts>_org_boundary_catalog_generator.sql), nên một lần migrate:forward là bảng miễn trừ vừa sinh ra đã RỖNG và generator quét ngay lên nó. Tôi xác nhận trên prod: app_private.org_boundary_exemptions HIỆN CHƯA TỒN TẠI, tức lần chạy đầu chắc chắn rỗng theo cấu trúc chứ không phải theo may rủi. GĐ9 nằm ở Giai đoạn 10, tức SAU GĐ4 năm giai đoạn, và mục tiêu GĐ9 tự viết nguyên văn "cơ chế tự động ở GĐ4 sẽ dập policy vào đó và giết tính năng" — plan tự mâu thuẫn về thứ tự. Nhưng review chấm QUÁ NẶNG ở một chỗ và DIỄN GIẢI SAI CƠ CHẾ ở một chỗ. Thứ nhất, plan KHÔNG mù: Nguyên tắc 2 (dòng 55) đã kể tên ai_providers/ai_copilot_settings, Rủi ro #2 (dòng 289) ghi thẳng "Bắt buộc: GĐ9 xong TRƯỚC khi ba bảng đó được siết", Rủi ro #7 (dòng 299) bắt nhóm dùng chung phải nằm trong bảng miễn trừ. Kiến thức có đủ ở ba chỗ; thiếu là một BƯỚC THI HÀNH trong danh sách "Việc cần làm" của GĐ4 và một thứ tự giai đoạn khớp với nó — nghiêm trọng thật, vì người thi hành đọc danh sách việc chứ không đọc phụ lục rủi ro, nhưng đây là lỗi thứ tự/thiếu bước, không phải lỗ hổng chưa ai biết, và vá chỉ tốn một câu INSERT đặt trên vòng DO. Thứ hai, phần Copilot mà review dựa vào là hỏng TIỀM ẨN chứ không phải hỏng SỐNG: ai_copilot_entitlements chỉ có ĐÚNG 1 dòng và chủ nó là 90450d5f — super admin — mà công thức boundary có nhánh is_super_admin() nên anh ta không mất gì; hôm nay không người dùng thật nào mất Copilot. Ngược lại, thứ hỏng SỐNG và NẶNG HƠN review nêu lại là profiles: demo.chunha mất chính dòng profile CỦA MÌNH (1 → 0), và 7/15 dòng profiles toàn hệ mang organization_id không nằm trong membership ACTIVE của chủ nó, 0/7 là super admin. Thứ ba, review quy nguyên nhân cho "user thuộc nhiều tổ chức" là chưa đúng cơ chế: toàn prod chỉ có MỘT người hai org (90450d5f) và người đó là super admin nên boundary tha; thứ thật sự khoá nhầm là NHÃN LỆCH trên dòng profiles của 6 tài khoản DEMO (profile_org=aaaa nhưn…

**Phải sửa thành:** Sáu việc, thi hành được ngay: 1. TÁCH BƯỚC 1 CỦA GĐ4 THÀNH 1a/1b VÀ ÉP THỨ TỰ VẬT LÝ TRONG FILE. Trong `<ts>_org_boundary_catalog_generator.sql`: (1a) CREATE TABLE app_private.org_boundary_exemptions; (1b) INSERT seed đầy đủ; CHỈ SAU ĐÓ mới tới vòng `DO $$ ... LOOP` của bước 2 và `CREATE EVENT TRIGGER` của bước 3. Thêm ngay trước vòng DO một chốt tự vệ: `IF (SELECT count(*) FROM app_private.org_boundary_exemptions) = 0 THEN RAISE EXCEPTION 'seed miễn trừ rỗng — từ chối chạy generator'; END IF;` — đây là phiên bản của "sàn chống rỗng-vô-nghĩa" mà plan đã có ở bước 6 nhưng chỉ áp cho gate, chưa áp cho generator. 2. DANH SÁCH SEED TỐI THIỂU (mỗi dòng kèm reason là con số đo được, không phải lời khai): - `ai_providers` — reason 'bảng global, PK là PRIMARY KEY(provider) không chứa organization_id; đo: demo.chunha 10→0, .eq(enabled,true)→0 nên dropdown model rỗng'. replacement_policy: NULL (dùng chung có chủ ý). - `ai_copilot_settings` — reason 'PK(id boolean) nên toàn CSDL tối đa 2 dòng; đo: 1→0 nên maybeSingle() trả null'. - `profiles` — reason 'nhãn lệch: 7/15 dòng mang org không nằm trong membership ACTIVE của chủ, 0/7 là super admin; đo: demo.chunha 7→0 và MẤT CHÍNH DÒNG CỦA MÌNH (own 1→0)'. replacement_policy: ghi tên đường đọc thật đang dùng — current_visible_owner_ids()/same_team() — và gate GĐ4 phải kiểm hai hàm đó TỒN TẠI THẬT (bước 4c của plan đã có sẵn cơ chế này). - `roles` — reason 'bản ghi theo người; đo demo.chunha 7→2'. - `settings` — reason 'bản ghi theo người, còn 2 dòng NULL org; useSettings.ts đọc chỉ lọc theo key nên đổi lực lọc là đổi cardinality của maybeSingle() → đúng lớp lỗi PGRST116 trang trắng plan đã ghi'. - `ai_chat_threads`, `ai_chat_messages` — reason 'không DEFAULT, không trigger autofill, chatEngine.ts insert không set organization_id'. expires_at đặt bằng ngày dự kiến vá chatEngine.ts + mở rộng trg_autofill_org, và PHẢI trước mốc GĐ5. - `ai_copilot_entitlements`, `ai_usage_logs` — cùng hình dạng theo-người/theo-owner, tác động sống thấp nhưng phải được PHÂN LOẠI tường minh thay vì để generator tự quyết. BỎ khỏi danh sách seed: `permission_definitions`, `legacy_owner_allowlist`, `authorization_migration_exceptions` — đo được là chúng…

**Gánh nặng:** Nhỏ. Phần lõi là một câu INSERT seed ~9 dòng đặt phía trên vòng `DO $$` trong CÙNG file migration đã có trong kế hoạch, cộng một `IF count=0 THEN RAISE` bốn dòng — không thêm file, không thêm migration, không đổi kiến trúc. Ba việc phụ có chi phí thật nhưng vẫn nhỏ: (a) thêm phép so visible_own trước/sau vào scripts/check-org-boundary-coverage.mjs — tái dùng nguyên hạ tầng scripts/measure-org-leak…

#### F3 — building-of-star-dependency

**ĐÚNG MỘT PHẦN** · review chấm `high`, mức thật `medium`

Lõi của F3 đúng ở hai vế, nhưng vế mà review dùng làm kết luận chính thì SAI. ĐÚNG vế (a)/(b): plan khẳng định ba hàm "chỉ được policy RLS gọi" là sai sự thật — trên prod có 2 thân hàm SECURITY DEFINER (approve_contract_termination_v1, reject_contract_termination_v1) gọi public.building_of_contract, và tôi đã chứng minh sống rằng sau khi ALTER ... SET SCHEMA app_private thì lời gọi này vỡ với 42883. ĐÚNG vế (d): proacl cả ba hàm có mục PUBLIC ('=X/postgres'), mà plan bước 2 và 3 chỉ revoke anon+authenticated; tôi đã chạy thử và sau lệnh revoke đúng như plan viết, has_function_privilege('authenticated', ...) VẪN true — tức bước vá đó là no-op bảo mật hoàn toàn, lỗ hổng vẫn mở trong khi plan tuyên bố đã đóng. Đây mới là phần giá trị nhất của finding, và trớ trêu là plan bước 1 lại viết đúng "FROM PUBLIC, anon, authenticated" nên đây là mâu thuẫn nội bộ chứ không phải thiếu hiểu biết. SAI vế (c)/(e): review suy từ "app_private không cấp USAGE cho authenticated" ra "di chuyển sẽ làm vỡ runtime" — sự kiện đúng nhưng suy luận sai. Postgres đánh giá biểu thức policy bằng quyền CHỦ BẢNG (RTE checkAsUser), nên đúng như plan nói. Tôi đã dựng thử nghiệm đối chứng: role authenticated (rolbypassrls=false) SELECT qua policy gọi hàm app_private thì chạy tốt và lọc đúng 1/3 dòng, trong khi CHÍNH role đó gọi thẳng hàm đó thì bị chặn 42501. Mạnh hơn nữa, prod hiện đã có 111 policy trên 57 bảng gọi app_private.* — ngay chính qual của building_of_contract đã gọi app_private.buildings_for_v3 bên cạnh. ALTER SET SCHEMA giữ nguyên OID nên 35 policy tự bám theo, không cần viết lại. Vậy chỗ vỡ thật là hẹp và khác hẳn lý do review nêu: vỡ do phân giải TÊN trong 2 thân hàm, không phải do quyền, và không đụng tới 38 policy. Hạ từ high xuống medium vì hậu quả nặng nhất mà review dự báo đã bị bác, còn phần đúng thì sửa rất nhỏ. Ghi chú: số dòng 673 review trích là CHÍNH XÁC, không lệch; nhưng con số "121 tham chiếu" thì lệch (thực tế 146 toàn repo / 111 trong migrations).

**Phải sửa thành:** 1. SỬA CÂU SAI TRONG PLAN (2 chỗ): dòng 79 và dòng 378 — bỏ "Chúng chỉ được policy RLS gọi". Thay bằng: "38 policy/10 bảng gọi ba hàm này (tự bám theo OID khi SET SCHEMA, không cần sửa), CỘNG 2 thân RPC SECURITY DEFINER approve_contract_termination_v1 và reject_contract_termination_v1 hard-code public.building_of_contract — phải CREATE OR REPLACE hai hàm này trong CÙNG migration, nếu không sẽ 42883." 2. VÁ LỖ PUBLIC (bắt buộc — nếu không thì bước vá là no-op): REVOKE EXECUTE ON FUNCTION public.building_of_invoice(uuid), public.building_of_contract(uuid), public.building_of_payment(uuid) FROM PUBLIC, anon, authenticated; Áp dụng CÙNG sửa cho plan bước 3 (customer_in_my_scope(uuid,uuid), ie_item_restricted_visible(uuid)) — hai hàm đó cũng chỉ ghi "anon + authenticated". Phải kiểm proacl của chúng trước khi viết migration. Lưu ý thứ tự: REVOKE FROM PUBLIC trước, rồi mới ALTER SET SCHEMA (hoặc ngược lại cũng được, nhưng phải có PUBLIC). 3. DI CHUYỂN: dùng ALTER FUNCTION ... SET SCHEMA app_private (KHÔNG dùng DROP + CREATE — DROP sẽ kéo theo lỗi phụ thuộc 38 policy hoặc phải CASCADE làm mất policy). SET SCHEMA giữ OID nên policy tự theo, đã kiểm chứng. 4. SỬA 2 RPC: viết migration MỚI có CREATE OR REPLACE FUNCTION public.approve_contract_termination_v1 và public.reject_contract_termination_v1, đổi public.building_of_contract → app_private.building_of_contract. TUYỆT ĐỐI không sửa file lịch sử supabase/migrations/20260731070000_current_date_to_org_today.sql (migration đã chạy là bất biến). Kiểm luôn proconfig/search_path của hai hàm này khi replace. 5. GATE TRƯỚC KHI CHẠY: chạy lại truy vấn quét pg_proc.prosrc ~* 'building_of_(invoice|contract|payment)' ngay tại thời điểm migrate để bắt hàm mới phát sinh sau lần đo này (hôm nay là đúng 2 hàm). Nên đưa hẳn truy vấn này thành assert trong migration: nếu còn hàm nào ngoài app_private tham chiếu tên cũ thì RAISE. 6. RATCHET (plan bước 4): scripts/check-definer-acl.mjs + scripts/definer-acl-baseline.json phải kiểm cả mục PUBLIC ('=X/...' không tên role), không chỉ anon/authenticated — nếu chỉ soi anon thì đúng lỗ hổng vừa chứng minh sẽ lọt qua CI. 7. types.ts: chạy npm run gen:types (theo đúng cách CI làm, KHÔNG redirect '…

**Gánh nặng:** Nhỏ. Toàn bộ nằm gọn trong MỘT migration mới: 1 lệnh REVOKE ... FROM PUBLIC, anon, authenticated (3 hàm, cộng 2 hàm ở bước 3 của plan), 3 lệnh ALTER FUNCTION ... SET SCHEMA app_private, và 2 lệnh CREATE OR REPLACE cho approve_/reject_contract_termination_v1 (chỉ đổi tên schema trong 1 dòng mỗi hàm). 38 policy KHÔNG phải đụng tới — đã kiểm chứng chúng tự bám theo OID. 111 occurrence trong supabase/…

#### F4 — vi-pham-forward-only

**ĐÚNG** · review chấm `high`, mức thật `medium`

Tôi đã kiểm chứng cả ba vế và cả ba đều đúng, kể cả số dòng review trích (contract không phải file bị sửa nên số dòng còn nguyên). (a) PROJECT_CONTRACT.md:209-210 cấm minh thị "Không sửa file lịch sử đã deploy", và dòng 449 nằm trong §11 "Những gì agent KHÔNG được tự làm" ghi "Sửa hay đổi tên migration đã deploy". (b) GĐ0 của plan (dòng 82) yêu cầu nguyên văn "phải sửa cả migration nguồn, không chỉ dữ liệu", và dòng 86 liệt kê thẳng file 20260802235000_share_token_dsphongtrong_alias.sql vào mục "File chính" — đây là chỉ thị sửa, không phải tham chiếu. File này có version 20260802235000 ≤ provisionalCutoff 20260805120000, tức thuộc diện legacyPolicy "legacy-frozen: CHỈ ĐỌC. Không sửa, không đổi tên, không di chuyển". Tôi cũng truy vấn production (chỉ SELECT) và thấy token 'dsphongtrong' đang sống đúng org — nghĩa là DML của file ĐÃ nằm trong prod thật, nên chữ "đã deploy" của review đúng về thực chất dù provenance xếp state="unknown" (file chỉ ALTER/DML nên không tự chứng minh được). (c) Điểm review chưa tính: lane TỰ CHẶN ba lớp — apply-reviewed-migration.mjs:249-256 từ chối apply file ≤ cutoff; check-migration-provenance.mjs:111-121 fail khi bytes file legacy đổi; và bước này chạy blocking trong ci-gates.yml:136-138 (không continue-on-error). Vì vậy chỉ thị của GĐ0 không thể chạm production, nó chỉ làm CI đỏ — mức "high" hơi nặng, thực chất là medium. Nhưng vẫn là lỗi thật vì còn một đường rửa: generate-migration-provenance.mjs:338 tính lại sha256 từ đĩa vô điều kiện, không hề kiểm cutoff, nên agent nào sửa file legacy rồi chạy `provenance:generate --write` (đúng lệnh mà gate gợi ý cho lỗi anh em) sẽ làm gate xanh trở lại và phá luôn đường cơ sở toàn vẹn của manifest. Thêm nữa, lý do biện minh của chính plan tự mâu thuẫn: nỗi lo "file cũ replay sẽ mở lại token yếu" đã được giải quyết bởi chính CHECK length(token) >= 16 mà GĐ0 đề xuất ở cùng câu — có CHECK thì replay sẽ ERROR (fail-closed) chứ không âm thầm mở lại, nên không cần sửa file nguồn.

**Phải sửa thành:** Sửa 2 chỗ trong docs/plans/PLAN-TACH-DU-LIEU-DA-CONG-TY.md, không đụng code. A. Viết lại dòng 82 (GĐ0 việc 5) thành forward-only, bỏ hẳn mệnh đề "phải sửa cả migration nguồn": "5. public_room_share_tokens — làm HOÀN TOÀN bằng MỘT migration forward-fix mới `<ts>_share_token_hardening.sql`. TUYỆT ĐỐI không chạm 20260802235000_share_token_dsphongtrong_alias.sql: version 20260802235000 ≤ provisionalCutoff 20260805120000 nên nó là legacy-frozen (migration-policy.json §provisionalCutoff.legacyPolicy), và Contract §5 (dòng 209-210) + §11.4 (dòng 449) cấm sửa migration đã deploy. Nội dung file mới, theo đúng thứ tự: (a) UPDATE public_room_share_tokens SET revoked=true WHERE token IN ('demo','dsphongtrong'); (b) INSERT token thay thế ngẫu nhiên ≥16 ký tự cùng owner_id/organization_id, ghi lại link mới để cập nhật nơi phát hành; (c) xử lý 1 dòng organization_id IS NULL (hiện là token '7i2oKN'): gán đúng org hoặc xoá, rồi ALTER COLUMN organization_id SET NOT NULL; (d) ALTER TABLE ... ADD CONSTRAINT public_room_share_tokens_token_len_chk CHECK (length(token) >= 16) NOT VALID, rồi VALIDATE CONSTRAINT sau khi (a)(b)(c) xong. Apply qua `npm run migrate:forward` (dry-run mặc định, `--apply` cần biên nhận backup vì PITR đang tắt). CHÍNH CHECK ở (d) là thứ THAY THẾ nhu cầu sửa file nguồn: nếu file cũ có bị replay ở bản local (GĐ1 việc 6 dựng DB từ supabase/migrations), INSERT 'dsphongtrong' (12 ký tự) sẽ ERROR chứ không âm thầm mở lại token yếu — fail-closed thay vì fail-open, đúng nguyên tắc thiết kế số 1 của chính kế hoạch này." B. Sửa dòng 86 ("File chính" của GĐ0): BỎ `supabase/migrations/20260802235000_share_token_dsphongtrong_alias.sql` khỏi danh sách, thay bằng `supabase/migrations/ (migration mới: <ts>_share_token_hardening.sql)`. Nếu vẫn muốn giữ để tra cứu thì phải chú thích rõ "(CHỈ ĐỌC — legacy-frozen, tham chiếu bối cảnh, KHÔNG sửa)". C. Hai việc nên làm kèm để lỗi này không tái diễn: - Thêm một dòng vào mục "Nguyên tắc thiết kế" (quanh dòng 51-68): "Mọi file supabase/migrations có version ≤ 20260805120000 là CHỈ ĐỌC. Mọi thay đổi hành vi, kể cả thu hồi token và siết ACL, đi bằng file mới qua `npm run migrate:forward`." Kế hoạch dài 10 giai đoạn mà không có câu này t…

**Gánh nặng:** Nhỏ. Phần bắt buộc chỉ là sửa 2 dòng văn bản trong một file docs (dòng 82 và 86 của PLAN-TACH-DU-LIEU-DA-CONG-TY.md) — không đụng code, không đụng DB, không cần migration nào chỉ để sửa finding này. Việc thay thế (viết `<ts>_share_token_hardening.sql`) vốn đã nằm trong khối lượng GĐ0 rồi, chỉ là chuyển đích đến từ "sửa file cũ + file mới" thành "chỉ file mới", nên gần như không phát sinh công. Hai…

#### F5 — harness-local-khong-replay-duoc

**ĐÚNG MỘT PHẦN** · review chấm `high`, mức thật `high`

Lõi của F5 ĐÚNG và tôi tự chứng minh được cả hai vế. Vế một: Contract §5 đúng dòng 215 (review không lệch dòng ở chỗ này) tuyên bố "Legacy history KHÔNG replay được"; tôi đo lại còn tệ hơn con số Contract ghi — 632 file .sql, 36 nhóm trùng version (016 ×4), ledger prod chỉ 372 dòng. Vế hai: plan nói "dựng DB từ supabase/migrations" ĐÚNG HAI LẦN (dòng 101 GĐ1 và dòng 256 TẦNG 1), và trong toàn bộ 143KB plan đếm được 0 lần nhắc pg_dump / bootstrap / snapshot / pglite / "supabase start" / "db push" / trùng version — tức plan hoàn toàn không biết ràng buộc này tồn tại. Đòn chí mạng là chính tiền lệ mà plan tự viện dẫn lại bác bỏ plan: `npm run test:openclaw:sql:local` KHÔNG dựng DB từ supabase/migrations mà dùng PGlite + một fixture bootstrap chép tay + đúng 12 file trong danh sách `OPENCLAW_MIGRATIONS`. Hai chi tiết review sai. Thứ nhất là quy sai chủ: `network-center-platform-bootstrap.sql` là của Network Center chứ không phải OpenClaw; bootstrap của OpenClaw là `OPENCLAW_DISPOSABLE_FIXTURE_SQL`, còn OpenClaw E2E lại đi đường thứ ba là pg_dump. Thứ hai, và nặng hơn, là hướng sửa đã lạc hậu so với repo: review bảo "GĐ1 cần thiết kế bootstrap tương tự hoặc dùng schema snapshot" trong khi ADR-0002 đã giao đúng thứ đó từ 06–07/08/2026 — `supabase/baseline/` với schema.sql 5,5MB, roles.sql, diễn tập khôi phục đạt 439/439 bảng và 1193/1193 policy. Nên việc của GĐ1 không phải "thiết kế bootstrap" mà là "trỏ vào baseline". Đổi lại, review bỏ sót một chốt chặn thật: `supabase/baseline/schema.sql` nằm trong .gitignore dòng 115, nên lời hứa "TẦNG 1 chạy MỌI PR, không cần PAT, không bao giờ chạm prod" hiện KHÔNG thực hiện được — CI không có file để dựng. Mức high là đúng, không quá nặng: GĐ1 là móng của cả 10 giai đoạn, và TẦNG 1 được chính plan gọi là "tầng DUY NHẤT đo được chiều GHI".

**Phải sửa thành:** Sửa plan ở đúng hai chỗ đã trích (dòng 101 và dòng 256), thay cụm "dựng DB từ supabase/migrations" bằng một quy trình dựng cụ thể, và bổ sung một mục "Ràng buộc: lịch sử migration không replay được" vào phần Nguyên tắc thiết kế để không ai viết lại câu đó. 1. NGUỒN SCHEMA — dùng lại thứ đã có, không thiết kế bootstrap mới. Harness dựng theo đúng ba bước của supabase/baseline/README.md: (a) `psql -v ON_ERROR_STOP=1 -f supabase/baseline/roles.sql`; (b) `psql -v ON_ERROR_STOP=0 -f supabase/baseline/schema.sql`; (c) chạy lại schema.sql LƯỢT 2 (bắt buộc — lượt 1 rơi rooms.name_sort và 3 view phụ thuộc); (d) apply tiếp CHỈ những migration có version > cutoff trong supabase/migration-policy.json. Tuyệt đối không quét cả thư mục supabase/migrations, không đụng supabase/migrations-archive (Contract dòng 218 + 449). 2. GIẢI CHỐT CHẶN .gitignore:115 — đây là việc phải làm trước, nếu không TẦNG 1 không thể "chạy mọi PR, không cần PAT". Chọn một trong ba, ghi thẳng vào plan: (i) commit `supabase/baseline/schema.sql.zst` (5,5MB thô, nén zstd còn cỡ vài trăm KB) rồi bỏ dòng 115 khỏi .gitignore cho biến thể nén; (ii) đẩy schema.sql thành release asset / CI cache artifact, kèm gate đối chiếu sha256 với manifest.json (đã có sẵn trường sha256 `349d9ec7…`); (iii) nếu cả hai không được thì hạ lời hứa TẦNG 1 xuống "chạy nightly + trước migrate:forward" thay vì "MỌI PR" — nhưng phải nói ra, không được để lời hứa sai trong tài liệu. 3. VEHICLE — Docker `supabase/postgres:17.6.1.156`, đúng image `oc-harness` trong scripts/openclaw-local-stack.mjs, bind 127.0.0.1 (án lệ Docker chọc thủng UFW ghi ở openclaw-local-stack.mjs:20-21). KHÔNG dùng PGlite cho tầng này: prod có pg_cron, supabase_vault, vector, btree_gist và cần schema auth thật. Tái dùng luôn scripts/dien-tap-khoi-phuc-baseline.mjs làm bộ dựng (nó đã có chốt cứng từ chối connection string chứa project ref production) — thêm cờ `--dich-tam` để nó tự dựng container thay vì đòi connection string. 4. QUY MÔ CẦN PHỦ — nêu số trong plan: 316 bảng public (baseline manifest), trong đó 390 bảng có organization_id và 182 bảng vừa có organization_id vừa GRANT SELECT cho authenticated (tôi đo lại khớp đúng con số 182 plan đang ghi). Vai cần …

**Gánh nặng:** Vừa — không phải lớn như review ngụ ý, vì phần đắt nhất (chụp baseline schema-only + roles.sql + diễn tập khôi phục đạt 439/439 bảng, 1193/1193 policy) đã làm xong ở ADR-0002. Việc còn lại: (1) sửa hai câu trong plan (dòng 101, 256) + thêm một đoạn ràng buộc — vài chục phút; (2) giải bài .gitignore:115 để CI có schema.sql, khoảng nửa ngày dù chọn phương án nén-và-commit hay artifact + đối chiếu sh…

#### F6 — generator-bo-sot-partitioned-va-rls

**ĐÚNG** · review chấm `high`, mức thật `high`

Cả ba mệnh đề của F6 đều đúng và tôi tự kiểm chứng được từng cái. (a) `scripts/capture-production-catalog.mjs:71` đúng là dùng `c.relkind IN ('r','p')`, còn generator ở GĐ4 mục 2 của plan (dòng 150) dùng `WHERE c.relkind='r'`. (b) Production có đúng 2 relation `relkind='p'` là `network_device_samples` và `network_interface_samples`; cả hai CÓ `organization_id`, `relrowsecurity=true`, nhưng chỉ mang 1 policy RESTRICTIVE `*_hide_sandbox_admin` — KHÔNG có `*_org_boundary`. (c) Điểm mấu chốt: tôi đo thật trong transaction rollback và xác nhận policy của parent KHÔNG áp khi gọi thẳng vào phân mảnh con, và `CREATE TABLE ... PARTITION OF` KHÔNG kế thừa `relrowsecurity` — con sinh ra có `relrowsecurity=false` và role `authenticated` đọc thấy TOÀN BỘ dòng của mọi org. Prod hiện an toàn chỉ vì `ensure_raw_partitions_v1` tự tay `ENABLE RLS` + `REVOKE ALL` cho từng phân mảnh (migration 20260729020000 dòng 510-511, 520-521), nên con có RLS bật + 0 policy = deny-all. (d) Hôm nay prod KHÔNG có bảng nào có policy mà `relrowsecurity=false`, và 304/304 bảng org đều đã bật RLS — nên điều kiện gate về `relrowsecurity` là phòng thủ tương lai chứ chưa bắt được lỗi nào; nhưng thí nghiệm 1 chứng minh ngữ nghĩa review nêu là thật (policy có mà RLS tắt = lộ sạch). Hai điều review CHƯA nói mà làm finding nặng hơn chứ không nhẹ đi: thứ nhất, `relkind='r'` không chỉ BỎ SÓT 2 parent mà còn TRÚNG NHẦM 86 phân mảnh con (mỗi ngày thêm 2), khiến migration sinh policy vô dụng trên chúng và gate CI đỏ mỗi ngày — đúng kiểu báo động giả mà chính `capture-production-catalog.mjs` (dòng 138-144) đã ghi chú là phải tránh; thứ hai, plan tự mâu thuẫn: con số đầu bài "304/316" chỉ tái lập được bằng `IN ('r','p') AND NOT relispartition` (302 'r' + 2 'p' = 304), còn câu SQL của chính nó trả 388, và mục 3 cùng giai đoạn lại dặn event trigger "bỏ qua partition con". Quan trọng nhất: repo ĐÃ có sẵn template đúng y hệt trong `20260729142000_network_center_hide_sandbox_policies.sql` — generator của plan chỉ đơn giản là không dùng lại nó.

**Phải sửa thành:** 1) Sửa câu SELECT trong generator GĐ4 mục 2 (plan dòng 150) thành đúng template đã có trong repo (20260729142000:119-126), thêm cả điều kiện idempotent/miễn trừ sẵn có: FOR r IN SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') -- BẮT partitioned parent (network_device_samples, network_interface_samples) AND NOT c.relispartition -- BỎ 86 phân mảnh con, +2 mỗi ngày; policy đặt ở đó không áp khi đọc qua parent AND c.relrowsecurity -- generator: bảng chưa bật RLS thì gắn policy là an tâm giả, phải để gate bắt chứ không im lặng vá AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = 'organization_id') -- CHÍNH XÁC, không LIKE: policy body tham chiếu thẳng cột này AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = c.relname || '_org_boundary') AND NOT EXISTS (SELECT 1 FROM app_private.org_boundary_exemptions e WHERE e.table_name = c.relname) ORDER BY 1 LOOP ... END LOOP; 2) Tách rõ hai vai (plan đang trộn làm một, và đây là chỗ mục 5 của plan sẽ phản chủ): - GENERATOR khớp cột CHÍNH XÁC `organization_id`. - GATE khớp MẪU `LIKE '%organization_id'` để KHÔNG bỏ sót bảng như income_expense_type_reference_repair_audit — nhưng bảng chỉ có source_/target_organization_id phải rơi vào nhánh "đỏ, yêu cầu khai miễn trừ hoặc policy viết tay", tuyệt đối không đưa vào vòng lặp sinh SQL. 3) Thêm hai điều kiện ĐỎ vào gate scripts/check-org-boundary-coverage.mjs (mục 4 hiện chỉ có a-d): (e) bảng trong tập đúng (relkind IN ('r','p'), NOT relispartition) có cột %organization_id mà `relrowsecurity=false` → ĐỎ, không cho miễn trừ im lặng; (f) BẤT KỲ relation nào trong public (kể cả phân mảnh) có ≥1 dòng pg_policy nhưng `relrowsecurity=false` → ĐỎ (đo được ở thí nghiệm 1: policy còn nguyên mà RLS tắt thì đọc thấy toàn bộ dòng mọi org). Hôm nay cả hai đều = 0 nên gate vẫn xanh khi bật. 4) Sửa sàn chống rỗng ở mục 6: ngưỡng ≥250 phải đếm trên TẬP ĐÚNG (hôm nay 305 với LIKE / 304 với khớp chính xác), không đếm trên tập 388 của câu SQL cũ — nếu không, sàn vẫn xanh ngay cả khi bộ đọc chỉ trả về phân mảnh. …

**Gánh nặng:** Nhỏ. Toàn bộ là sửa tài liệu, chưa có code nào được viết: đổi mệnh đề WHERE trong một khối SQL ở plan dòng 150 (3 điều kiện: `IN ('r','p')`, `NOT relispartition`, `relrowsecurity`), thêm 2 gạch đầu dòng (e)/(f) vào danh sách điều kiện đỏ của gate ở dòng 153, chỉnh câu chữ mục 5 và mục 6, thêm 1 ca đo vào "Xong khi". Không cần nghĩ mới: template đúng đã nằm sẵn trong repo tại supabase/migrations/20…

#### F7 — rate-limit-khong-co-kien-truc

**ĐÚNG MỘT PHẦN** · review chấm `high`, mức thật `medium`

Lõi finding ĐÚNG và mọi dữ kiện review nêu đều tái lập được: GĐ0 thật sự yêu cầu "rate-limit theo IP" (dòng 83), client thật sự gọi PostgREST trực tiếp đúng tại dòng 98 (số dòng review trích còn chính xác, không lệch), và danh sách "File chính" của GĐ0 (dòng 86) thật sự không có edge function / gateway / file frontend nào. Nặng hơn review mô tả: đó không phải supabase-js mà là `fetch` thuần tới `${VITE_SUPABASE_URL}/rest/v1/rpc/...`, mà `.env` đặt `VITE_SUPABASE_URL="https://tryymsxyyckgbrmmvozx.supabase.co"` — trình duyệt đi THẲNG tới Supabase, Vercel không bao giờ nhìn thấy request này, nên WAF/rate-limit của Vercel về nguyên tắc vô dụng ở đây; Cloudflare cũng chỉ đứng trước chillhome.io.vn (img/storage), không trước supabase.co. Chỗ review SAI ở chi tiết: nó khẳng định "phải chuyển endpoint ra sau một server surface và sửa client" như con đường DUY NHẤT. Tôi đo được `provolatile='v'` (VOLATILE, tức hàm ghi được) và PostgREST có phơi GUC `request.headers`, nên một limiter thuần-DB đọc x-forwarded-for là khả dĩ về kiến trúc, không cần đụng client — chỉ là repo chưa từng dùng (grep `request.headers|x-forwarded-for` trong supabase/migrations = 0 hit) và hop XFF phía trước Supabase có phần tử do kẻ tấn công tự đặt, nên "IP đáng tin cậy" vẫn là vấn đề thật. Review cũng bỏ sót hai điểm làm finding mạnh hơn: (1) GĐ0 mục 4 (dòng 81) CỐ Ý giữ `get_public_latest_invoice_by_code` trong allow-list anon — nên nếu dựng edge function rate-limit mà không revoke anon, kẻ tấn công cứ POST thẳng PostgREST là đi vòng qua limiter, tức mục 6 mâu thuẫn nội bộ với mục 4; (2) phần "Xong khi" (dòng 88) có 4 tiêu chí và KHÔNG tiêu chí nào chạm tới rate-limit, expires_at, revoked hay bỏ phone — mục 6 là việc không có phép nghiệm thu, GĐ0 vẫn tuyên bố xong dù không làm gì. Vì thế mức "high" là quá nặng: đây là khuyết tật mạch lạc của kế hoạch, không phải lỗ hổng, và không chặn phần an ninh thật của GĐ0 (revoke by_contract + building_of_* + ratchet đều thuần DB). Mức thật: medium.

**Phải sửa thành:** Tách mục 6 của GĐ0 (dòng 83) làm hai, và bổ sung tiêu chí nghiệm thu cho phần ở lại. 6a — GIỮ trong GĐ0 (thuần DB, không đụng client, có thể nghiệm thu ngay): (i) Xoay TOÀN BỘ 678 `contracts.public_code` sang ≥16 ký tự (không chỉ "mã phát sinh mới" như plan đang viết — nếu chỉ áp cho mã mới thì 678 mã 6 ký tự sống mãi và toàn bộ lập luận chống brute-force vô nghĩa). Dùng lại `public.gen_contract_public_code(len)` đã có, đổi DEFAULT 6 → 16, thêm `CHECK (length(public_code) >= 16)`. Vì QR đã in/gửi cho khách, xoay mã phải kèm cột `old_public_code` + `old_code_expires_at` và nhánh resolve chấp nhận mã cũ tới hạn — nếu không thì mọi QR đang lưu hành chết ngay. (ii) Thêm `expires_at`, `revoked` và ĐƯA VÀO mệnh đề WHERE của `get_public_latest_invoice_by_code` (plan chỉ nói "thêm cột", thêm cột mà không lọc thì không có tác dụng gì). (iii) Bỏ `customer.phone` khỏi payload — sửa trong `app_private.latest_invoice_by_contract_v1` (bản chuyển từ mục 1). Client không vỡ: `PublicContractInvoicePage.tsx:245-257` bọc trong `customer?.full_name &&` và render `customer.phone || 'N/A'`, nên tệ nhất là hiện "N/A"; dọn khối JSX đó là việc nhỏ đi kèm, không phải điều kiện tiên quyết. Sau khi làm 6a, độ dài mã 16 ký tự base-57 (≈ 5,6e27 tổ hợp) làm brute-force bất khả thi — tức GĐ0 KHÔNG cần rate-limit để đóng lỗ, rate-limit tụt xuống hàng phòng thủ chiều sâu. Đây chính là câu trả lời cho "GĐ0 nên chốt bằng biện pháp gì khác". 6b — TÁCH thành việc riêng, đặt ở giai đoạn có động vào frontend, với "File chính" riêng. Phải chốt MỘT trong hai thiết kế và ghi lý do loại cái kia: • Thiết kế A (thuần DB, không sửa client): bảng `app_private.public_code_hits(ip inet, bucket timestamptz, n int)`, đọc `current_setting('request.headers', true)::json->>'x-forwarded-for'`; hàm đang VOLATILE nên ghi được. ĐIỀU KIỆN TIÊN QUYẾT phải chứng minh trước khi chọn: GUC đó thực sự mang header trên project này (repo có 0 tiền lệ), và xác định hop nào do proxy của Supabase tự nối vào — chỉ hop đó mới dùng được, phần đầu chuỗi XFF do client tự đặt. Không chứng minh được thì loại A vì limiter giả. • Thiết kế B (edge function): thêm `supabase/functions/public-invoice/` với `verify_jwt = false` (khuôn có sẵn: op…

**Gánh nặng:** Sửa tài liệu plan: NHỎ — viết lại 1 gạch đầu dòng thành 6a/6b, sửa 1 câu ở mục 4 (dòng 81), thêm 3 dòng vào "Xong khi", thêm 1 khối "File chính" cho việc tách ra. Khoảng 30 phút. Thi hành 6a: VỪA — 1 migration (đổi DEFAULT độ dài + CHECK + 2 cột + xoay 678 mã + nhánh grace cho mã cũ) + sửa payload trong hàm app_private + 1-2 test. Rủi ro thật không nằm ở code mà ở vận hành: 678 QR đã in/gửi cho kh…

#### F8 — pii-that-trong-tai-lieu

**ĐÚNG** · review chấm `high`, mức thật `medium`

Review đúng, kể cả số dòng (không lệch). Tại đúng dòng 370, mục "### A9. get_public_latest_invoice_by_contract" (heading ở dòng 366), plan ghi nguyên một bản ghi khách hàng thật lấy từ production: họ tên đầy đủ có dấu, số di động Việt Nam 10 số hợp lệ (đầu 03), mã hoá đơn, số tiền, và cả toà/phòng — tức là danh tính + liên lạc + vị trí cư trú + dữ liệu tài chính của một cá nhân, đủ để định danh trực tiếp. Chính câu văn quanh nó tự khai đây là "org aaaa (công ty thật)", nên không thể biện hộ là dữ liệu bịa. Tôi đã quét toàn file cả hai chiều để cố bác bỏ: liệt kê TOÀN BỘ chuỗi số dài ≥9 ký tự trong file, kết quả chỉ có đúng 1 chuỗi 10 số là số điện thoại này, còn lại là 8 timestamp migration 14 số (đúng cái bẫy 20260713121000 mà đề bài cảnh báo — regex có ràng buộc biên đã loại đúng) và 1 mảnh UUID 12 số. Vậy review KHÔNG nhầm tên trường với giá trị: 'ten=' và 'sdt=' ở đây kèm giá trị thật, khác hẳn các chỗ khác trong file chỉ nhắc tên cột (customer.full_name, customer.phone ở dòng 369) mà không có giá trị. Điểm review nói chưa đủ chính xác về mức độ khẩn: file HIỆN CHƯA được commit (git status hiện `?? docs/plans/PLAN-TACH-DU-LIEU-DA-CONG-TY.md`, `git ls-files` rỗng, và không nằm trong .gitignore), `git log --all -S '«ĐÃ CHE — SĐT khách thật»'` cùng `-S 'Ngọc Quyền'` đều 0 kết quả — nên rủi ro "lưu PII vĩnh viễn vào Git history" CHƯA xảy ra, mới chỉ là rủi ro sắp xảy ra nếu ai đó `git add docs/`. Cách diễn đạt "phải redact TRƯỚC KHI commit" của review vì thế là chuẩn xác. Ngoài dòng 370 thì file SẠCH: không email, không số tài khoản ngân hàng, không CCCD/CMND, không địa chỉ, không token/public_code/API key/mật khẩu nào có giá trị thật (mọi hit 'token'/'public_code'/'secret' đều là danh từ trong văn xuôi), không tên công ty thật (các org chỉ gọi bằng bí danh aaaa/cccc/dddd), và 2 UUID ở dòng 384 là id phiếu chi chứ không phải PII.

**Phải sửa thành:** Sửa đúng 1 dòng, làm NGAY TRƯỚC khi `git add` file này: 1. Tại docs/plans/PLAN-TACH-DU-LIEU-DA-CONG-TY.md:370, thay cụm giá trị thật bằng mô tả hình dạng dữ liệu — vẫn giữ nguyên sức nặng bằng chứng (điều cần chứng minh là "anon đọc được các trường này", không phải "khách tên gì"). Ví dụ: TRƯỚC: `ten="«ĐÃ CHE — họ tên khách thật»", sdt="«ĐÃ CHE — SĐT khách thật»", so_hd="«ĐÃ CHE — mã hoá đơn thật»", tong="5065000.00", con_lai="5065000.00", so_dong_items=4, toa="512TT", phong="301", current_user="anon"` SAU: `ten=<REDACTED họ tên khách thật, 4 âm tiết>, sdt=<REDACTED số di động 10 số>, so_hd=<REDACTED mã hoá đơn INV-2026-xxxxx>, tong/con_lai=<REDACTED, ~5.0 triệu VND>, so_dong_items=4, toa/phong=<REDACTED>, current_user="anon"` Giữ lại `so_dong_items=4` và `current_user="anon"` vì đó mới là bằng chứng thật (hàm trả đủ payload dưới vai anon). 2. Sau khi sửa, chạy lại 2 gate để chắc không sót: `grep -oE '[0-9]{9,}' docs/plans/PLAN-TACH-DU-LIEU-DA-CONG-TY.md | awk 'length($0)!=14'` → phải rỗng (14 số là timestamp migration hợp lệ) `grep -nE '(Nguyễn|Trần|Lê|Phạm|Hoàng|Huỳnh|Phan|Vũ|Võ|Đặng|Bùi|Đỗ|Ngô|Dương)[ ]+[A-ZÀ-Ỹ]' docs/plans/PLAN-TACH-DU-LIEU-DA-CONG-TY.md` → phải rỗng 3. KHÔNG cần `git filter-repo` / BFG: đã xác minh PII chưa từng vào history (mục 5 phần bằng chứng). Chỉ cần redact rồi mới commit lần đầu. 4. Phòng tái phát (khuyến nghị, không bắt buộc cho finding này): thêm một bước vào gate tài liệu — chặn commit nếu file trong docs/plans/ chứa chuỗi khớp `0[35789][0-9]{8}` mà không nằm trong chuỗi 14 số. Quy ước chung cho mọi plan/evidence về sau: khi dán kết quả đo từ prod, dán tên CỘT và số DÒNG, không dán GIÁ TRỊ của cột PII. 5. Với docs/generated/schema-change-evidence/*.json: không cần hành động — email trong đó là của chính chủ repo, đã có sẵn trong author metadata mọi commit. Nếu muốn sạch tuyệt đối thì đổi `actor` sang định danh không phải email (vd `owner`), nhưng đây là lựa chọn thẩm mỹ, không phải rò rỉ.

**Gánh nặng:** Nhỏ. Sửa đúng 1 dòng trong 1 file, không đụng code, không đụng database, không cần rewrite git history (đã xác minh file chưa commit và PII chưa vào history). Ước lượng dưới 5 phút, kể cả chạy lại 2 lệnh grep kiểm chứng. Phần tuỳ chọn (thêm gate chặn số điện thoại trong docs/plans/) tốn thêm khoảng 15–30 phút nếu muốn phòng tái phát.

#### F9 — dod-gd2-khong-khop-khoi-luong

**ĐÚNG MỘT PHẦN** · review chấm `medium`, mức thật `high`

Lõi của F9 ĐÚNG và đã tự kiểm chứng được trên production: Definition of Done của GĐ2 ("272 → ≤ 20") không được khối lượng việc mà chính GĐ2 liệt kê đỡ nổi. Nhưng ba chi tiết trong review sai, và sai theo hướng NHẸ HƠN thực tế. Thứ nhất, con số 51 của nhóm C là số plan tự khai, còn danh sách tên thật chỉ có 50 bảng — phân nhóm "9 bảng chặn gián tiếp qua building_id" chỉ liệt kê 8 tên, cái thứ 9 (room_price_history) không hề có cột organization_id nên không nằm trong mẫu số 272 (Phụ lục C đã tự nói điều đó). Vậy tổng cộng ngây thơ là 36+122+50+18 = 226, không phải 227. Thứ hai, review giả định "kể cả khi các nhóm không chồng lấn" — thực tế CHỒNG LẤN NẶNG: đo trên prod thì nhóm D giao nhóm B 7 bảng và giao nhóm C 7 bảng, tức 14/18 bảng của nhóm D đã nằm sẵn ở nhóm khác. Hợp của A∪B∪C∪D chỉ là 212 bảng phân biệt, nên sau khi làm SẠCH toàn bộ GĐ2 vẫn còn 61 bảng thiếu boundary, không phải 45. Cộng thêm 14 bảng GĐ3 nêu đích danh thì vẫn còn 47 bảng không ai nhận. Muốn về ≤20 thì phải khai miễn trừ ít nhất 27 bảng, trong khi DoD GĐ2 chỉ chừa chỗ cho "nhóm rò sống ở GĐ3 (16) + nhóm miễn trừ" tức ~4 suất. Thứ ba, mẫu số cũng lệch: chạy đúng câu SQL mà plan bảo gate GĐ4 sẽ dùng (polname = relname||'_org_boundary') thì ra 273 chứ không phải 272, vì notification_preferences có policy tên np_org_boundary nên vĩnh viễn bị đếm là "thiếu". Ngoài ra còn hai khuyết tật nặng hơn review nêu: 5 bảng có organization_id, authenticated ĐỌC ĐƯỢC, thiếu boundary, mà không xuất hiện DÙ MỘT LẦN trong toàn bộ 143KB tài liệu (special_fee_claims, termination_refund_obligations, profit_payout_exceptions, profit_payout_reservations, openclaw_capacity_controls); và bảng miễn trừ app_private.org_boundary_exemptions mãi GĐ4 mới được tạo (dòng 149) trong khi DoD của GĐ2 (dòng 123) đã viện đến "nhóm miễn trừ" — lỗi thứ tự, không chỉ lỗi số học.

**Phải sửa thành:** 1) SỬA MẪU SỐ VÀ DoD (dòng 110, 123). Đổi "272" → "273 (đo bằng chính câu SQL của gate)"; hoặc đổi tên policy np_org_boundary → notification_preferences_org_boundary trong một migration nhỏ rồi giữ 272. Thay ngưỡng cứng "≤ 20" bằng ngưỡng DẪN XUẤT: "missing_after_GD2 = 273 − |A∪B∪C∪D| và mọi bảng còn lại phải có dòng trong inventory với assigned_phase ∈ {GĐ3,…,GĐ9} hoặc exemption_reason". Không được để một con số viết tay làm điều kiện nghiệm thu. 2) SỬA SỐ NHÓM. Nhóm C: ghi 50 (bỏ room_price_history khỏi phép đếm boundary vì nó không có organization_id — nó thuộc GĐ6, dòng 177). Nhóm D: ghi rõ "18 bảng, trong đó 14 đã thuộc B/C, chỉ 4 là mới" để không cộng trùng. Tiêu đề GĐ3 (dòng 125): hoặc nêu đủ 16 tên, hoặc sửa thành 14 và nói 2 bảng còn lại của tập rò sống nằm ở đâu. 3) DI CHUYỂN BẢNG MIỄN TRỪ LÊN TRƯỚC. app_private.org_boundary_exemptions đang được tạo ở GĐ4 (dòng 149) nhưng DoD GĐ2 (dòng 123) đã viện tới nó. Chuyển việc tạo bảng + seed nhóm dùng chung cố ý (ai_providers, ai_copilot_settings, permission_definitions, legacy_owner_allowlist, authorization_migration_exceptions — đã nêu ở dòng ~302) vào GĐ1, để GĐ2 có chỗ khai 27+ suất miễn trừ mà nó đang cần. 4) INVENTORY SINH BẰNG MÁY — đề xuất cụ thể: - Script: scripts/build-org-boundary-inventory.mjs (đọc PAT từ env như capture-production-catalog.mjs; chỉ SELECT pg_catalog, từ chối mọi query chứa từ khoá ghi/COMMIT theo đúng chốt ở dòng ~106). - Đầu ra: docs/generated/org-boundary-inventory.json (+ bản .md người đọc được), khuôn giống docs/generated/database-inventory.json đã có sẵn. - Cột bắt buộc mỗi dòng = một relation: table_name; relkind; is_partition; has_organization_id; boundary_policy_name (null nếu thiếu); boundary_name_matches_convention (bắt np_org_boundary); authenticated_can_select; in_realtime_publication; exact_row_count; group ∈ {A_empty,B_no_grant,C_indirect,D_realtime,GD3_live_leak,EXEMPT,UNASSIGNED}; assigned_phase ∈ {GĐ0..GĐ9,EXEMPT}; exemption_reason; decided_by; expires_at; source_line (số dòng trong plan nơi bảng được nêu — để chống việc plan và inventory lệch nhau lần nữa); captured_at. - Ràng buộc: group và assigned_phase phải SINH TỪ VIỆC PARSE CHÍNH FILE PLAN (quét tên bảng tro…

**Gánh nặng:** Vừa. Phần cơ khí rẻ: script inventory ~150-200 dòng JS + một câu SQL pg_catalog, tái dùng khuôn docs/generated/database-inventory.json và scripts/capture-production-catalog.mjs đã có; gate CI thêm ~30 dòng. Phần đắt là phần người: phải ra quyết định phân loại cho 47 bảng mồ côi (gán giai đoạn hay khai miễn trừ kèm lý do + hạn), trong đó ~40 bảng thuộc cụm phân quyền/approval/zalo mà Phụ lục B đã b…

#### F10 — baseline-so-dong-khong-on-dinh

**ĐÚNG MỘT PHẦN** · review chấm `medium`, mức thật `medium`

Lõi của review ĐÚNG và tôi chứng minh được bằng số tự đo: plan thật sự chốt gate theo số tuyệt đối đo trên production, và những con số đó đã LỆCH ngay trong chính ngày plan được viết (4175→4176 dòng NULL, public_room_events 11149→11150, 3022→3023), với tốc độ sinh 857 dòng/7 ngày. Tiêu chí GĐ1 "TÁI LẬP ĐÚNG các số đã đo tay... Lệch một con số nghĩa là bộ đo hỏng, không phải hệ đã đổi" (dòng 106) do đó đã KHÔNG THỂ đạt được nữa tại thời điểm tôi kiểm — nó diễn giải mọi trôi dữ liệu thành "bộ đo hỏng", tức đúng ngược. Tương tự, "Ô visible_own phải bằng nhau từng bảng từng persona" (dòng 123) vỡ ngay khi một nhân viên xoá một vật tư của chính org mình. NHƯNG review chấm quá rộng ở hai chỗ. Thứ nhất, nó không tách hai loại tiêu chí: phần lớn "Xong khi" của plan là loại "= 0" (GĐ0 cả 4 chốt, GĐ3 (1)(2)(4), GĐ4 (4), GĐ5 (1)(2), GĐ7 (3), GĐ8 (3)). Số 0 là điểm bất động, độc lập hoàn toàn với khối lượng dữ liệu: rò đi từ 0 lên N thì luôn là hồi quy thật. Những tiêu chí này LÀNH và không được đổi. Chỉ có bốn nhóm bất ổn: (i) khớp đúng 224/8568 và bảng chi tiết (d106); (ii) visible_own bằng-nhau/không-giảm (d123, d259); (iii) ratchet đơn điệu trên các ô CÒN KHÁC 0 — gồm 3 bảng theo-người được cố ý chừa lại từ GĐ1 tới GĐ9 (d141); (iv) hằng số đã cũ và số đếm màn hình cứng ("thấy đúng 30 vật tư", "1216→1005"). Thứ hai, review bỏ qua rằng plan ĐÃ CÓ sẵn lớp canary mà nó đề xuất: TẦNG 1 (dòng 101, 256) là fixture local seed 3 org tí hon + người hai org, chạy mọi PR, không cần PAT, không chạm prod. Nên việc phải sửa nhỏ hơn "thiết kế lại gate": chỉ là dời vai trò chặn về TẦNG 1 và hạ TẦNG 2 xuống cảnh báo vận hành. Chính plan đã tự mâu thuẫn ở đúng chỗ này — dòng 258 xếp TẦNG 2 là "nightly + trước/sau migrate:forward", còn dòng 279 lại nối gate:org-leak vào ci-gates.yml "không continue-on-error". Về fingerprint, review đúng nhưng repo đã có sẵn hơn nó tưởng, và quan trọng hơn: repo đã ghi sẵn CHÍNH bài học này. Comment ở capture-production-catalog.mjs:138-144 giải thích vì sao fingerprint phải bỏ qua thứ phụ thuộc ngày — "báo động giả hằng ngày sẽ bị tắt đi trong một tuần, và khi ấy thay đổi schema thật cũng không ai thấy". Plan đang chuẩn bị dựng đúng loại gate báo động giả h…

**Phải sửa thành:** Không phải viết lại gate — phải PHÂN VAI ba loại vị từ và sửa 6 chỗ trong plan. 1) VỊ TỪ TẤT ĐỊNH — GIỮ NGUYÊN, tiếp tục là gate chặn. Mọi tiêu chí dạng "= 0" đứng vững, không đổi: GĐ0 (4 chốt), GĐ3 (1)(2)(4), GĐ4 (4), GĐ5 (1)(2), GĐ7 (3), GĐ8 (3). Lý do phải ghi thẳng vào plan để lần sau không ai "sửa" nhầm: 0 là điểm bất động, không phụ thuộc khối lượng dữ liệu; 0→N luôn là hồi quy thật. 2) GATE CHẶN TRÊN PR = TẦNG 1 (fixture canary) + vị từ CATALOG. Không dính số dòng prod. Fixture (mở rộng d101/d256, khai UUID cố định trong repo): - 3 org A/B/S + 4 chủ thể: uA (chỉ A), uB (chỉ B), uAB (ACTIVE cả hai — nhân vật đã phá giả định ở public_room_events), u0 (mồ côi, không org), và vai anon. - Seeder đi theo CATALOG, không theo danh sách tay: với mọi bảng public có organization_id, gieo đúng N=2 dòng cho A và 2 cho B (dùng default/NULLable-aware synth). Số dòng do fixture TỰ ĐỊNH nên mọi khẳng định về nó là tất định vĩnh viễn. - Vị từ: P1 visible_foreign(mọi bảng, mọi persona) = 0; P2 visible_own(uA) = số đã gieo cho A (đúng bằng, không xấp xỉ); P3 uAB thấy đủ dòng của CẢ A và B (chốt chống siết nhầm thật sự); P4 u0 và anon = 0 ở mọi bảng; P5 ma trận ghi chéo: INSERT/UPDATE/DELETE chéo org trả 0 dòng ảnh hưởng; P6 mutation: DROP một boundary → bộ test PHẢI đỏ. Vị từ catalog (chạy read-only trên prod, an toàn để chặn — tôi vừa xác nhận tái lập chính xác 304/32): - số bảng có organization_id thiếu <bảng>_org_boundary và không có dòng miễn trừ = 0; miễn trừ phải đủ reason/decided_by/expires_at và chưa quá hạn; không boundary nào là PERMISSIVE / TO public / cmd ≠ '*'; sàn số bảng quét ≥250 (d154 đã đúng, giữ). 3) SỐ PRODUCTION = CẢNH BÁO VẬN HÀNH, KHÔNG CHẶN PR. Gỡ `gate:org-leak` khỏi danh sách chặn ở d279, để đúng như d258 đã nói: nightly + trước/sau mỗi `migrate:forward`. Sửa luôn mâu thuẫn d258↔d279 (hiện hai dòng nói ngược nhau). Ngoại lệ duy nhất được phép chặn: ô nào có baseline visible_foreign = 0 mà đo ra > 0 → đỏ cứng (đây lại là vị từ "= 0", tất định). 4) THAY BA TIÊU CHÍ BẤT ỔN BẰNG VỊ TỪ TỰ TÍNH LẠI TRONG CÙNG LẦN CHẠY: - Thay d123 và d259 (visible_own "bằng nhau" / "không giảm" so baseline cũ) bằng: visible_own(bảng, persona) PHẢI BẰNG ground_truth_own(bả…

**Gánh nặng:** Nhỏ đến vừa — và phần lớn là sửa TÀI LIỆU, không phải sửa code hay prod. Nhỏ (≈1-2 giờ, chỉ sửa plan): 6 chỗ trong docs/plans/PLAN-TACH-DU-LIEU-DA-CONG-TY.md — d100, d106, d123, d141(1)(3), d175(3), d259, cộng gỡ gate:org-leak khỏi danh sách chặn ở d279 để hết mâu thuẫn với d258. Cập nhật 3 hằng số đã cũ (4175/3022/11149) thành dạng vị từ thay vì số đếm. Không đụng production, không đụng migration…

---

## Bản án tổng

Bản review chấm 10 finding thì 1 sai ở lõi (F1), 3 đúng hoàn toàn (F4, F6, F8), 6 đúng một phần. Sai đắt nhất của review là F1: nó chấm "critical" cho khẳng định "GĐ4 không triển khai được vì postgres không tạo được EVENT TRIGGER", trong khi thực nghiệm trực tiếp trên chính production (BEGIN…ROLLBACK) cho thấy CREATE EVENT TRIGGER thành công, evtowner=postgres, và trigger FIRE thật trên CREATE TABLE — vì Supabase nạp supautils với supautils.privileged_role=supabase_privileged_role và postgres LÀ member của role đó. Nên toàn bộ "CHỐT MẠNH NHẤT" của plan v1 được GIỮ NGUYÊN, chỉ vá hai khuyết tật mà cả review lẫn plan đều không thấy: đệ quy vô hạn 54001 (ALTER TABLE … ENABLE RLS tự nó là một ddl_command_end nên gọi lại chính hàm) và lỗi 42703 khi dò cột theo mẫu '%organization_id' mà thân policy lại viết cứng organization_id. Plan v1 sai thật ở bảy chỗ có thể làm hỏng việc: (1) tạo bảng miễn trừ và chạy generator trong CÙNG một migration nên lần chạy đầu chắc chắn quét trên sổ RỖNG, mà đo được là app_private.org_boundary_exemptions hiện chưa tồn tại — hậu quả sống là demo.chunha mất chính dòng profile của mình, và org DEMO chính là org mà bộ E2E fleet chạy trên đó; (2) chỉ thị "phải sửa cả migration nguồn 20260802235000" vi phạm forward-only, file đó ≤ cutoff 20260805120000 nên là legacy-frozen; (3) generator dùng relkind='r' vừa bỏ sót 2 partitioned parent vừa trúng nhầm 86 phân mảnh con (+2 mỗi ngày); (4) harness local "dựng DB từ supabase/migrations" bất khả thi — 632 file, 36 nhóm trùng version, ledger prod chỉ 372 dòng, và Contract §5 đã cấm; (5) rate-limit theo IP đặt trong GĐ0 mà không có kiến trúc nào đỡ, vì trình duyệt gọi thẳng supabase.co bằng fetch thuần nên Vercel không nhìn thấy request; (6) DoD "272 → ≤ 20" bất khả thi về số học — hợp A∪B∪C∪D chỉ 212 bảng phân biệt, sau GĐ2 còn 61 bảng thiếu boundary; (7) hàng loạt tiêu chí xong chốt theo số dòng nghiệp vụ đang trôi (4175→4176, 3022→3023, 11149→11150 ngay trong ngày plan được viết, public_room_events sinh ~53 dòng/ngày). Plan v1 làm ĐÚNG và phải giữ: nguyên tắc suy-từ-catalog, miễn trừ là dữ liệu có ràng buộc, ba tầng cưỡng chế, RESTRICTIVE chỉ siết không nới, cấm suy luận từ policy, preflight đếm FK chéo, boundary luôn TO authenticated, phân nhóm A/B/D (đối chiếu máy khớp 100%), và toàn bộ khuôn ba phần của 20260807163000. Cuối cùng, PII thật (họ tên + số di động khách hàng org aaaa) đang nằm ở dòng 370 của chính file plan; file chưa từng vào Git history nên chỉ cần redact TRƯỚC lần commit đầu, không cần rewrite history.

## Thứ tự thi hành

Chuỗi chính là GĐ0 → GĐ1 → GĐ2 → GĐ3 → GĐ4 → GĐ5 → {GĐ6, GĐ7, GĐ8} → GĐ9 → GĐ10, cộng GĐ-R chạy song song không chặn ai. Ba thay đổi thứ tự so với v1, mỗi cái có lý do đo được. Thứ nhất, sổ miễn trừ tách hẳn thành GĐ1 đứng ngay sau GĐ0 thay vì nằm chung file với generator ở GĐ4 cũ: đo được app_private.org_boundary_exemptions hiện CHƯA TỒN TẠI, nên nếu giữ nguyên v1 thì một lần migrate:forward là bảng vừa sinh ra đã rỗng và generator quét ngay lên nó, dập policy vào profiles/roles/settings/ai_* và giết đăng nhập org DEMO trong cùng transaction với migration. Đặt sổ trước cũng giải luôn lỗi thứ tự mà DoD GĐ2 cũ mắc phải — nó viện tới "nhóm miễn trừ" trong khi bảng miễn trừ mãi GĐ4 mới được tạo. Thứ hai, bộ đo (GĐ2) vẫn đứng trước mọi bản vá đúng như v1 chủ trương, nhưng nay phụ thuộc GĐ1 vì tập bảng cần đo và danh sách được-phép-khác-0 đều đọc từ inventory và sổ miễn trừ, không viết tay. Thứ ba, rate-limit bị BÓC khỏi GĐ0 thành GĐ-R độc lập: sau khi GĐ0 xoay toàn bộ public_code lên ≥16 ký tự base-57 (≈5,6e27 tổ hợp) thì brute-force bất khả thi, nên rate-limit tụt xuống hàng phòng thủ chiều sâu và không được quyền giữ giai đoạn rủi ro cao nhất làm con tin. GĐ5 (đảo cơ chế) vẫn đứng sau GĐ3/GĐ4 đúng như v1: generator chỉ nên chạy khi các nơi an toàn đã vá và các bảng đang rò sống đã có preflight, để nếu có hồi quy thì phạm vi nghi ngờ nhỏ. Sau GĐ5, ba nhánh GĐ6 (đóng nhánh NULL), GĐ7 (bảng/view không có cột org) và GĐ8 (RPC + storage) độc lập với nhau và chạy song song được — cả ba chỉ cần generator và gate đã sống. GĐ9 (frontend) đi sau GĐ4 vì tiêu chí của nó là "số dòng trên màn hình khớp số đo từ DB", chỉ có nghĩa khi các bảng đang rò sống đã kín. GĐ10 đi cuối cùng vì nó là chỗ đáo hạn của các dòng miễn trừ đã seed ở GĐ1: sửa xong nhãn mô hình sai thì mới gỡ miễn trừ của profiles/roles/settings và để generator phủ chúng. Một ràng buộc thứ tự nữa nằm BÊN TRONG GĐ6 chứ không phải giữa các giai đoạn: phải mở rộng trg_autofill_org sang ai_chat_threads/ai_chat_messages TRƯỚC mọi lệnh SET NOT NULL, vì hai bảng đó không có DEFAULT, không có trigger autofill và src/copilot/chatEngine.ts không set organization_id — bỏ nhánh NULL trước là giết đường ghi của Copilot. Chọn đường DB (trigger) thay vì đường frontend chính là để GĐ6 không phải chờ GĐ9.

## Đã đổi gì so với bản 1

- **F1 — event-trigger-va-ci-gate (review chấm critical, kiểm chứng: SAI ở lõi)** — GIỮ NGUYÊN event trigger ddl_command_end làm 'chốt mạnh nhất' của GĐ5, không gỡ, không thay bằng gate CI. Nhưng thêm ba sửa đổi có căn cứ đo được: (a) guard chống tái nhập bằng current_setting('app.org_boundary_guard', true) + set_config trong app_private.ensure_org_boundary_v1(); (b) tách MẪU DÒ ('%organization_id', dùng cho gate) khỏi THÂN POLICY (khớp chính xác 'organization_id', dùng cho generator); (c) đổi tiêu chí 'Xong khi' từ 'ở bản local' sang 'trên prod trong BEGIN…ROLLBACK'. Thêm tuỳ chọn mức thấp: gate:org-boundary-static chạy ở job quality-gates (không cần secret) để có tầng chặn …
  - *Vì sao:* Lõi của F1 bị bác bằng thực nghiệm trực tiếp trên chính production: CREATE EVENT TRIGGER trả CREATED_OK, evtowner=postgres, trigger FIRE thật trên CREATE TABLE — vì supautils.privileged_role=supabase_privileged_role và postgres LÀ member. Luật số 1 của bài này là không sửa thứ không hỏng. Nhưng cùng lần thử đó phơi ra hai khuyết tật mà cả review lẫn plan đều không thấy: viết đúng như plan mô tả thì gặp 'ERROR: 54001: stack depth limit exceeded' vì ALTER TABLE … ENABLE ROW LEVEL SECURITY tự nó là…
- **F2 — exemptions-seed-qua-muon (review chấm critical, kiểm chứng: ĐÚNG MỘT PHẦN, mức thật high)** — Tách hẳn thành GĐ1 mới đứng ngay sau GĐ0: một migration CHỈ tạo bảng app_private.org_boundary_exemptions và INSERT seed 9 dòng, TUYỆT ĐỐI chưa có vòng DO sinh policy và chưa có CREATE EVENT TRIGGER. Thêm chốt tự vệ trước vòng DO ở GĐ5 (IF count=0 THEN RAISE EXCEPTION). Đặt expires_at ngắn cho từng dòng thay vì kéo GĐ10 lên trước. Thêm phép đo visible_own trước/sau mỗi lần generator chạy, đỏ khi bất kỳ ô nào giảm ở bảng ngoài sổ. Bỏ permission_definitions/legacy_owner_allowlist/authorization_migration_exceptions khỏi seed, chuyển sang GĐ7. Sửa chẩn đoán profiles ở GĐ10 và thay bài test chốt.
  - *Vì sao:* Đo được app_private.org_boundary_exemptions HIỆN CHƯA TỒN TẠI, và cả ba bước (tạo bảng, vòng lặp generator, event trigger) nằm trong CÙNG một file migration — nên lần chạy đầu quét trên sổ RỖNG theo cấu trúc chứ không theo may rủi. Hậu quả sống nặng hơn review nêu: không phải Copilot (ai_copilot_entitlements chỉ có 1 dòng, chủ là super admin nên boundary tha) mà là profiles — demo.chunha mất chính dòng profile CỦA MÌNH (own 1→0), và 7/15 dòng profiles toàn hệ mang organization_id không nằm trong…
- **F3 — building-of-star-dependency (review chấm high, kiểm chứng: ĐÚNG MỘT PHẦN, mức thật medium)** — Sửa hai câu sai trong plan (GĐ0 việc 2 và phụ lục A10): bỏ 'Chúng chỉ được policy RLS gọi'. Thêm PUBLIC vào mọi lệnh REVOKE của GĐ0 (cả building_of_*, customer_in_my_scope, ie_item_restricted_visible). Bắt buộc dùng ALTER FUNCTION … SET SCHEMA, cấm DROP+CREATE. Thêm việc CREATE OR REPLACE hai RPC approve_/reject_contract_termination_v1 trong CÙNG migration. Thêm assert quét pg_proc.prosrc trong chính migration. Mở rộng scripts/check-definer-acl.mjs soi cả mục ACL không tên role. KHÔNG cấp USAGE app_private cho authenticated/anon.
  - *Vì sao:* Đo được proacl ba hàm có mục '=X/postgres' (chính là PUBLIC), và chạy thật lệnh revoke đúng như plan viết (chỉ anon, authenticated) thì has_function_privilege('authenticated', …) VẪN TRUE — tức bước vá của plan là no-op bảo mật hoàn toàn trong khi plan tuyên bố đã đóng. Đây là mâu thuẫn nội bộ: việc số 1 của cùng giai đoạn lại viết đúng 'FROM PUBLIC, anon, authenticated'. Prod có ĐÚNG 2 thân hàm SECURITY DEFINER gọi public.building_of_contract, và đã chứng minh sống rằng sau SET SCHEMA thì lời g…
- **F4 — vi-pham-forward-only (review chấm high, kiểm chứng: ĐÚNG, mức thật medium)** — Xoá hẳn mệnh đề 'phải sửa cả migration nguồn' khỏi GĐ0 việc 5. Thay bằng MỘT migration forward mới <ts>_share_token_hardening.sql với 4 bước a/b/c/d. Gỡ 20260802235000_share_token_dsphongtrong_alias.sql khỏi mục 'File chính'; nếu giữ để tra cứu thì chú thích '(CHỈ ĐỌC — legacy-frozen, KHÔNG sửa)'. Áp cùng chú thích đó cho 20260713121000, 20260728180000, 20260731070000, 20260713120000 ở các giai đoạn khác. Thêm một dòng vào Nguyên tắc thiết kế: 'Mọi file supabase/migrations có version ≤ 20260805120000 là CHỈ ĐỌC'. Thêm tiêu chí xong: 0 byte thay đổi trên mọi file ≤ cutoff.
  - *Vì sao:* File 20260802235000 có version ≤ provisionalCutoff 20260805120000 nên thuộc legacyPolicy 'legacy-frozen: CHỈ ĐỌC'; Contract §5 dòng 209-210 và §11.4 dòng 449 cấm minh thị. Lane tự chặn ba lớp (apply-reviewed-migration.mjs:249-256, check-migration-provenance.mjs:111-121, ci-gates.yml:136-138 không continue-on-error) nên chỉ thị này không thể chạm prod, nó chỉ làm CI đỏ — vì thế hạ từ high xuống medium. Nhưng vẫn phải sửa vì còn một đường rửa: generate-migration-provenance.mjs:338 tính lại sha256 …
- **F5 — harness-local-khong-replay-duoc (review chấm high, kiểm chứng: ĐÚNG MỘT PHẦN, mức thật high)** — Thay cụm 'dựng DB từ supabase/migrations' ở cả hai chỗ (GĐ1 việc 6 và TẦNG 1 phần Kiểm chứng) bằng quy trình dựng cụ thể từ supabase/baseline: roles.sql → schema.sql lượt 1 → schema.sql LƯỢT 2 (bắt buộc) → apply chỉ migration có version > cutoff. Thêm việc bắt buộc giải chốt .gitignore:115 trước, với ba phương án chọn một. Chốt vehicle là Docker supabase/postgres:17.6.1.156 chứ không PGlite. Seed theo thứ tự topo suy từ pg_constraint. Thêm chốt chống baseline cũ. Thêm assert trong script: 0 lần đọc file ≤ cutoff và 0 lần đọc migrations-archive.
  - *Vì sao:* Contract §5 dòng 215-218 tuyên bố 'Legacy history KHÔNG replay được'; tự đo lại còn tệ hơn số Contract ghi — 632 file, 36 nhóm trùng version, ledger prod chỉ 372 dòng. Plan hoàn toàn không biết ràng buộc này tồn tại: đếm trong 143KB plan thì pg_dump=0, bootstrap=0, snapshot=0, pglite=0, 'db push'=0, 'trùng version'=0. Chính tiền lệ plan viện dẫn lại bác plan: test:openclaw:sql:local dùng PGlite + fixture bootstrap chép tay + đúng 12 file trong danh sách cứng, không quét cả thư mục. Ngược lại, hư…
- **F6 — generator-bo-sot-partitioned-va-rls (review chấm high, kiểm chứng: ĐÚNG, mức thật high)** — Sửa mệnh đề WHERE của vòng DO trong GĐ5 thành relkind IN ('r','p') AND NOT relispartition AND relrowsecurity AND khớp cột chính xác 'organization_id'. Tách vai generator (khớp chính xác) khỏi vai gate (khớp mẫu '%organization_id'). Thêm bốn điều kiện đỏ mới (e)(f)(g)(h) vào scripts/check-org-boundary-coverage.mjs. Sửa sàn chống rỗng ≥250 để đếm trên TẬP ĐÚNG. Thêm ca đo CREATE TABLE … PARTITION BY vào 'Xong khi'.
  - *Vì sao:* scripts/capture-production-catalog.mjs:71 đã dùng đúng relkind IN ('r','p') còn generator của plan dùng relkind='r'. Hậu quả đo được là hai chiều: BỎ SÓT 2 partitioned parent (network_device_samples, network_interface_samples — có organization_id, RLS bật, chỉ mang *_hide_sandbox_admin, không có *_org_boundary) và TRÚNG NHẦM 86 phân mảnh con (+2 mỗi ngày) → 86 policy rác và CI đỏ hằng ngày, đúng kiểu báo động giả mà capture-production-catalog.mjs:138-144 đã cảnh báo. Plan còn tự mâu thuẫn: con s…
- **F7 — rate-limit-khong-co-kien-truc (review chấm high, kiểm chứng: ĐÚNG MỘT PHẦN, mức thật medium)** — Tách mục 6 của GĐ0 làm hai. Phần 6a ở lại GĐ0 (thuần DB): xoay TOÀN BỘ 678 public_code lên ≥16 ký tự kèm cửa sổ ân hạn old_public_code/old_code_expires_at, thêm expires_at + revoked VÀ ĐƯA VÀO mệnh đề WHERE, bỏ customer.phone khỏi payload. Phần 6b (rate-limit) tách thành GĐ-R độc lập với hai thiết kế A/B, mỗi thiết kế có điều kiện tiên quyết phải chứng minh trước. Thêm ba tiêu chí xong cho 6a mà v1 hoàn toàn thiếu. Ghi hai điều loại trừ (Vercel, Cloudflare) vào plan.
  - *Vì sao:* Trình duyệt gọi PostgREST bằng fetch THUẦN tới ${VITE_SUPABASE_URL}/rest/v1/rpc/… và .env đặt VITE_SUPABASE_URL="https://tryymsxyyckgbrmmvozx.supabase.co", nên Vercel không bao giờ nhìn thấy request và WAF/rate-limit của Vercel vô dụng; Cloudflare chỉ đứng trước chillhome.io.vn. 'File chính' của GĐ0 không có edge function/gateway/file frontend nào, và phần 'Xong khi' có 4 tiêu chí mà KHÔNG tiêu chí nào chạm tới rate-limit, expires_at, revoked hay bỏ phone — tức mục 6 là việc không có phép nghiệm…
- **F8 — pii-that-trong-tai-lieu (review chấm high, kiểm chứng: ĐÚNG, mức thật medium)** — Thêm 'Việc 0' vào GĐ0, phải làm TRƯỚC mọi `git add`: redact dòng 370 (mục A9) — thay giá trị thật bằng mô tả hình dạng dữ liệu, giữ nguyên so_dong_items=4 và current_user="anon". Thêm hai lệnh grep làm tiêu chí xong. KHÔNG dùng git filter-repo/BFG. Khuyến nghị thêm gate chặn chuỗi 0[35789][0-9]{8} trong docs/plans/ (không nằm trong chuỗi 14 số).
  - *Vì sao:* Dòng 370 chứa họ tên đầy đủ có dấu + số di động Việt Nam 10 số hợp lệ + mã hoá đơn + số tiền + toà/phòng của một khách hàng thật, và chính câu văn quanh nó tự khai là 'org aaaa (công ty thật)' nên không thể biện hộ là dữ liệu bịa. Quét vét cạn cả hai chiều để cố bác bỏ: toàn file chỉ có ĐÚNG 1 chuỗi 10 số, còn lại là 8 timestamp migration 14 số (đúng cái bẫy regex) và 1 mảnh UUID; ngoài dòng 370 thì file sạch (0 email, 0 số tài khoản, 0 CCCD, 0 token có giá trị thật). Không cần rewrite history v…
- **F9 — dod-gd2-khong-khop-khoi-luong (review chấm medium, kiểm chứng: ĐÚNG MỘT PHẦN, mức thật high)** — Thay DoD 'ngưỡng cứng ≤ 20' bằng DoD DẪN XUẤT tính từ |A∪B∪C∪D| và từ inventory. Sửa số nhóm: C=50 (không 51), D=18 trong đó 14 đã thuộc B/C nên hợp chỉ 212 bảng phân biệt (không 226/227), tiêu đề nhóm rò sống 16 vs 14 tên phải khớp. Dựng scripts/build-org-boundary-inventory.mjs sinh docs/generated/org-boundary-inventory.json bằng cách PARSE chính file plan, cùng gate:org-boundary-inventory với 4 điều kiện đỏ. Đưa bảng miễn trừ lên GĐ1. Gán giai đoạn cho 5 bảng chưa ai nhắc. Đổi tên np_org_boundary cho khớp quy ước.
  - *Vì sao:* Ba chi tiết review sai đều sai theo hướng NHẸ HƠN thực tế. Nhóm C khai 51 nhưng chỉ có 50 tên thật (room_price_history không có cột organization_id nên không nằm trong mẫu số — chính Phụ lục C của plan đã tự nói). Review giả định các nhóm không chồng lấn, thực tế nhóm D giao B 7 bảng và giao C 7 bảng nên hợp chỉ 212, tức sau khi làm sạch toàn bộ giai đoạn vẫn còn 61 bảng thiếu boundary, cộng 14 bảng giai đoạn sau thì còn 47 bảng không ai nhận — muốn về ≤20 phải khai miễn trừ ít nhất 27 bảng tron…
- **F10 — baseline-so-dong-khong-on-dinh (review chấm medium, kiểm chứng: ĐÚNG MỘT PHẦN, mức thật medium)** — Phân vai ba loại vị từ thay vì viết lại gate. GIỮ NGUYÊN mọi tiêu chí dạng '=0' làm gate chặn (GĐ0 cả 4 chốt, và các mục =0 ở mọi giai đoạn). Chuyển gate chặn PR sang TẦNG 1 fixture + vị từ catalog; gỡ gate:org-leak khỏi danh sách chặn để hết mâu thuẫn nội bộ (TẦNG 2 'nightly' ở một chỗ, 'không continue-on-error' ở chỗ khác). Thay 'visible_own phải bằng nhau so baseline cũ' bằng 'visible_own = ground_truth_own đo cùng lần chạy'. Thay 'TÁI LẬP ĐÚNG 224/8568' bằng 'TẬP bảng rò phải đúng' + so với ground_truth cùng lần. Bỏ '1216→1005', bỏ 'thấy đúng 30 vật tư', bỏ '4175 dòng NULL' khỏi mọi tiêu c…
  - *Vì sao:* Các con số đã LỆCH ngay trong chính ngày plan được viết: 4175→4176 dòng NULL, public_room_events 11149→11150, 3022→3023, với tốc độ sinh 857 dòng/7 ngày và 24 dòng NULL trong 24h gần nhất. Tiêu chí 'Lệch một con số nghĩa là bộ đo hỏng, không phải hệ đã đổi' do đó đã KHÔNG THỂ đạt được tại thời điểm kiểm — nó diễn giải mọi trôi dữ liệu thành 'bộ đo hỏng', tức đúng ngược. 'visible_own phải bằng nhau' vỡ ngay khi một nhân viên xoá một vật tư của chính org mình. Nhưng review chấm quá rộng ở hai chỗ:…
- **Giữ nguyên — những phần plan v1 làm ĐÚNG và đã được đối chiếu bằng máy** — KHÔNG đổi: 7 nguyên tắc thiết kế (đặc biệt số 1 suy-từ-catalog, số 2 miễn trừ là dữ liệu có ràng buộc, số 4 RESTRICTIVE chỉ siết không nới, số 5 đọc-policy-không-phải-bằng-chứng, số 6 preflight đếm FK chéo, số 7 boundary luôn TO authenticated); khuôn ba phần của 20260807163000 (preflight → boundary → verify); bốn chốt chống ảo giác và luật cấm subquery trong phiên authenticated; ba tầng cưỡng chế và ba tầng đo; kỷ luật vận hành khi đo trên prod; phân nhóm A (36 tên), B (122), D (18); toàn bộ 8 nhóm rủi ro khi siết; toàn bộ GĐ7 (bảng/view không có cột org), GĐ8 (RPC + storage, 11 việc), GĐ9 (fr…
  - *Vì sao:* Đối chiếu bằng máy trên prod cho thấy các phần này đúng và đắt để dựng lại: nhóm A 36 tên khớp 100%, nhóm B đo bằng NOT has_table_privilege('authenticated', oid, 'SELECT') ra đúng 122, nhóm D đo bằng pg_publication_tables ra đúng 18, con số 182 bảng (có organization_id ∧ authenticated GRANT SELECT) đo độc lập cũng ra đúng 182. Các án lệ mà plan viện dẫn đều tái lập được (migration 20260801080000 kết luận sai 340 dòng vì quên SET LOCAL ROLE; 'profiles rò 7/7' là ảo giác vì organization_membership…

## Các giai đoạn

### GĐ0 — Bịt bề mặt ẩn danh (chỉ biện pháp thuần DB đã kiểm chứng khả thi)

**Mục tiêu.** Xoá sạch đường đọc dữ liệu khách của bất kỳ tổ chức nào mà không cần một tài khoản. Đây là giai đoạn duy nhất kẻ khai thác không cần gì ngoài anon key vốn nằm sẵn trong bundle frontend. Phạm vi bị siết lại đúng những gì thuần DB và revert được bằng migration; rate-limit theo IP bị bóc sang GĐ-R vì đo được là dự án không có kiến trúc đỡ nó.

**Bị chặn bởi:** không

**Việc cần làm**

1. VIỆC 0, LÀM TRƯỚC MỌI `git add`: redact PII thật ở docs/plans/PLAN-TACH-DU-LIEU-DA-CONG-TY.md:370 (mục A9). Dòng đó đang chứa họ tên đầy đủ + số di động 10 số + mã hoá đơn + số tiền + toà/phòng của MỘT khách hàng thật org aaaa. Thay bằng mô tả hình dạng: ten=<REDACTED họ tên khách thật, 4 âm tiết>, sdt=<REDACTED số di động 10 số>, so_hd=<REDACTED mã INV-2026-xxxxx>, tong/con_lai=<REDACTED ~5,0 triệu VND>, giữ nguyên so_dong_items=4 và current_user="anon" vì ĐÓ mới là bằng chứng. Đã xác minh file chưa từng vào Git history (git ls-files rỗng, git log --all -S trên cả số điện thoại lẫn tên đều 0 kết quả) nên KHÔNG cần git filter-repo/BFG.
2. REVOKE EXECUTE ON FUNCTION public.get_public_latest_invoice_by_contract(uuid) FROM PUBLIC, anon, authenticated; chuyển thân sang app_private.latest_invoice_by_contract_v1(uuid); get_public_latest_invoice_by_code(text) gọi bản app_private (vẫn chạy vì SECURITY DEFINER).
3. building_of_invoice(uuid), building_of_contract(uuid), building_of_payment(uuid): REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated — BẮT BUỘC có PUBLIC. Đo được proacl cả ba hàm là `=X/postgres | postgres=X/postgres | anon=X/postgres | authenticated=X/postgres | service_role=X/postgres`; mục `=X/postgres` không tên role CHÍNH LÀ PUBLIC. Đã chạy thật lệnh revoke đúng như v1 viết (chỉ anon, authenticated) và has_function_privilege('authenticated', ...) VẪN TRUE — tức bước vá của v1 là no-op bảo mật hoàn toàn.
4. Di chuyển bằng ALTER FUNCTION ... SET SCHEMA app_private, TUYỆT ĐỐI không DROP + CREATE. SET SCHEMA giữ nguyên OID nên 38 policy trên 10 bảng (asset_handovers, contract_customers, contract_extensions, contract_services, contract_tenants, contract_terminations, contract_transfers, deposits, excess_amounts, invoice_items) tự bám theo, không cần viết lại. DROP sẽ kéo lỗi phụ thuộc hoặc phải CASCADE làm mất policy.
5. CÙNG migration: CREATE OR REPLACE FUNCTION public.approve_contract_termination_v1(uuid, text) và public.reject_contract_termination_v1(uuid, text), đổi public.building_of_contract → app_private.building_of_contract. Đây là hai thân hàm SECURITY DEFINER duy nhất trên prod gọi ba hàm đó — bác bỏ trực tiếp câu 'chúng chỉ được policy RLS gọi' của v1 dòng 79 và 378. Giữ nguyên proconfig/search_path khi replace. TUYỆT ĐỐI không sửa supabase/migrations/20260731070000_current_date_to_org_today.sql:673 (migration đã chạy là bất biến).
6. ASSERT trong chính migration: quét pg_proc.prosrc ~* 'building_of_(invoice|contract|payment)' và RAISE nếu còn hàm nào ngoài app_private tham chiếu tên cũ — bắt hàm mới phát sinh sau lần đo hôm nay (hôm nay đúng 2 hàm).
7. customer_in_my_scope(uuid,uuid) và ie_item_restricted_visible(uuid): ĐỌC proacl TRƯỚC khi viết migration, rồi REVOKE ... FROM PUBLIC, anon, authenticated và ALTER FUNCTION ... SET SCHEMA app_private. v1 chỉ ghi 'anon + authenticated' ở mục này nên mắc đúng lỗ vừa chứng minh.
8. RATCHET: scripts/check-definer-acl.mjs + scripts/definer-acl-baseline.json phải kiểm cả mục ACL KHÔNG TÊN ROLE ('=X/...' = PUBLIC), không chỉ anon/authenticated. Nếu chỉ soi anon thì đúng lỗ hổng vừa chứng minh sẽ lọt qua CI.
9. public_room_share_tokens — làm HOÀN TOÀN bằng MỘT migration forward mới `<ts>_share_token_hardening.sql`. TUYỆT ĐỐI không chạm 20260802235000_share_token_dsphongtrong_alias.sql: version 20260802235000 ≤ provisionalCutoff 20260805120000 nên legacy-frozen (supabase/migration-policy.json §provisionalCutoff.legacyPolicy), Contract §5 dòng 209-210 và §11.4 dòng 449 cấm. Nội dung theo thứ tự: (a) UPDATE SET revoked=true WHERE token IN ('demo','dsphongtrong'); (b) INSERT token thay thế ngẫu nhiên ≥16 ký tự cùng owner_id/organization_id; (c) xử lý dòng organization_id IS NULL (hiện là token '7i2oKN') rồi ALTER COLUMN SET NOT NULL; (d) ADD CONSTRAINT public_room_share_tokens_token_len_chk CHECK (length(token) >= 16) NOT VALID rồi VALIDATE. CHÍNH CHECK ở (d) là thứ THAY THẾ nhu cầu sửa file nguồn: nếu file cũ bị replay ở bản local, INSERT 'dsphongtrong' (12 ký tự) sẽ ERROR chứ không âm thầm mở lại token yếu — fail-closed thay vì fail-open.
10. contracts.public_code — xoay TOÀN BỘ 678 mã đang sống sang ≥16 ký tự, KHÔNG chỉ 'mã phát sinh mới' như v1 viết. Đo được 678/678 dòng public_code IS NOT NULL đều dài <16 ký tự; nếu chỉ áp cho mã mới thì 678 mã 6 ký tự sống mãi và toàn bộ lập luận chống brute-force vô nghĩa. Dùng lại public.gen_contract_public_code(len), đổi DEFAULT 6 → 16, thêm CHECK length(public_code) >= 16. BẮT BUỘC kèm cột old_public_code + old_code_expires_at và nhánh resolve chấp nhận mã cũ tới hạn — 678 QR đã in/gửi cho khách, xoay mã không có cửa sổ ân hạn là sự cố diện rộng với khách thuê.
11. Thêm expires_at và revoked cho public_code VÀ ĐƯA VÀO mệnh đề WHERE của get_public_latest_invoice_by_code — v1 chỉ nói 'thêm cột', thêm cột mà không lọc thì không có tác dụng gì.
12. Bỏ customer.phone khỏi payload công khai, sửa trong app_private.latest_invoice_by_contract_v1. Client không vỡ: src/pages/public/PublicContractInvoicePage.tsx:245-257 bọc trong `customer?.full_name &&` và render `customer.phone || 'N/A'`, tệ nhất là hiện 'N/A'; dọn khối JSX đó là việc nhỏ đi kèm.
13. lucky-proofs chiều GHI: policy 'lucky proofs upload' chỉ hỏi lucky_event_open_v1(folder), không hỏi sự kiện thuộc org nào — đã đo anon INSERT thành công. Thêm điều kiện org ngay.
14. npm run gen:types theo đúng cách CI làm (KHÔNG redirect '>' vào types.ts — shell cắt trắng file đích trước khi generator kịp chạy). 3 entry ở src/integrations/supabase/types.ts:23564-23566 sẽ biến mất; grep `rpc(['\"]building_of_` = No matches nên không có caller nào vỡ.
15. KHÔNG LÀM Ở ĐÂY: rate-limit theo IP. Chuyển sang GĐ-R kèm lý do đo được.

**File chính:** `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/docs/plans/PLAN-TACH-DU-LIEU-DA-CONG-TY.md`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/ (mới: <ts>_revoke_anon_rpc_surface.sql, <ts>_share_token_hardening.sql, <ts>_public_code_hardening.sql)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/check-definer-acl.mjs`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/definer-acl-baseline.json`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/pages/public/PublicContractInvoicePage.tsx`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/.github/workflows/ci-gates.yml`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/integrations/supabase/types.ts`

**Xong khi:** (1) SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND has_function_privilege('anon',p.oid,'EXECUTE') AND p.proname NOT IN (<allow-list khai trong repo>) = 0. (2) Với cả 5 hàm đã di chuyển: has_function_privilege('anon'|'authenticated', oid, 'EXECUTE') = false VÀ proacl KHÔNG còn mục nào không-tên-role. (3) SELECT count(*) FROM pg_proc WHERE pronamespace <> 'app_private'::regnamespace AND prosrc ~* 'building_of_(invoice|contract|payment)' = 0. (4) POST HTTP thật bằng anon key tới /rest/v1/rpc/get_public_latest_invoice_by_contract và ba hàm building_of_* → 404/PGRST202. (5) count(*) FROM public_room_share_tokens WHERE revoked=false AND length(token)<16 = 0; count(*) WHERE organization_id IS NULL = 0; attnotnull=true trên cột đó. (6) count(*) FROM contracts WHERE public_code IS NOT NULL AND length(public_code)<16 = 0 VÀ ràng buộc CHECK tồn tại trong pg_constraint. (7) Một test khẳng định JSON trả về từ RPC công khai KHÔNG có khoá 'phone'; một test khẳng định mã đã hết hạn/thu hồi trả NULL; một test khẳng định mã cũ trong cửa sổ ân hạn VẪN mở được trang /c/:code. (8) gate:definer-acl xanh VÀ có test mutation hai chiều trong scripts/__tests__: thêm GRANT anon giả → đỏ, thêm GRANT PUBLIC giả (không tên role) → cũng đỏ. (9) gate:migration-provenance xanh — 0 byte thay đổi trên mọi file supabase/migrations có version ≤ 20260805120000. (10) grep -oE '[0-9]{9,}' trên file plan, lọc bỏ chuỗi đúng 14 ký tự (timestamp migration) → rỗng; grep họ Việt + tên viết hoa → rỗng. Mọi tiêu chí đều là vị từ =0 hoặc sự-tồn-tại-của-ràng-buộc, không có số dòng nghiệp vụ nào.

### GĐ1 — Sổ đăng ký miễn trừ + inventory sinh bằng máy

**Mục tiêu.** Tạo TRƯỚC chỗ để khai 'bảng này cố ý đứng ngoài', và một inventory sinh bằng máy gán cho MỌI bảng đúng một giai đoạn hoặc một lý do miễn trừ. Đây là giai đoạn mới hoàn toàn so với v1, sinh ra vì hai lỗi thứ tự đo được: sổ miễn trừ nằm chung file với generator nên lần chạy đầu chắc chắn rỗng, và DoD của GĐ2 cũ viện tới 'nhóm miễn trừ' trong khi bảng miễn trừ mãi giai đoạn sau mới tồn tại.

**Bị chặn bởi:** GĐ0 (thứ tự ưu tiên rủi ro, không phải phụ thuộc kỹ thuật — GĐ1 chạy được độc lập nhưng không được phép chen trước việc bịt lỗ ẩn danh)

**Việc cần làm**

1. Migration mới `<ts>_org_boundary_exemptions_registry.sql`: CREATE TABLE app_private.org_boundary_exemptions(table_name text PRIMARY KEY, reason text NOT NULL, decided_by text NOT NULL, expires_at date NOT NULL, replacement_policy text NULL). File này CHỈ tạo bảng và seed — TUYỆT ĐỐI chưa có vòng DO sinh policy và chưa có CREATE EVENT TRIGGER (chúng ở GĐ5). Đo được app_private.org_boundary_exemptions HIỆN CHƯA TỒN TẠI nên nếu gộp như v1 thì generator quét trên sổ rỗng theo cấu trúc, không phải theo may rủi.
2. INSERT seed, mỗi reason là CON SỐ ĐO ĐƯỢC chứ không phải lời khai: ai_providers ('bảng global, PK là PRIMARY KEY(provider) không chứa organization_id; đo: demo.chunha 10→0, .eq(enabled,true)→0 nên dropdown model rỗng', replacement_policy NULL); ai_copilot_settings ('PK(id boolean) nên toàn CSDL tối đa 2 dòng; đo 1→0 nên maybeSingle() trả null'); profiles ('nhãn lệch: 7/15 dòng mang org không nằm trong membership ACTIVE của chủ, 0/7 là super admin; đo demo.chunha 7→0 và MẤT CHÍNH DÒNG CỦA MÌNH own 1→0', replacement_policy ghi tên đường đọc thật current_visible_owner_ids()/same_team()); roles ('bản ghi theo người; đo demo.chunha 7→2'); settings ('bản ghi theo người, còn 2 dòng NULL org; useSettings.ts đọc chỉ lọc theo key nên đổi lực lọc là đổi cardinality của maybeSingle() → đúng lớp lỗi PGRST116 trang trắng'); ai_chat_threads và ai_chat_messages ('không DEFAULT, không trigger autofill, chatEngine.ts insert không set organization_id'); ai_copilot_entitlements và ai_usage_logs ('hình dạng theo-người/theo-owner, tác động sống thấp nhưng phải được PHÂN LOẠI tường minh thay vì để generator tự quyết').
3. expires_at: ai_chat_threads/ai_chat_messages đặt bằng mốc GĐ6 dự kiến (vì GĐ6 là nơi vá đường ghi); profiles/roles/settings/ai_* còn lại đặt bằng mốc GĐ10 dự kiến. Đây là cách RẺ HƠN việc kéo GĐ10 lên trước: giữ nguyên thứ tự giai đoạn nhưng gate quá-hạn tự biến 'hoãn' thành deadline, đúng tinh thần tooling/known-gaps.yaml.
4. BỎ khỏi danh sách seed: permission_definitions, legacy_owner_allowlist, authorization_migration_exceptions. Đo được là cả ba KHÔNG có cột organization_id nên generator không với tới; chúng thuộc nhóm 12 bảng không-có-cột-org của GĐ7. Sửa luôn câu chữ Rủi ro #7 (plan dòng 299) đang gộp nhầm chúng vào cùng nhóm với ai_providers.
5. Nâng câu của Rủi ro #2 (plan dòng 289) — 'GĐ9 xong TRƯỚC khi ba bảng profiles/roles/settings được siết' — từ phụ lục rủi ro thành một dòng trong danh sách 'Việc cần làm', vì người thi hành đọc danh sách việc chứ không đọc phụ lục.
6. scripts/build-org-boundary-inventory.mjs (mới): đọc catalog prod chỉ bằng SELECT trên pg_catalog, tái dùng readPat()/readProjectRef()/runSql() của scripts/capture-production-catalog.mjs, từ chối mọi query chứa từ khoá ghi/COMMIT. Group và assigned_phase phải SINH TỪ VIỆC PARSE CHÍNH FILE PLAN (quét tên bảng trong các mục giai đoạn), KHÔNG gõ tay — đó là cách duy nhất phát hiện được bảng chưa từng được nhắc, và cũng là cách duy nhất không tái tạo đúng khuyết tật gốc mà kế hoạch này đang đi vá.
7. docs/generated/org-boundary-inventory.json (+ bản .md người đọc được), khuôn giống docs/generated/database-inventory.json. Mỗi dòng = một relation, cột bắt buộc: table_name, relkind, is_partition, has_organization_id, org_column_names[], boundary_policy_name, boundary_name_matches_convention, authenticated_can_select, in_realtime_publication, group ∈ {A_empty, B_no_grant, C_indirect, D_realtime, LIVE_LEAK, NO_ORG_COLUMN, EXEMPT, UNASSIGNED}, assigned_phase, exemption_reason, decided_by, expires_at, source_line (số dòng trong plan nơi bảng được nêu — để chống việc plan và inventory lệch nhau), capturedAt, catalogFingerprint.
8. gate:org-boundary-inventory (--check), nối vào job quality-gates của .github/workflows/ci-gates.yml. ĐỎ khi: (a) tồn tại bất kỳ dòng group=UNASSIGNED; (b) |bảng thiếu boundary| ≠ |gán các giai đoạn| + |EXEMPT|; (c) có EXEMPT nào expires_at đã qua hoặc thiếu reason/decided_by; (d) inventory cũ hơn catalogFingerprint hiện tại của prod.
9. Xử lý 5 bảng KHÔNG XUẤT HIỆN DÙ MỘT LẦN trong toàn bộ 143KB plan v1 mà vẫn có organization_id, authenticated đọc được, thiếu boundary: special_fee_claims, termination_refund_obligations, profit_payout_exceptions, profit_payout_reservations, openclaw_capacity_controls. Đo rò bằng persona rồi gán GĐ3 (nếu rỗng/kín) hoặc GĐ4 (nếu đang rò), trước khi chốt DoD của GĐ3.
10. Migration nhỏ đổi tên policy np_org_boundary → notification_preferences_org_boundary. Đo được: pg_policy có 32 policy khớp '%org_boundary%' nhưng notification_preferences mang tên viết tắt nên không khớp quy ước relname||'_org_boundary' và sẽ bị gate đếm là 'thiếu' VĨNH VIỄN — đây chính là nguyên nhân lệch 272 vs 273 giữa plan và phép đo.
11. Sửa số nhóm trong plan: nhóm C ghi 50 chứ không 51 (room_price_history KHÔNG có cột organization_id nên không nằm trong mẫu số — chính Phụ lục C của plan đã tự nói điều đó, nó thuộc GĐ7); nhóm D ghi '18 bảng, trong đó 14 đã thuộc B/C, chỉ 4 là mới' để không cộng trùng; tiêu đề nhóm rò sống ghi 16 nhưng chỉ liệt kê 14 tên — hoặc nêu đủ 16, hoặc sửa thành 14 và nói 2 bảng còn lại nằm ở đâu.

**File chính:** `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/ (mới: <ts>_org_boundary_exemptions_registry.sql, <ts>_rename_np_org_boundary.sql)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/build-org-boundary-inventory.mjs (mới)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/docs/generated/org-boundary-inventory.json (mới)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/capture-production-catalog.mjs`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/__tests__/org-boundary-inventory.test.mjs (mới)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/.github/workflows/ci-gates.yml`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/package.json`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/docs/plans/PLAN-TACH-DU-LIEU-DA-CONG-TY.md`

**Xong khi:** (1) npm run gate:org-boundary-inventory --check exit 0 VÀ số dòng group=UNASSIGNED = 0. (2) SELECT count(*) FROM app_private.org_boundary_exemptions ≥ 9 VÀ count(*) WHERE reason IS NULL OR decided_by IS NULL OR expires_at IS NULL = 0. (3) SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE p.polname LIKE '%org_boundary%' AND p.polname <> c.relname||'_org_boundary' = 0 (quy ước tên khớp gate). (4) Mutation test: xoá một tên bảng khỏi mục giai đoạn trong BẢN COPY của plan → gate PHẢI đỏ vì sinh ra 1 dòng UNASSIGNED. (5) Mutation test thứ hai: xoá một dòng seed miễn trừ → gate PHẢI đỏ. (6) gate:migration-idempotent xanh với migration registry (chạy hai lần cho kết quả giống nhau). (7) 0 dòng miễn trừ nào thiếu expires_at và 0 dòng nào đã quá hạn tại thời điểm chạy. Không tiêu chí nào chốt theo số dòng dữ liệu nghiệp vụ.

### GĐ2 — Bộ đo hai tầng: TẦNG 1 dựng từ baseline, TẦNG 2 đọc prod

**Mục tiêu.** Biến 'tách bạch dữ liệu' từ một tính từ thành một con số chạy được, TRƯỚC khi vá bất cứ gì — chủ trương này của v1 đúng và giữ nguyên. Sửa hai thứ v1 sai: nguồn schema của bản local (không thể dựng từ supabase/migrations) và vai trò của các số đo trên prod (không được làm gate chặn PR).

**Bị chặn bởi:** GĐ1 (inventory cấp tập bảng cần đo; sổ miễn trừ cấp danh sách ô được phép khác 0 — thiếu hai thứ đó thì bộ đo lại phải viết tay danh sách bảng, đúng khuyết tật gốc)

**Việc cần làm**

1. GIẢI CHỐT CHẶN TRƯỚC MỌI THỨ: supabase/baseline/schema.sql (5,5MB) đang nằm trong .gitignore dòng 115, nên lời hứa 'TẦNG 1 chạy MỌI PR, không cần PAT, không bao giờ chạm prod' HIỆN KHÔNG THỰC HIỆN ĐƯỢC — CI không có file để dựng. Chọn MỘT và ghi thẳng vào plan: (i) commit supabase/baseline/schema.sql.zst và bỏ dòng ignore cho biến thể nén; (ii) đẩy thành release asset / CI cache artifact kèm gate đối chiếu sha256 với supabase/baseline/manifest.json (trường sha256 đã có sẵn); (iii) nếu cả hai không được thì HẠ lời hứa TẦNG 1 xuống 'nightly + trước migrate:forward' — nhưng phải NÓI RA, không được để lời hứa sai trong tài liệu.
2. scripts/test-org-isolation-sql.mjs --local: TUYỆT ĐỐI KHÔNG dựng DB từ supabase/migrations. Contract §5 dòng 215-218 tuyên bố 'Legacy history KHÔNG replay được'; đo lại còn tệ hơn con số Contract ghi — 632 file .sql, 36 nhóm trùng version (016 ×4, 20260627000001 ×3, 20260603000003 ×3, 20260603000002 ×3), ledger prod supabase_migrations.schema_migrations chỉ 372 dòng. Chính tiền lệ mà v1 viện dẫn cũng tự bác v1: npm run test:openclaw:sql:local dùng PGlite + OPENCLAW_DISPOSABLE_FIXTURE_SQL + đúng 12 file trong danh sách cứng OPENCLAW_MIGRATIONS, không quét cả thư mục.
3. Quy trình dựng đúng, theo supabase/baseline/README.md: (a) psql -v ON_ERROR_STOP=1 -f supabase/baseline/roles.sql; (b) psql -v ON_ERROR_STOP=0 -f supabase/baseline/schema.sql; (c) chạy LẠI schema.sql LƯỢT 2 — bắt buộc, lượt 1 rơi rooms.name_sort và 3 view phụ thuộc; (d) apply tiếp CHỈ những migration có version > 20260805120000 (đọc từ supabase/migration-policy.json). Không quét cả supabase/migrations, không đụng supabase/migrations-archive (Contract dòng 218 và 449 cấm tuyệt đối). Việc của GĐ này KHÔNG phải 'thiết kế bootstrap' — ADR-0002 đã giao xong thứ đó (schema.sql, roles.sql, diễn tập khôi phục 439/439 bảng và 1193/1193 policy) — mà là 'trỏ vào baseline'.
4. Vehicle: Docker supabase/postgres:17.6.1.156, bind 127.0.0.1 (án lệ Docker chọc thủng UFW ghi ở scripts/openclaw-local-stack.mjs:20-21). KHÔNG dùng PGlite cho tầng này: prod có pg_cron, supabase_vault, vector, btree_gist và cần schema auth thật. Tái dùng scripts/dien-tap-khoi-phuc-baseline.mjs làm bộ dựng (nó đã có chốt cứng từ chối connection string chứa project ref production), thêm cờ --dich-tam để nó tự dựng container thay vì đòi connection string.
5. Seed đi theo THỨ TỰ TOPO suy từ pg_constraint, KHÔNG chép tay danh sách bảng — chép tay đúng là khuyết tật gốc mà cả kế hoạch này đang đi vá. Nhân vật: 3 org A/B/S + uA (chỉ A), uB (chỉ B), uAB (ACTIVE cả hai — nhân vật quan trọng nhất, chính người hai org đã phá giả định ở public_room_events), u0 (mồ côi, đối chứng âm) + vai anon. Với mỗi bảng public có organization_id: gieo đúng N=2 dòng cho A và 2 cho B. Số dòng do fixture TỰ ĐỊNH nên mọi khẳng định về nó tất định vĩnh viễn.
6. Vị từ TẦNG 1 (đây là tầng chặn PR): P1 visible_foreign(mọi bảng, mọi persona) = 0; P2 visible_own(uA) = số đã gieo cho A, bằng đúng chứ không xấp xỉ; P3 uAB thấy đủ dòng của CẢ A và B — chốt chống siết nhầm thật sự; P4 u0 và anon = 0 ở mọi bảng; P5 ma trận ghi: INSERT/UPDATE/DELETE chéo org trả 0 dòng ảnh hưởng — đây là tầng DUY NHẤT đo được chiều GHI và chiều ghi tuyệt đối không đo trên prod (v1 đúng, giữ); P6 mutation: DROP một boundary → bộ test PHẢI đỏ.
7. scripts/measure-org-leak.mjs (TẦNG 2, prod chỉ đọc): GIỮ NGUYÊN toàn bộ bốn chốt chống ảo giác của v1 — current_user='authenticated' và rolbypassrls=false; auth.uid() trả đúng uid vừa đặt; đối chứng dương income_expense_types tổng>0 foreign=0; đối chứng âm uid mồ côi = 0 mọi bảng. Giữ nguyên luật cấm tính cross-org bằng subquery chạy trong phiên authenticated (án lệ 'profiles rò 7/7'). Giữ nguyên persona SUY RA TỪ DB, không hard-code người.
8. THAY vị từ so-với-hằng-số bằng vị từ TỰ TÍNH LẠI: mỗi ô ghi BA số {visible_own, visible_foreign, ground_truth}, trong đó ground_truth đo bằng quyền quản trị ở BƯỚC HAI của CHÍNH lần chạy đó. Bất biến chống siết nhầm là visible_own = ground_truth_own cùng lần chạy — nó tất định, tự cập nhật khi dữ liệu đổi, và không bao giờ đỏ vì ai đó xoá một vật tư của chính org mình. Vị từ chống rò vẫn là visible_foreign = 0 (điểm bất động).
9. docs/generated/org-leak-baseline.json bắt buộc mang projectRef, serverVersion, capturedAt (ISO), catalogFingerprint — import THẲNG catalogFingerprint() từ scripts/capture-production-catalog.mjs:145, không viết lại. Luật so: catalogFingerprint khác baseline → công cụ báo 'catalog đã đổi kể từ baseline, cần re-baseline có chủ đích' chứ KHÔNG âm thầm so tiếp, đúng khuôn --check ở capture-production-catalog.mjs:204-221. Việc nhỏ bắt buộc kèm theo: thêm `export` cho runSql ở capture-production-catalog.mjs:46, vì plan đang dặn tái dùng một hàm chưa export.
10. PHÂN VAI GATE, sửa mâu thuẫn nội bộ của v1 (một chỗ xếp TẦNG 2 là 'nightly + trước/sau migrate:forward', chỗ khác lại nối gate:org-leak vào ci-gates.yml 'không continue-on-error'): CHẶN PR = TẦNG 1 + các vị từ CATALOG (đọc prod read-only, an toàn để chặn). KHÔNG chặn PR = mọi số dòng production; gỡ gate:org-leak khỏi danh sách chặn. Ngoại lệ DUY NHẤT được phép chặn: ô nào có baseline visible_foreign = 0 mà đo ra > 0 → đỏ cứng, vì đó lại là vị từ =0. Lý do phải ghi thẳng vào plan, trích chính repo để quyết định không bị đảo lại: scripts/capture-production-catalog.mjs:138-144 — 'báo động giả hằng ngày sẽ bị tắt đi trong một tuần, và khi ấy thay đổi schema thật cũng không ai thấy'.
11. Thêm chốt chống baseline cũ: baseline chụp 06/08/2026 (manifest.capturedAt = 2026-08-06T01:31:56.916Z); nếu prod đổi schema mà baseline không chụp lại thì TẦNG 1 xanh giả. Gate so version cutoff trong migration-policy.json với manifest.capturedAt và fail khi lệch quá ngưỡng, tương tự scripts/check-backup-freshness.mjs đã có.
12. GIỮ NGUYÊN kỷ luật runner của v1 (đúng, không sửa): in NGUYÊN VĂN SQL kèm mỗi kết quả, TỪ CHỐI mọi query chứa COMMIT hoặc từ khoá DDL/ghi, tạo-và-dùng file trong CÙNG một lệnh, không lồng BEGIN trong BEGIN.

**File chính:** `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/test-org-isolation-sql.mjs (mới)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/measure-org-leak.mjs (mới)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/dien-tap-khoi-phuc-baseline.mjs`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/baseline/README.md`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/baseline/manifest.json`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/.gitignore`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/docs/generated/org-leak-baseline.json (mới)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/capture-production-catalog.mjs`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/package.json`

**Xong khi:** (1) npm run test:org-isolation:local dựng được DB từ supabase/baseline và P1..P6 xanh; riêng P6 (DROP một boundary → đỏ) chứng minh bộ đo không đang kiểm chính nó. (2) Assert trong chính script: 0 lần đọc file supabase/migrations có version ≤ 20260805120000 và 0 lần đọc supabase/migrations-archive — script tự fail nếu vi phạm. (3) CI có schema để dựng, chứng minh bằng một job chạy được trên PR KHÔNG cần SUPABASE_PAT; hoặc plan đã ghi rõ lời hứa TẦNG 1 đã bị hạ xuống nightly. (4) measure-org-leak.mjs thiếu PAT hoặc thiếu bất kỳ chốt chống ảo giác nào → exit 3, KHÔNG BAO GIỜ exit 0, có test khẳng định điều này. (5) docs/generated/org-leak-baseline.json có đủ projectRef + serverVersion + capturedAt + catalogFingerprint, và mỗi ô có đủ ba số; sửa fingerprint giả → công cụ TỪ CHỐI so thay vì so tiếp. (6) runSql đã được export ở capture-production-catalog.mjs. (7) gate:org-leak KHÔNG còn nằm trong danh sách gate chặn PR của ci-gates.yml. Mọi tiêu chí là hành vi của công cụ, không phải số dòng dữ liệu.

### GĐ3 — Vá nơi bản vá KHÔNG THỂ gây hồi quy

**Mục tiêu.** Dựng tường ở những nơi hôm nay không ai đang đứng: bảng rỗng, bảng client chưa đọc được, bảng đang kín nhờ cơ chế khác, bảng realtime. Vì RESTRICTIVE nối bằng AND, ở những nơi này bản vá chứng minh được là không thể làm ai mất dữ liệu — lập luận này của v1 đúng và là lý do giai đoạn đứng sớm.

**Bị chặn bởi:** GĐ2 (không được vá khi chưa có bộ đo — nếu vá trước thì không có cách nào phân biệt 'kín rồi' với 'siết nhầm')

**Việc cần làm**

1. GIỮ NGUYÊN bốn nhóm A/B/C/D của v1 — phân nhóm đã được đối chiếu bằng máy trên prod và khớp: nhóm A 36 tên khớp 100%; nhóm B (NOT has_table_privilege('authenticated', oid, 'SELECT')) = 122 khớp chính xác; nhóm D (in pg_publication_tables pubname='supabase_realtime') = 18 khớp chính xác. Giữ nguyên toàn bộ lập luận vì sao từng nhóm an toàn.
2. SỬA SỐ: nhóm C là 50 chứ không 51 — phân nhóm 'chặn gián tiếp qua building_id' của v1 khai 9 nhưng chỉ liệt kê 8 tên, cái thứ 9 (room_price_history) không có cột organization_id nên không nằm trong mẫu số và thuộc GĐ7.
3. SỬA GIẢ ĐỊNH KHÔNG CHỒNG LẤN: đo trên prod thì nhóm D giao nhóm B 7 bảng và giao nhóm C 7 bảng, tức 14/18 bảng của D đã nằm sẵn ở nhóm khác. Hợp A∪B∪C∪D chỉ là 212 bảng PHÂN BIỆT, không phải 226 như phép cộng ngây thơ. Ghi con số này vào plan để không ai cộng trùng lần nữa.
4. THAY DoD 'ngưỡng cứng ≤ 20' bằng DoD DẪN XUẤT: missing_after = (số bảng thiếu boundary, đo bằng CHÍNH câu SQL của gate) − |A∪B∪C∪D|, và MỌI bảng còn lại phải có dòng trong docs/generated/org-boundary-inventory.json với assigned_phase hoặc exemption_reason. Lý do: sau khi làm sạch toàn bộ giai đoạn này vẫn còn 61 bảng thiếu boundary; cộng 14 bảng của GĐ4 thì vẫn còn 47 bảng không ai nhận — muốn về ≤20 phải khai miễn trừ ít nhất 27 bảng, trong khi DoD cũ chỉ chừa chỗ cho ~4 suất. Không được để một con số viết tay làm điều kiện nghiệm thu.
5. GIỮ NGUYÊN khuôn ba phần của supabase/migrations/20260807163000_ie_types_org_boundary.sql cho mọi migration trong giai đoạn: preflight đếm cross-org FK và RAISE nếu >0 → boundary → verify (policy phải RESTRICTIVE, phải FOR ALL, và các policy cũ phải còn nguyên vì lớp mới là THÊM chứ không phải THAY). v1 đúng ở đây.
6. GIỮ NGUYÊN việc thứ hai bắt buộc của nhóm B: gate cấm mọi migration chứa GRANT diện rộng lên schema public — một dòng 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated' là sụp toàn bộ 122 bảng cùng lúc mà không có RLS đỡ.
7. GIỮ NGUYÊN việc backfill/đặt DEFAULT organization_id cho push_subscriptions và salary_award_errors.
8. THAY phép đo chống siết nhầm: v1 dùng 'ô visible_own phải BẰNG NHAU từng bảng từng persona' so với baseline cũ — vỡ ngay khi một nhân viên xoá một vật tư của chính org mình. Thay bằng visible_own(bảng, persona) PHẢI BẰNG ground_truth_own(bảng, persona) đo bằng quyền quản trị ở BƯỚC HAI của CHÍNH lần chạy đó.
9. Chạy phép đo chống siết nhầm TRƯỚC và SAU mỗi lô migration, ĐỎ khi bất kỳ ô visible_own nào GIẢM ở bảng không nằm trong sổ miễn trừ. Đây chính là phép kiểm cơ học sẽ bắt được ca 'profiles 7→0' mà không cần ai nhớ.

**File chính:** `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/20260807163000_ie_types_org_boundary.sql (khuôn chuẩn để copy)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/ (mới: <ts>_org_boundary_zero_regression_batch.sql)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/measure-org-leak.mjs`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/check-grant-blast-radius.mjs (mới)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/docs/generated/org-boundary-inventory.json`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/docs/generated/org-leak-baseline.json`

**Xong khi:** (1) Với MỌI bảng trong A∪B∪C∪D (212 bảng phân biệt): tồn tại policy <bảng>_org_boundary VỚI polpermissive=false, polcmd='*', và polroles = {authenticated} — đọc thẳng pg_policy, vị từ tất định. (2) missing_after = tổng thiếu boundary − |A∪B∪C∪D|, và 0 dòng inventory ở trạng thái UNASSIGNED. (3) Với mọi (bảng, persona): visible_own = ground_truth_own đo trong CÙNG lần chạy; 0 ô nào giảm ở bảng ngoài sổ miễn trừ. (4) Verify block của khuôn: các policy cũ của mỗi bảng còn nguyên (đếm policy trước/sau bằng nhau + số policy mới = 1). (5) Toàn bộ specs hiện có trong .e2e-fleet chạy headless xanh như trước khi vá. (6) Gate cấm GRANT diện rộng có test: một migration giả chứa 'GRANT SELECT ON ALL TABLES IN SCHEMA public' làm CI ĐỎ. (7) TẦNG 1: sau lô migration, P1..P4 vẫn xanh trên fixture. Không tiêu chí nào là số dòng nghiệp vụ.

### GĐ4 — Vá các bảng ĐANG RÒ SỐNG, có dữ liệu, có người đang nhìn nhầm

**Mục tiêu.** Đưa visible_foreign của mọi persona trên cụm bảng đang rò về 0. Đây là giai đoạn duy nhất bản vá có thể làm ai đó mất thứ đang thấy trên màn hình, nên nó đi SAU khi bộ đo đã dựng và SAU khi các nơi an toàn đã vá — để nếu có hồi quy thì phạm vi nghi ngờ nhỏ. Lập luận thứ tự này của v1 đúng, giữ nguyên.

**Bị chặn bởi:** GĐ3

**Việc cần làm**

1. GIỮ NGUYÊN preflight của v1, cả ba phép đếm: (a) material_usage_items / material_purchase_items / material_usages có organization_id lệch với materials.organization_id không; (b) bảng jobs đã có bản ghi nào trỏ job_type_id sang job_types của org khác chưa — việc ghi chéo FK này đã được chứng minh KHẢ THI (nathan chèn được jobs org aaaa với job_type_id của cccc) và mỗi ngày trôi qua là thêm bản ghi; (c) hoá đơn/phiếu trỏ document_templates chéo. Có dòng lai thì SỬA DỮ LIỆU trước, không dựng tường lên trên.
2. GIỮ NGUYÊN thứ tự backfill-trước-boundary-sau cho chính các bảng này, nếu không chúng vẫn lọt qua nhánh IS NULL của công thức.
3. GIỮ NGUYÊN module kho 8 bảng (materials, material_categories, material_usages, material_usage_items, material_purchases, material_purchase_items, material_adjustments, material_adjustment_items).
4. GIỮ NGUYÊN xử lý hai-việc-chứ-không-một cho public_room_events: ngoài boundary chuẩn, phải sửa chính policy public_room_events_select — nó chỉ hỏi owner_id, mà current_visible_owner_ids() trả mọi thành viên cùng org và user 90450d5f ACTIVE ở CẢ aaaa lẫn dddd, đó chính là cây cầu. Điều kiện đúng: owner_id thuộc org hiện tại ĐỒNG THỜI organization_id của dòng thuộc my_org_ids(). Giữ cả lưu ý sandbox_org_ids() chỉ chứa cccc, KHÔNG có dddd.
5. GIỮ NGUYÊN sla_configs, document_templates, job_types, job_groups, asset_movements + ghi chú asset_movements đáng chú ý vì bảng cha assets ĐÃ có assets_org_boundary — biên giới thủng ngay ở nhánh con, đúng kiểu lỗi mà danh sách viết tay sinh ra.
6. SỬA ĐẾM: tiêu đề giai đoạn nói 16 bảng nhưng thân chỉ liệt kê 14 tên. Hoặc nêu đủ 16, hoặc sửa thành 14 và nói rõ 2 bảng còn lại của tập rò sống nằm ở giai đoạn nào. Con số phải khớp danh sách, nếu không inventory ở GĐ1 sẽ sinh dòng UNASSIGNED và gate đỏ.
7. GIỮ NGUYÊN kiểm cổ đông cho từng bảng có policy *_select_shareholder — lặp phép kiểm của 20260807163000 (6/6 cổ đông đang hoạt động đều là ACTIVE member của org họ). nathan là cổ đông; nếu tồn tại cổ đông KHÔNG phải member thì boundary sẽ khoá chết họ và phải xử lý membership trước.
8. BỎ các tiêu chí chốt theo số dòng: 'nathan 12 bảng/224 dòng → 0/0', 'demo.chunha 18 bảng/8568 dòng → 0/0', 'nathan mở /materials thấy đúng 30 vật tư (hiện 63)', 'demo.chunha UPDATE materials → 0 dòng (hiện 60)'. Vế phải =0 giữ được vì 0 là điểm bất động; vế trái ('hiện 224', 'hiện 63') chuyển thành trường thông tin có capturedAt, không phải điều kiện đạt/không đạt.
9. THAY tiêu chí E2E 'thấy đúng 30 vật tư' bằng khuôn mà chính plan v1 đã phát biểu ĐÚNG ở phần Kiểm chứng: SỐ DÒNG TRÊN MÀN HÌNH khớp số của org mình ĐO ĐỘC LẬP TỪ DB trong CÙNG lần chạy.

**File chính:** `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/ (mới: <ts>_org_boundary_live_leaks.sql, <ts>_public_room_events_org_scope.sql)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/20260713121000_sprint3b_org_autofill_and_boundary.sql (CHỈ ĐỌC — tham chiếu công thức, KHÔNG sửa: file này ≤ cutoff 20260805120000 nên legacy-frozen)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/measure-org-leak.mjs`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/.e2e-fleet/specs/ (mới: materials-org-isolation.spec.ts)`

**Xong khi:** (1) visible_foreign = 0 cho MỌI persona × MỌI bảng trong tập này — vị từ =0, điểm bất động, không phụ thuộc khối lượng dữ liệu. (2) visible_own = ground_truth_own đo trong CÙNG lần chạy, từng bảng từng persona. (3) TẦNG 1 chiều ghi: UPDATE/DELETE/INSERT chéo org trên mọi bảng trong tập trả 0 dòng ảnh hưởng. (4) attnotnull = true trên cột organization_id của 3 bảng vừa backfill VÀ count(*) WHERE organization_id IS NULL = 0 trên đúng 3 bảng đó. (5) E2E headless: số dòng trên màn hình = số đo độc lập từ DB trong cùng lần chạy (không so với hằng số). (6) profiles/roles/settings vẫn có dòng miễn trừ CHƯA quá hạn trong app_private.org_boundary_exemptions — chứng minh chúng được cố ý chừa lại chứ không bị bỏ quên. (7) Kiểm cổ đông: count(*) cổ đông đang hoạt động KHÔNG phải ACTIVE member của org mình = 0, chạy lại cho từng bảng có policy shareholder.

### GĐ5 — Đảo cơ chế: biên giới SINH TỪ CATALOG + event trigger có guard + gate CI

**Mục tiêu.** Làm cho bảng sinh ra tuần sau TỰ có biên giới, không phụ thuộc vào việc ai đó nhớ. Bốn giai đoạn trước chỉ dọn hậu quả; giai đoạn này chữa nguyên nhân. Event trigger được GIỮ NGUYÊN vì đã kiểm chứng thực nghiệm là khả thi trên chính prod — nhưng phải vá hai khuyết tật mà cả review lẫn plan v1 đều không thấy.

**Bị chặn bởi:** GĐ4 (và GĐ1 cho sổ miễn trừ — generator chạy trên sổ rỗng là ca hỏng đắt nhất của plan v1)

**Việc cần làm**

1. GIỮ EVENT TRIGGER — bác bỏ nỗi lo 'postgres không tạo được event trigger' bằng thực nghiệm trên chính production trong BEGIN…ROLLBACK: CREATE EVENT TRIGGER trả CREATED_OK (không lỗi 42501), evtowner = postgres (không phải supabase_admin), và trigger FIRE thật trên CREATE TABLE. Cơ chế: Supabase nạp supautils với supautils.privileged_role = supabase_privileged_role và pg_auth_members cho thấy postgres LÀ member của role đó — cơ chế này cho phép non-superuser tạo event trigger, đúng thứ luật Postgres thuần cấm. Lane migration chạy đúng role đó: scripts/apply-reviewed-migration.mjs:446 gọi Management API và Management API chạy bằng current_user='postgres'. Ghi thẳng đoạn này vào plan để không ai gỡ chốt mạnh nhất vì một suy luận từ rolsuper=false.
2. BẮT BUỘC thêm guard chống tái nhập vào app_private.ensure_org_boundary_v1(). Không có nó thì migration CHẾT NGAY lần CREATE TABLE đầu tiên với 'ERROR: 54001: stack depth limit exceeded' — đã tái hiện: ALTER TABLE … ENABLE ROW LEVEL SECURITY phát ra bên trong ddl_command_end lại kích hoạt chính hàm đó (context lặp hàng trăm khung qua pgrst_ddl_watch). Khuôn đã chứng minh chạy: IF coalesce(current_setting('app.org_boundary_guard', true),'') = 'on' THEN RETURN; END IF; PERFORM set_config('app.org_boundary_guard','on', true); … EXECUTE ALTER TABLE … ENABLE RLS; EXECUTE CREATE POLICY … ; PERFORM set_config('app.org_boundary_guard','off', true).
3. TÁCH MẪU DÒ KHỎI THÂN POLICY. GENERATOR khớp cột CHÍNH XÁC 'organization_id' vì thân policy tham chiếu thẳng cột đó; GATE khớp MẪU '%organization_id' để không bỏ sót. Bảng chỉ có source_organization_id/target_organization_id (income_expense_type_reference_repair_audit) phải rơi vào nhánh 'chưa phân loại → ĐỎ', TUYỆT ĐỐI không được sinh policy — đã tái hiện 'ERROR: 42703: column organization_id does not exist' đúng lúc CREATE POLICY. v1 gộp hai vai làm một ở mục dò-theo-mẫu nên tự đặt mìn.
4. SỬA MỆNH ĐỀ WHERE của vòng DO theo template ĐÃ CÓ SẴN trong repo — supabase/migrations/20260729142000_network_center_hide_sandbox_policies.sql:119-126: relkind IN ('r','p') AND NOT relispartition AND relrowsecurity AND EXISTS(pg_attribute attname='organization_id' AND attnum>0 AND NOT attisdropped) AND NOT EXISTS(pg_policy polname = relname||'_org_boundary') AND NOT EXISTS(app_private.org_boundary_exemptions). Lý do đo được: relkind='r' vừa BỎ SÓT 2 partitioned parent (network_device_samples, network_interface_samples — cả hai có organization_id, relrowsecurity=true, chỉ mang policy *_hide_sandbox_admin, KHÔNG có *_org_boundary) vừa TRÚNG NHẦM 86 phân mảnh con (+2 mỗi ngày) → 86 policy rác và CI đỏ hằng ngày. Câu SQL của v1 trả 388 bảng trong khi con số 304 mà chính v1 khai chỉ tái lập được bằng IN ('r','p') AND NOT relispartition.
5. Chốt tự vệ đặt NGAY TRƯỚC vòng DO: IF (SELECT count(*) FROM app_private.org_boundary_exemptions) = 0 THEN RAISE EXCEPTION 'sổ miễn trừ rỗng — từ chối chạy generator'; END IF. Sổ đã được tạo và seed từ GĐ1 nên đây là lưới vét, không phải điều kiện — nhưng phải có, vì nó là phiên bản generator của 'sàn chống rỗng-vô-nghĩa' mà v1 chỉ áp cho gate.
6. GIỮ NGUYÊN bốn điều kiện đỏ (a)(b)(c)(d) của gate scripts/check-org-boundary-coverage.mjs trong v1 — chúng đúng, đặc biệt (c) kiểm replacement_policy TỒN TẠI THẬT thay vì tin lời khai, và (d) chặn đổi sang PERMISSIVE / TO public / cmd≠'*'.
7. THÊM bốn điều kiện đỏ mới: (e) bảng trong tập đúng có cột %organization_id mà relrowsecurity=false → ĐỎ, không cho miễn trừ im lặng; (f) BẤT KỲ relation nào trong public, kể cả phân mảnh, có ≥1 dòng pg_policy nhưng relrowsecurity=false → ĐỎ (đã đo: policy còn nguyên mà RLS tắt thì role authenticated đọc thấy TOÀN BỘ dòng của mọi org); (g) mọi relation relispartition=true trong public phải relrowsecurity=true VÀ không có GRANT cho anon/authenticated/service_role — vì đã đo được policy của parent KHÔNG áp khi gọi thẳng vào phân mảnh con, và CREATE TABLE … PARTITION OF KHÔNG kế thừa relrowsecurity; an toàn của 86 phân mảnh hiện CHỈ dựa vào ENABLE RLS + REVOKE trong app_private.network_center_ensure_raw_partitions_v1 (20260729020000:510-511, 520-521) và chưa gate nào canh; (h) so visible_own trước/sau mỗi lần generator chạy, ĐỎ khi bất kỳ ô nào GIẢM ở bảng ngoài sổ miễn trừ.
8. SỬA SÀN CHỐNG RỖNG: ngưỡng ≥250 phải đếm trên TẬP ĐÚNG (relkind IN ('r','p') AND NOT relispartition — hôm nay 304 với khớp chính xác, 305 với mẫu LIKE), không đếm trên tập 388 của câu SQL cũ; nếu không, sàn vẫn xanh ngay cả khi bộ đọc chỉ trả về phân mảnh.
9. GIỮ NGUYÊN nguyên tắc event trigger CHỈ gắn policy, tuyệt đối không đụng dữ liệu, bỏ qua bảng tạm và phân mảnh con, và ghi một dòng vào app_private.org_boundary_audit để hành vi nhìn thấy được thay vì là ma thuật.
10. TẦNG CHẶN TRÊN PR (khuyến nghị mức thấp, không bắt buộc): thêm bước gate:org-boundary-static vào job quality-gates của ci-gates.yml — không cần secret nên chạy được trên PR — đọc TĨNH thư mục supabase/migrations, đỏ khi có CREATE TABLE … organization_id mà không có dòng miễn trừ tương ứng. Ghi rõ vì sao KHÔNG dựa vào job security-gates (ci-gates.yml:534): job đó chỉ chạy trên push/workflow_dispatch nhánh main và đọc catalog prod, mà supabase-migrate.yml cố ý KHÔNG auto-apply (gate:no-auto-apply cưỡng chế), nên lúc gate chạy thì migration còn CHƯA được apply tay — càng cho thấy event trigger mới là tầng cưỡng chế thật, gate chỉ là lưới vét.
11. GIỮ NGUYÊN việc nối gate:org-boundary vào ci-gates.yml không continue-on-error; nếu buộc phải tạm cho qua thì đăng ký một dòng trong tooling/known-gaps.yaml kèm ngày hết hạn.

**File chính:** `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/ (mới: <ts>_org_boundary_catalog_generator.sql)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/20260729142000_network_center_hide_sandbox_policies.sql (CHỈ ĐỌC — template mệnh đề WHERE đúng, dòng 119-126)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/check-org-boundary-coverage.mjs (mới)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/__tests__/org-boundary-gate.test.mjs (mới)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/tooling/known-gaps.yaml`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/.github/workflows/ci-gates.yml`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/package.json`

**Xong khi:** (1) Bài đo event trigger chạy TRÊN PROD trong BEGIN…ROLLBACK, KHÔNG đo ở local — local Supabase chạy postgres LÀ superuser nên bài đo local xanh không chứng minh được gì về quyền trên prod. Bốn ca bắt buộc: (a) CREATE TABLE có organization_id → pg_policy có <bảng>_org_boundary với polpermissive=false và polcmd='*'; (b) CREATE rồi ALTER TABLE ADD COLUMN organization_id → cũng có; (c) bảng không có cột org → relrowsecurity=false và 0 policy, không bị đụng; (d) CREATE TABLE … PARTITION BY → parent nhận boundary, phân mảnh con KHÔNG bị sinh policy rác. (2) Cả bốn ca chạy hết mà KHÔNG có lỗi 54001 (chứng minh guard chống tái nhập sống) và KHÔNG có lỗi 42703 (chứng minh mẫu-dò đã tách khỏi thân-policy). (3) Bảng thử không khai miễn trừ → gate đỏ; khai có reason+decided_by+expires_at → xanh; đặt expires_at quá khứ → đỏ lại. Cả ba chiều có test trong scripts/__tests__/org-boundary-gate.test.mjs. (4) Đổi một boundary sang PERMISSIVE, hoặc TO public, hoặc cmd≠'*' → gate đỏ (ba test riêng). (5) Bật (e)(f)(g): hôm nay cả ba đếm = 0 trên prod nên gate xanh khi bật; đặt giả một relation có policy mà relrowsecurity=false → đỏ. (6) Trên prod: số bảng có organization_id thiếu boundary và không có dòng miễn trừ = 0; số dòng miễn trừ thiếu expires_at = 0. (7) gate:migration-idempotent xanh với migration generator (chạy hai lần cho kết quả giống nhau). (8) Sàn chống rỗng đếm trên tập relkind IN ('r','p') AND NOT relispartition và fail khi dưới 250.

### GĐ6 — Đóng nhánh organization_id IS NULL

**Mục tiêu.** Làm cho dòng không nhãn bị TỪ CHỐI thay vì được phát cho tất cả. Công thức biên giới hiện hành mở đầu bằng `organization_id IS NULL OR …` — một cửa mà hàng nghìn dòng trên 21 bảng đang đi qua. Mục tiêu phát biểu bằng RÀNG BUỘC (NOT NULL tồn tại) chứ không bằng số đếm, vì số đếm hết hạn trước khi migration kịp chạy.

**Bị chặn bởi:** GĐ5

**Việc cần làm**

1. VIỆC 1, PHẢI XONG TRƯỚC MỌI LỆNH SET NOT NULL: vá đường GHI của Copilot. Mở rộng trg_autofill_org sang ai_chat_threads và ai_chat_messages — đi đường DB để KHÔNG phụ thuộc OrganizationContext của GĐ9. Đo được: hai bảng này không có DEFAULT, không có trigger autofill, và src/copilot/chatEngine.ts (createThread/saveMessages) không set organization_id; bỏ nhánh NULL rồi SET NOT NULL mà chưa vá là GIẾT đường ghi của Copilot. Đây là lỗ mà cả review lẫn plan v1 đều chưa ghi. Vá src/copilot/chatEngine.ts là việc bổ sung, không thay thế.
2. GIỮ NGUYÊN toàn bộ đường truy chủ từng bảng của v1 khi backfill: public_room_events qua owner_id (lưu ý 3018/3022 dòng không có building_id/room_id nên owner_id là đường DUY NHẤT), invoice_audit_log qua invoice, inspection_photos, salary_award_errors, cron_runs, inspection_sessions, salary_attendance_day, cash_handover_items, building_fee_accounts, notifications, salary_streak_state, material_usage_items, material_usages, profit_manager_salary_buildings và các bảng ≤2 dòng.
3. GIỮ NGUYÊN quyết định tường minh cho invoice_audit_log: các dòng có hoá đơn cha ĐÃ XOÁ phải được xử lý có chủ ý (gán org của hoá đơn đã xoá từ bản lưu, hay chuyển sang bảng lưu trữ ngoài biên giới), không để trôi.
4. BỎ mọi con số tổng khỏi phát biểu mục tiêu: '4175 dòng NULL' đo lại ra 4176, 'public_room_events 3022' ra 3023, '11149' ra 11150 — lệch NGAY TRONG NGÀY plan được viết. Bảng này sinh ~53 dòng/ngày và 24 dòng NULL trong 24h gần nhất. Phát biểu đúng: 'backfill MỌI dòng organization_id IS NULL rồi ALTER COLUMN SET NOT NULL', và bằng chứng đạt là SỰ TỒN TẠI của ràng buộc NOT NULL, không phải một con số đếm.
5. GIỮ NGUYÊN việc chặn nguồn sinh NULL mới: (a) mở rộng trg_autofill_org theo cùng cơ chế catalog của GĐ5 — hiện chỉ gắn trên 5 bảng (customers, contracts, invoices, rooms, income_expenses) trong khi 25/32 bảng có boundary vẫn để organization_id nullable; (b) vá cả 3 hàm upsert trong src/hooks/useSettings.ts vốn không set organization_id nên MỌI dòng settings mới đều NULL.
6. GIỮ NGUYÊN thứ tự bắt buộc từng bảng một: backfill → SET NOT NULL → mới bỏ nhánh `organization_id IS NULL OR` khỏi công thức, sửa trong hàm sinh ở GĐ5 để mọi bảng đổi một lượt, và GIỮ nhánh NULL cho đúng các bảng có dòng miễn trừ (ai_providers/ai_copilot_settings — giá trị đúng về ngữ nghĩa của chúng CHÍNH LÀ NULL).
7. GIỮ NGUYÊN ratchet trung gian bật ngay từ đầu giai đoạn: gate đếm dòng NULL theo bảng và ĐỎ khi TĂNG. Có giá trị kể cả khi chưa bỏ được nhánh, vì nó chặn việc đào thêm hố trong lúc đang lấp. Đây là ratchet theo chiều tăng nên tất định, không dính vào việc dữ liệu nghiệp vụ trôi.
8. BỎ counterfactual chốt bằng số ('1216→1005', '3022→0', '19→0', '15→0') khỏi tiêu chí xong; thay bằng visible_own sau backfill = ground_truth_own đo cùng lần chạy.

**File chính:** `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/ (mới: <ts>_ai_chat_autofill_org.sql, <ts>_org_null_backfill.sql, <ts>_org_boundary_drop_null_branch.sql)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/copilot/chatEngine.ts`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/hooks/useSettings.ts`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/check-org-boundary-coverage.mjs`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/docs/generated/org-leak-baseline.json`

**Xong khi:** (1) Với MỌI bảng có cột organization_id và KHÔNG có dòng miễn trừ còn hạn: pg_attribute.attnotnull = true — vị từ tất định, đọc thẳng catalog, không đếm dòng. (2) SELECT count(*) = 0 cho: policy boundary còn chứa chuỗi 'organization_id IS NULL' trong pg_get_expr(polqual) ở bảng ngoài sổ miễn trừ. (3) TẦNG 1: INSERT vào ai_chat_threads và ai_chat_messages mà KHÔNG set organization_id → dòng sinh ra có organization_id khác NULL (chứng minh trigger autofill sống); INSERT vào settings qua đường của useSettings.ts → cũng khác NULL. (4) visible_own = ground_truth_own đo cùng lần chạy trên mọi bảng vừa backfill — chứng minh backfill không siết nhầm. (5) Ratchet NULL: gieo một dòng NULL giả ở TẦNG 1 → gate PHẢI đỏ. (6) Số bảng có boundary mà cột organization_id còn nullable = 0 ngoài miễn trừ.

### GĐ7 — Bảng và view KHÔNG có cột organization_id (vùng mù của mọi gate dò theo tên cột)

**Mục tiêu.** Đóng vùng mà cơ chế catalog của GĐ5 về bản chất không nhìn thấy. Không xử lý riêng thì các bảng này vĩnh viễn nằm ngoài generator, ngoài event trigger và ngoài gate — đúng cách room_price_history và lucky_event_teams đang tồn tại hôm nay. Toàn bộ lập luận của v1 ở giai đoạn này đúng và được giữ; chỉ bổ sung ba chỗ.

**Bị chặn bởi:** GĐ5 (chạy song song được với GĐ6 và GĐ8)

**Việc cần làm**

1. GIỮ NGUYÊN quyết định kiến trúc hai hướng và toàn bộ lập luận về giá phải trả: HƯỚNG 1 (thêm cột, backfill từ cha, NOT NULL) đưa bảng vào cơ chế chung nhưng sinh một cột dư có thể LỆCH với cha — và lệch nhãn là thứ đã lừa được chính đợt rà này hai lần (ai_providers bị backfill hằng số 'aaaa' trên một bảng vốn global; profiles chỉ mang được một org); nên bắt buộc kèm trigger giữ đồng bộ hoặc CHECK, và migration phải ghi rõ cột này là BẢN SAO chứ không phải nguồn sự thật. HƯỚNG 2 (RESTRICTIVE riêng đi qua cha) không nói dối về quyền sở hữu nhưng phải viết tay từng bảng.
2. GIỮ NGUYÊN quy tắc chọn: HƯỚNG 1 khi cha ỔN ĐỊNH và không bao giờ đổi (room_price_history ← buildings, lucky_event_teams ← lucky_events); HƯỚNG 2 khi cha có thể đổi hoặc quan hệ nhiều-nhiều. Bảng đi HƯỚNG 2 BẮT BUỘC có dòng trong app_private.org_boundary_exemptions với replacement_policy ghi tên policy thay thế — và gate ở GĐ5 kiểm policy đó TỒN TẠI THẬT, không chỉ đọc lời khai.
3. GIỮ NGUYÊN room_price_history (thêm organization_id backfill từ buildings.organization_id + NOT NULL + room_price_history_org_boundary) và lucky_event_teams (thêm organization_id backfill từ lucky_events, vá cả bảng cha lucky_events, cân nhắc tách cột payout_account/payout_bank/payout_holder/proof_path ra bảng riêng — bảng này hiện an toàn CHỈ vì RLS bật mà có 0 policy).
4. income_expense_type_reference_repair_audit — nâng mức ưu tiên: đây chính là ca đã TÁI HIỆN lỗi 42703 khi thử generator ở GĐ5 (bảng chỉ có source_organization_id, không có organization_id, nên CREATE POLICY tham chiếu cột không tồn tại thì vỡ ngay). Bổ sung cột chuẩn organization_id hoặc khai miễn trừ có lý do; TUYỆT ĐỐI không để generator chạm tới nó khi chưa quyết.
5. CHUYỂN VỀ ĐÂY (v1 đặt nhầm nhóm): permission_definitions, legacy_owner_allowlist, authorization_migration_exceptions — đo được cả ba KHÔNG có cột organization_id nên generator không với tới; chúng thuộc nhóm 12 bảng của giai đoạn này chứ không phải nhóm 'bảng dùng chung cố ý' cùng với ai_providers. Khai miễn trừ có lý do tại đây.
6. GIỮ NGUYÊN xử lý 6 view (accounts_with_balance, building_coverage, contract_extension_history, meter_readings_detailed, meters_with_latest_reading, v_termination_calculation): bổ sung cột organization_id kéo sẵn từ bảng nền để biên giới KIỂM ĐƯỢC TRỰC TIẾP trên view. Giữ cả ghi chú rằng cả 12 view đã có security_invoker=true và đo thật không rò dòng nào — đây là việc hạ tầng đo, không phải vá lỗ. Giữ việc khai tử accounts_with_balance v1 khi frontend đã chuyển hết sang accounts_with_balance_v2.

**File chính:** `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/ (mới: <ts>_indirect_org_tables.sql, <ts>_org_views_add_org_column.sql)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/20260728180000_room_price_history.sql (CHỈ ĐỌC — legacy-frozen, tham chiếu bối cảnh)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/20260731070000_lucky_draw_events.sql (CHỈ ĐỌC — legacy-frozen, tham chiếu bối cảnh)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/check-view-invoker.mjs`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/check-org-boundary-coverage.mjs`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/docs/generated/org-boundary-inventory.json`

**Xong khi:** (1) 12 bảng không có cột organization_id đều ở ĐÚNG MỘT trong ba trạng thái ĐỌC ĐƯỢC TỪ CATALOG: đã thêm cột (pg_attribute có attname='organization_id' và attnotnull=true) / có replacement_policy TỒN TẠI THẬT trong pg_policy / có dòng miễn trừ chưa quá hạn. Inventory liệt kê đủ 12 và 0 bảng ở trạng thái 'chưa phân loại'. (2) 6 view có cột organization_id VÀ có test biên giới đo THẲNG trên view ở TẦNG 1 bằng uA/uB/uAB → visible_foreign = 0 (không chốt theo số dòng prod). (3) gate:view-invoker vẫn 12/12 security_invoker=true. (4) Thêm một bảng thử KHÔNG có cột org ở TẦNG 1 → gate BUỘC phân loại (đỏ), không cho lọt im lặng. (5) income_expense_type_reference_repair_audit: hoặc có cột organization_id, hoặc có dòng miễn trừ — và chạy generator trên nó KHÔNG sinh lỗi 42703.

### GĐ8 — Tầng hàm/RPC và storage: đảo deny-list thành allow-list

**Mục tiêu.** Vá lớp mà RLS bảng không với tới. Hàm SECURITY DEFINER chạy bằng quyền chủ hàm nên bỏ qua RLS hoàn toàn — 647/1067 hàm public là SECURITY DEFINER, 443 hàm role authenticated gọi được qua /rest/v1/rpc, 73 hàm đụng dữ liệu khách mà không có mỏ neo tổ chức. Storage hỏng đúng một kiểu với tầng bảng: danh sách 7 bucket viết tay. Toàn bộ 11 việc của v1 ở giai đoạn này được giữ; bổ sung một ràng buộc liên kết với GĐ-R.

**Bị chặn bởi:** GĐ5 (chạy song song được với GĐ6 và GĐ7)

**Việc cần làm**

1. GIỮ NGUYÊN storage fail-closed: app_private.can_read_storage_object_v1 và can_write_storage_object_v1 mở đầu bằng `p_bucket not in (…7 tên…) or …` nghĩa là bucket ngoài danh sách khiến hàm trả TRUE ngay và cả 4 policy RESTRICTIVE storage_pii_org_isolation* thành no-op. Đảo: MẶC ĐỊNH mọi bucket phải có dòng app_private.storage_object_links khớp org; miễn trừ khai trong bảng cấu hình app_private.public_buckets, không phải hằng số trong thân hàm.
2. GIỮ NGUYÊN thứ tự backfill-trước-siết-sau cho storage: 25 object bucket lucky-proofs hiện có 0 dòng storage_object_links; lấy organization_id từ lucky_events.organization_id qua foldername[1]; 3 object mồ côi ở folder không còn lucky_events tương ứng phải quyết định tường minh. Siết trước khi backfill = nhân viên mất quyền xem file hợp lệ, và triệu chứng là ảnh trống chứ không phải lỗi.
3. GIỮ NGUYÊN việc sửa policy 'lucky proofs read by staff' (điều kiện hiện là lucky_admin_org_v1() IS NOT NULL — chỉ cần là OWNER/STAFF của BẤT KỲ org nào là đọc file của MỌI org) và xử lý bucket ui-references (policy cho SELECT với điều kiện duy nhất bucket_id, đường dẫn không có mã tổ chức).
4. GIỮ NGUYÊN pay_draft_fee_voucher(uuid,uuid,jsonb) — lỗi thứ tự kiểm tra: hàm RAISE các thông báo tiết lộ ('Không tìm thấy phiếu' / 'Phiếu đã bị hủy' / 'Phiếu không ở trạng thái nháp') TRƯỚC mọi kiểm tra tổ chức, và giữa hai mốc còn chạy UPDATE income_expenses không lọc org, hiện chỉ thoát nạn nhờ approve_voucher() phía sau rollback. Chèn gate org NGAY sau SELECT phiếu, dùng MỘT thông báo trung tính cho cả ba trường hợp.
5. GIỮ NGUYÊN salary_work_ledger(date,uuid) — trộn cấu hình xuyên tổ chức: dòng v_owner := (SELECT sa.user_id FROM super_admins sa ORDER BY sa.created_at LIMIT 1) lấy super admin ĐẦU TIÊN toàn hệ thống bất kể người gọi thuộc org nào. Suy owner theo org của người gọi; bổ sung organization_id cho salary_bonus_rules và salary_holidays.
6. GIỮ NGUYÊN việc ĐO RỒI VÁ 6 hàm pra_* (pra_summary, pra_timeseries, pra_top_rooms, pra_funnel, pra_by_token, pra_errors) — phải chạy công thức đo thật, đọc định nghĩa hàm KHÔNG đủ; nếu không lọc thì sửa HÀM, không thêm tham số org do client truyền (tham số client truyền là tham số giả mạo được).
7. GIỮ NGUYÊN network_center_get_building_v1(uuid) là VÙNG MÙ cần một tài khoản CÓ năng lực Network Center để đo, reserve_ai_usage/finalize_ai_usage cần p_organization_id tường minh đối chiếu membership, và bulk_soft_delete_invoices_v1(uuid[]) phải RAISE thay vì trả số đếm (chênh lệch số đếm là oracle).
8. GIỮ NGUYÊN gate: mở rộng scripts/check-rpc-surface.mjs — hàm SECURITY DEFINER đụng bảng có organization_id mà không tham chiếu my_org_ids / can_access_building / authorize_tenant_action_v3 phải khai trong danh sách miễn trừ có lý do.
9. RÀNG BUỘC MỚI liên kết với GĐ-R: nếu GĐ-R chọn Thiết kế B (edge function), thì việc REVOKE EXECUTE get_public_latest_invoice_by_code(text) khỏi anon + gỡ nó khỏi allow-list scripts/definer-acl-baseline.json phải làm TẠI ĐÂY, cùng lúc với việc viết lại mục allow-list của GĐ0 và cập nhật contracts/surfaces/edge-function-surface.json. Nếu không, đường PostgREST mà client đang dùng hôm nay vẫn mở và limiter bị đi vòng trong một dòng curl.

**File chính:** `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/ (mới: <ts>_storage_fail_closed.sql, <ts>_rpc_org_gates.sql, <ts>_salary_config_org_scope.sql)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/hooks/usePublicRoomsAnalytics.ts`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/check-rpc-surface.mjs`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/check-edge-surface.mjs`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/definer-acl-baseline.json`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/functions/llm-proxy/index.ts`

**Xong khi:** (1) 73 hàm 'không mỏ neo tổ chức' → mỗi hàm ở ĐÚNG MỘT trong ba trạng thái ĐỌC ĐƯỢC TỪ CATALOG: prosrc có tham chiếu mỏ neo / has_function_privilege('anon'|'authenticated', oid, 'EXECUTE') = false / có dòng miễn trừ chưa quá hạn. Gate in bảng ba cột, số hàm 'chưa phân loại' = 0. (2) HTTP thật: demo.chunha đăng nhập bằng GoTrue rồi list bucket lucky-proofs → số file thuộc org KHÁC = 0 (vị từ =0, không chốt 'thấy đúng N file'). (3) anon INSERT vào storage.objects bucket lucky-proofs → 42501. (4) Tạo một bucket mới ở TẦNG 1 mà không khai trong app_private.public_buckets → đọc trả 0 dòng (fail-closed) VÀ gate đỏ. (5) Test khẳng định pay_draft_fee_voucher trả CÙNG MỘT chuỗi thông báo cho cả ba trường hợp 'không tồn tại' / 'đã huỷ' / 'đã duyệt' khi voucher thuộc org khác — so chuỗi bằng nhau, không so số. (6) TẦNG 1: sửa salary_bonus_rules của org A KHÔNG làm đổi kết quả salary_work_ledger của org B. (7) 6 hàm pra_* có kết quả đo bằng persona thật ghi lại kèm capturedAt, và visible_foreign qua chúng = 0. (8) gate:rpc-surface và gate:edge-surface xanh, mỗi gate có test mutation hai chiều.

### GĐ9 — Frontend: dựng khái niệm 'tổ chức hiện tại' và lớp chắn thứ hai

**Mục tiêu.** Hiện app KHÔNG biết mình đang ở tổ chức nào: 0 OrganizationContext, my_org_ids() gọi ở đúng 2 hook, 198 file gọi .from( nhưng chỉ 4 chỗ .eq('organization_id', …). Giai đoạn này KHÔNG phải bản vá bảo mật — bản vá thật nằm ở GĐ3–GĐ6 — mà là lớp thứ hai, cộng với việc xoá các chỗ client tự suy tổ chức bằng chuỗi ký tự. Toàn bộ 7 việc của v1 đúng và được giữ nguyên.

**Bị chặn bởi:** GĐ4 (tiêu chí 'số dòng màn hình khớp số DB' chỉ có nghĩa khi các bảng đang rò sống đã kín)

**Việc cần làm**

1. GIỮ NGUYÊN: dựng OrganizationContext ở src/app/providers/ và nâng fetchMyOrgIds (hiện chôn trong src/hooks/useIncomeExpenseTypes.ts:79-86) thành src/hooks/useMyOrgIds.ts dùng chung.
2. GIỮ NGUYÊN việc vá src/hooks/useSettings.ts — đọc và ghi lệch khoá nhau: useSetting/useIndividualSetting/useGeneralSettings chỉ lọc theo `key` trong khi chính file đó lúc ghi upsert với onConflict 'user_id,key'. Thêm .eq('user_id', user.id) + lọc org. Riêng useGeneralSettings chạy vòng gộp result[row.key]=row.value nên dòng công ty khác đến sau GHI ĐÈ giá trị công ty mình, âm thầm, không lỗi — đổi thành không-ghi-đè và log cảnh báo khi thấy >1 dòng cùng key.
3. GIỮ NGUYÊN việc lọc org ở 5 hook module kho (useMaterials, useMaterialPurchases, useMaterialUsages, useMaterialAdjustments, useMaterialCategories) + useJobTypes + useJobGroups + useDocumentTemplates. useDocumentTemplates đang gọi getSessionUser() rồi VỨT ĐI — biến user chỉ dùng để throw khi chưa đăng nhập, không vào mệnh đề lọc nào.
4. GIỮ NGUYÊN việc chuyển useStaffUsers.ts và useAssignablePeople.ts sang RPC list_organization_members_v1 (đã có sẵn) và XOÁ đường đọc thẳng bảng profiles ở FE; sửa hai khối chú thích đang khẳng định 'RLS của profiles tự lọc' — chúng đang dạy người đọc sau tin vào một bảo đảm không tồn tại.
5. GIỮ NGUYÊN việc XOÁ HẲN các heuristic chuỗi: useAccounts.ts (email.startsWith('demo.'), .not('code','ilike','DEMO%')), ContractsPage.tsx (so profile.full_name với tên khu vực, hard-code tên riêng nhân viên — dùng profiles.default_area_id đã có ở useMyContext.ts:19-20), useCommissionVoucher.ts, useRoomIdsByCode.ts và useContracts.ts buildSearchFilter, RecordPaymentDialog .ilike('name','chung').limit(1) không ORDER BY.
6. GIỮ NGUYÊN việc thêm filter 'organization_id=eq.<org>' cho 13 kênh postgres_changes trong src/hooks/useRealtimeDataSync.ts, theo khuôn đã làm đúng ở src/hooks/useOpenClawRealtime.ts:82. Giữ cả ghi chú rằng phần giảm nhẹ hiện có là ĐÚNG và phải giữ: payload bị bỏ hoàn toàn, event chỉ dùng làm tín hiệu invalidate — nên thứ rò hiện tại là NHỊP HOẠT ĐỘNG chứ không phải nội dung.
7. GIỮ NGUYÊN gate FE scripts/check-org-scoped-queries.mjs: file trong src/hooks gọi .from(<bảng có organization_id>) mà không lọc org phải khai miễn trừ; danh sách bảng org đọc từ docs/generated/database-inventory.json (nay bổ sung đối chiếu với docs/generated/org-boundary-inventory.json), không khai lại bằng tay.

**File chính:** `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/app/providers/AppProviders.tsx`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/hooks/useMyOrgIds.ts (mới)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/hooks/useSettings.ts`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/hooks/useRealtimeDataSync.ts`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/hooks/useStaffUsers.ts`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/hooks/useAssignablePeople.ts`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/hooks/useDocumentTemplates.ts`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/hooks/useAccounts.ts`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/check-org-scoped-queries.mjs (mới)`

**Xong khi:** (1) E2E headless (cd .e2e-fleet && FLEET_WORKERS=8 npx playwright test) bằng 3 tài khoản DEMO mở /materials, /tasks, /settings/templates, /settings/general, /settings/categories/task-types và khẳng định SỐ DÒNG TRÊN MÀN HÌNH khớp số của org mình ĐO ĐỘC LẬP TỪ DB TRONG CÙNG LẦN CHẠY — không so với hằng số, không chỉ 'trang render được'. (2) Gọi PostgREST bằng JWT thật của demo.chunha với key=onboarding_completed → không còn 406 PGRST116. (3) grep: 0 hook trong danh sách còn đọc bảng org mà không lọc; 0 chỗ còn email.startsWith('demo.') hay ilike 'DEMO%'; 0 tên riêng nhân viên hard-code trong ContractsPage.tsx. (4) useRealtimeDataSync: 13/13 kênh có trường filter (đếm cơ học trên AST, tất định). (5) gate:org-scoped-queries có test hai chiều: thêm một hook không lọc → đỏ; khai miễn trừ hợp lệ → xanh.

### GĐ10 — Sửa nhãn mô hình sai, đáo hạn miễn trừ, và chốt vị thế Test/Demo

**Mục tiêu.** Dọn những chỗ cột organization_id đang NÓI DỐI về quyền sở hữu — vì chính chúng đã lừa được đợt rà này, và vì cơ chế tự động ở GĐ5 sẽ dập policy vào đó và giết tính năng nếu không có sổ miễn trừ. Đây cũng là nơi các dòng miễn trừ seed từ GĐ1 ĐÁO HẠN. Đồng thời trả lời dứt điểm câu hỏi Test/Demo có nên nằm chung database với tiền thật không.

**Bị chặn bởi:** GĐ5 (cần generator + gate sống để việc gỡ miễn trừ có nghĩa) và GĐ4

**Việc cần làm**

1. GIỮ NGUYÊN toàn bộ phân tích ai_providers và ai_copilot_settings: ai_providers_pkey = PRIMARY KEY(provider) và ai_copilot_settings_pkey = PRIMARY KEY(id) trên cột boolean kèm CHECK, nên hai bảng CHỈ chứa được một bản duy nhất toàn hệ thống. Cột organization_id='aaaa' là vết backfill hằng số. Việc đúng: đặt organization_id = NULL (khai nhận là dùng chung) hoặc bỏ cột, cộng dòng miễn trừ có lý do. Nếu THẬT SỰ muốn provider theo tổ chức thì đổi PK thành (organization_id, provider) — đó là đổi mô hình, không phải dán policy.
2. SỬA CHẨN ĐOÁN của profiles/roles/settings — đây là chỗ v1 (và cả review) chẩn sai. Nguyên nhân khoá nhầm KHÔNG phải 'người thuộc hai tổ chức': toàn prod chỉ có ĐÚNG MỘT người hai org (90450d5f) và người đó là super admin nên công thức boundary có nhánh is_super_admin() tha anh ta — anh ta không mất gì. Thứ thật sự khoá nhầm là NHÃN LỆCH: 7/15 dòng profiles mang organization_id KHÔNG nằm trong membership ACTIVE của chủ nó, 0/7 là super admin; demo.chunha mất chính dòng profile CỦA MÌNH (own 1→0). Viết lại mục này và Rủi ro #2 theo đúng số đo.
3. THAY BÀI TEST CHỐT: v1 đòi 'user hai org (90450d5f) vẫn đăng nhập + phân quyền được ở CẢ hai org' — test này XANH GIẢ vì is_super_admin() cứu anh ta. Test đúng: 'mọi user có membership ACTIVE đọc được dòng profile của CHÍNH MÌNH sau khi siết', tức own_profile ≥ 1 cho 100% user ACTIVE. Viết test theo chẩn đoán sai sẽ đo nhầm thứ.
4. GIỮ NGUYÊN việc nới organizations trước rồi mới siết: cả nathan lẫn demo.chunha hiện đọc 0/3 dòng, kể cả dòng tổ chức của CHÍNH họ, nên đây là siết QUÁ TAY chứ không quá lỏng. NỚI trước (policy SELECT cho id IN (SELECT unnest(my_org_ids()))) rồi mới thêm organizations_org_boundary dựa trên cột id thay vì organization_id. Kiểm frontend đang lấy tên tổ chức từ đâu trước khi sửa.
5. VIỆC MỚI — ĐÁO HẠN MIỄN TRỪ: sau khi sửa xong nhãn, GỠ các dòng miễn trừ của profiles, roles, settings khỏi app_private.org_boundary_exemptions và để generator của GĐ5 phủ chúng. Đây chính là chỗ expires_at seed ở GĐ1 đến hạn; nếu không gỡ thì gate quá-hạn sẽ đỏ, đúng như thiết kế — 'hoãn' không được phép âm thầm thành 'vĩnh viễn'.
6. GIỮ NGUYÊN chốt vị trí Test/Demo: DEMO (dddd) NÊN GIỮ CHUNG (dữ liệu bịa, seed tay, không PII thật, và giữ chung là thứ khiến bộ đo ở GĐ2 đo được rò thật thay vì đo trên môi trường giả); TEST (cccc) NÊN TÁCH vì là bản sao 1:1 dữ liệu công ty thật, tức NHÂN ĐÔI bề mặt lộ PII mà không nhân đôi giá trị, và mọi rò từ TEST biểu hiện đúng kiểu khó nhận ra nhất — SỐ LIỆU NHÂN ĐÔI, không phải dòng lạ. Giữ nguyên phần nói thẳng chi phí tách (3 lần chạy migration, edge secrets ×3, auth ×3, mất khả năng dùng TEST làm bài đo hồi quy).
7. GIỮ NGUYÊN ba việc thay thế nếu chưa tách TEST: (a) KIỂM scripts/clone-org/mask.mjs có thật sự mask họ tên/SĐT/số tài khoản khi clone không; (b) THỐNG NHẤT MỘT khái niệm sandbox — hiện tồn tại HAI cơ chế song song, sandbox_org_ids() chỉ chứa cccc và demo_user_ids() dùng cho dddd; (c) đặt hạn dùng và quy trình huỷ cho org TEST.

**File chính:** `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/ (mới: <ts>_ai_global_tables_null_org.sql, <ts>_profiles_org_label_fix.sql, <ts>_organizations_self_read.sql, <ts>_org_boundary_exemptions_expire.sql)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/migrations/20260713120000_sprint3a_org_rollout_all_tables.sql (CHỈ ĐỌC — legacy-frozen, nguồn của vết backfill hằng số)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/clone-org/mask.mjs`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/clone-org/lib.mjs`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/docs/engineering/DATA_ENVIRONMENTS.md`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/copilot/admin/AiCopilotAdminPage.tsx`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/tooling/known-gaps.yaml`

**Xong khi:** (1) SELECT count(*) FROM ai_providers WHERE organization_id IS NOT NULL = 0 và ai_copilot_settings tương tự; ĐỒNG THỜI ở TẦNG 1, uA và uB đều đọc được ĐỦ số provider đã gieo cho fixture (chứng minh không hồi quy Copilot bằng số tất định, không bằng 'vẫn thấy 10 provider'). (2) Cả hai bảng có dòng trong app_private.org_boundary_exemptions với reason ghi rõ 'bảng global, PK không chứa organization_id'. (3) VỊ TỪ =0: count(*) dòng profiles có organization_id KHÔNG nằm trong membership ACTIVE của chủ nó = 0. (4) 100% user có membership ACTIVE đọc được ≥1 dòng profile của CHÍNH MÌNH dưới RLS — tỉ lệ, không phải số đếm. (5) Mỗi persona đọc được ĐÚNG tập organizations bằng my_org_ids() của mình (so tập bằng nhau, không so số cứng). (6) count(*) FROM app_private.org_boundary_exemptions WHERE table_name IN ('profiles','roles','settings') = 0 — miễn trừ đã đáo hạn và bị gỡ, generator đã phủ. (7) count(*) dòng miễn trừ quá hạn = 0 trên toàn sổ. (8) DATA_ENVIRONMENTS.md ghi quyết định Test/Demo kèm lý do, ngày, last_verified_commit; nếu chọn 'chưa tách' thì có một dòng trong tooling/known-gaps.yaml với expires_at.

### GĐ-R — Rate-limit bề mặt công khai (TÁCH RIÊNG, không chặn giai đoạn nào)

**Mục tiêu.** Dựng tầng phòng thủ chiều sâu cho RPC công khai. Bị BÓC khỏi GĐ0 vì đo được là nó chưa có kiến trúc trong dự án này, và vì sau GĐ0 nó không còn là thứ bịt lỗ: mã 16 ký tự base-57 (≈5,6e27 tổ hợp) đã làm brute-force bất khả thi. Một giai đoạn rủi ro cao nhất không được phép bị giữ làm con tin bởi một việc chưa chọn được kiến trúc.

**Bị chặn bởi:** GĐ0 (cần mã ≥16 ký tự và bề mặt anon đã chốt trước khi bàn tới giới hạn tần suất); KHÔNG chặn giai đoạn nào khác

**Việc cần làm**

1. GHI VÀO PLAN HAI ĐIỀU LOẠI TRỪ, để lần sau không ai đề xuất lại: (a) rate-limit/WAF của Vercel KHÔNG áp được — src/pages/public/PublicContractInvoicePage.tsx:98 gọi `fetch` THUẦN tới ${VITE_SUPABASE_URL}/rest/v1/rpc/get_public_latest_invoice_by_code, mà .env đặt VITE_SUPABASE_URL="https://tryymsxyyckgbrmmvozx.supabase.co", nên trình duyệt đi THẲNG tới Supabase và Vercel không bao giờ nhìn thấy request; comment dòng 92-96 nói rõ chủ ý bỏ supabase-js để tránh navigator.locks; vercel.json cũng không có mục rate-limit/firewall nào. (b) Cloudflare chỉ đứng trước chillhome.io.vn (img/storage), không trước supabase.co lẫn ptcrm.vercel.app.
2. CHỌN MỘT trong hai thiết kế và ghi lý do loại cái kia. THIẾT KẾ A (thuần DB, không sửa client): bảng app_private.public_code_hits(ip inet, bucket timestamptz, n int), đọc current_setting('request.headers', true)::json->>'x-forwarded-for'; hàm get_public_latest_invoice_by_code có provolatile='v' nên ghi được trong thân. ĐIỀU KIỆN TIÊN QUYẾT phải chứng minh TRƯỚC khi chọn: GUC đó thực sự mang header trên chính project này (repo có 0 tiền lệ — grep 'request.headers|x-forwarded-for' trong supabase/migrations = 0 hit), và xác định hop nào do proxy của Supabase tự nối vào, vì phần đầu chuỗi XFF do client tự đặt. Không chứng minh được → LOẠI A, vì một limiter khoá theo giá trị client tự đặt là limiter giả.
3. THIẾT KẾ B (edge function): thêm supabase/functions/public-invoice/ với verify_jwt = false (khuôn có sẵn trong supabase/config.toml: openclaw-runtime-token, openclaw-runtime, openclaw-watchdog), rate-limit trên x-forwarded-for của Deno, rồi sửa URL ở PublicContractInvoicePage.tsx:98. BẮT BUỘC đi kèm và làm ở GĐ8: REVOKE EXECUTE get_public_latest_invoice_by_code(text) khỏi anon + GỠ khỏi allow-list scripts/definer-acl-baseline.json + cập nhật contracts/surfaces/edge-function-surface.json và scripts/check-edge-surface.mjs. Nếu không, đường PostgREST hôm nay vẫn mở và limiter bị đi vòng trong một dòng curl — mục 4 của GĐ0 (giữ hàm này trong allow-list anon) phải được viết lại cùng lúc.
4. GIỮ tiền lệ rate-limit đã có trong repo làm khuôn tham chiếu, nhưng ghi rõ nó khác loại: supabase/migrations/20260710200000_ai_copilot_backend.sql:259-264 rate-limit theo USER (RAISE EXCEPTION 'rate_limited'), và QR poll ở 20260727060000_openclaw_rpc_surface.sql:2895 — cả hai theo user, không theo IP, nên không dùng lại trực tiếp cho bề mặt anon.

**File chính:** `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/functions/ (mới nếu chọn B: public-invoice/index.ts)`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/supabase/config.toml`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/src/pages/public/PublicContractInvoicePage.tsx`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/definer-acl-baseline.json`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/scripts/check-edge-surface.mjs`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/contracts/surfaces/edge-function-surface.json`, `c:/Users/Nguyen Tam/whiteboard-ihomecrm-main/docs/plans/PLAN-TACH-DU-LIEU-DA-CONG-TY.md`

**Xong khi:** Giai đoạn kết thúc bằng MỘT QUYẾT ĐỊNH ĐƯỢC GHI, không bắt buộc bằng một bản triển khai. (1) Nếu chọn A: có bằng chứng CHẠY ĐƯỢC rằng current_setting('request.headers', true) mang x-forwarded-for trên chính project tryymsxyyckgbrmmvozx, VÀ có test chứng minh hop bị client giả mạo KHÔNG được dùng làm khoá. Không có hai bằng chứng đó → giai đoạn kết luận 'loại A' và không được thi hành. (2) Nếu chọn B: has_function_privilege('anon', 'public.get_public_latest_invoice_by_code(text)', 'EXECUTE') = false; hàm không còn trong definer-acl allow-list; gate:edge-surface xanh với entry mới; và test chứng minh curl thẳng /rest/v1/rpc/get_public_latest_invoice_by_code trả 404/PGRST202. (3) Dù chọn gì: một test hồi quy chứng minh trang /c/:code vẫn mở được bằng mã hợp lệ và bằng mã cũ trong cửa sổ ân hạn của GĐ0. (4) Quyết định + lý do loại phương án kia được ghi trong plan kèm ngày; nếu hoãn thì có dòng tooling/known-gaps.yaml với expires_at.

