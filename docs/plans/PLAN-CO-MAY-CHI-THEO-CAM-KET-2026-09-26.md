# PLAN — Cỗ máy chi theo cam kết · **bản v2 (sau audit)**

> **Trạng thái 26/09 đêm: G1–G5 ĐÃ ÁP PRODUCTION (chế độ CHẠY THỬ) · G6 cảnh báo · G7 dấu vết · G8 tài liệu.**
> Một bộ máy quyết định + sổ tiêu phủ mọi đường ghi + 5 cửa chi đã hỏi cổng; cờ `spend.engine.v1` = SHADOW
> nên **cách duyệt chưa đổi**. Việc còn lại là của CHỦ: xem ≥ 14 ngày chạy thử ở màn Cam kết chi rồi bật
> từng toà × hạng mục × tháng. Chi tiết, backup, bằng chứng ở **§12**. Reconcile-money v1+v2 PASS sau mỗi lần áp.
>
> **Nền mã:** `origin/main` = `origin/production` = `e1a0d2ac0312bba94148e974af2fb132303865a6`.
> **Nền số:** production `tryymsxyyckgbrmmvozx`, org THẬT `aaaa0000-0000-4000-8000-000000000001`,
> đọc chỉ-đọc qua session pooler. Mốc: **26/09/2026 12:09** (bản v1) + **12:25–12:32** (audit) +
> **13:0x** (tự kiểm lại của tác giả sau audit).

## 0.1. Lịch sử bản — đọc trước

| Bản | SHA-256 | Việc |
|---|---|---|
| **v1** | `72ae574acc5ac99a8e1d907df171a4bb3c6e6b976f5e3cd15d4f297771c53252` | bản đem đi audit |
| **v2** | `6b7e994d1523c5b08456d3eec5bb673d45c583e5b7846604b1271a80efe009c0` *(tính TRƯỚC khi chèn chính dòng này — xem ghi chú)* | sửa theo audit |

> SHA v2 ở trên là hash của bản ngay sau khi viết xong, **trước** khi tự chèn hash vào chính nó. Người audit vòng sau tính lại sẽ ra số khác — hãy ghim số mình tự tính và ghi vào báo cáo, đừng dùng số này để đối chiếu.

**Báo cáo audit độc lập:** [`docs/audits/2026-09-26-plan-cam-ket-audit/BAO-CAO.md`](../audits/2026-09-26-plan-cam-ket-audit/BAO-CAO.md)
— kết luận **"chưa đủ điều kiện thi hành"** với 3 mục CHẶN (C1–C3) và 10 mục PHẢI SỬA (P1–P10).

**Tác giả plan đã tự kiểm lại độc lập 6 phát hiện có sức nặng nhất và xác nhận audit đúng cả 6.** Không có
phát hiện nào bị bác. Bảng xử lý từng mục ở **§11**.

Bốn chỗ bản v1 **sai về sự thật** (không phải khác quan điểm), đã sửa trong v2:

| v1 nói | Sự thật | Ảnh hưởng |
|---|---|---|
| 100 nhóm hạng mục trùng tên | Đếm **gộp hai org**. Từng org: **0 nhóm trùng**. Đã có UNIQUE `(organization_id, lower(btrim(type)), normalize_name(name))` | **G3 đổi bản chất**: không còn là "gộp danh mục", chỉ còn "ánh xạ 9 fee key" |
| `income_expense_types` RLS mở hoàn toàn | Policy đó **đã DROP** từ `20260528000003`. Nay 11 policy, có RBAC + org boundary RESTRICTIVE | §11.2 cũ sai tiền đề; nhưng **vẫn cần thiết kế quyền cột luật** — xem §4.8 |
| G1 nhập giá là "chỉ dữ liệu, không cần đường lùi" | `special_fee_rule_check_v1` so **BẰNG** tổng giá tháng. Nhập giá 26tr rồi trả đợt 13tr ⇒ `AMOUNT_MISMATCH` ⇒ CHỜ, **ngay lập tức, trước mọi thay đổi mã** | **G1 viết lại hoàn toàn** — xem §6 G1 |
| G7 sẽ REVOKE `record_invoice_payment_v4` | **Đã REVOKE rồi** (`20260925083655`), ACL sống `{postgres=X/postgres}` | bỏ khỏi G8 |

Ba chỗ v1 **thiếu**, đã bổ sung: giao thức cam kết (§4.7) · thiết kế quyền cột luật (§4.8) · facts theo dòng
cho phiếu nhiều hạng mục (§4.4).

---

## 0.2. Dành cho người audit vòng sau — cách kiểm tài liệu này

Giữ nguyên bốn loại chứng cứ của v1: **số đo sống** (Phụ lục A) · **vân tay hàm md5** (Phụ lục B) ·
**điểm neo trong mã** (Phụ lục C) · **[SUY LUẬN]** gắn nhãn tại chỗ.

Audit vòng 1 đã dạy ba bài, v2 áp dụng:

1. **Mọi phép đếm trên bảng có `organization_id` phải `group by` hoặc lọc org.** Không thì ra số gộp
   THẬT–DEMO. Đây là gốc của C1.
2. **md5 khớp chỉ chứng minh đúng thân hàm, không chứng minh đúng cách hiểu số.** A-4 khớp số nhưng sai
   diễn giải.
3. **Trạng thái hiện tại ≠ trạng thái lúc sinh.** "210 APPROVED" không phải "210 tự duyệt lúc lập"; audit
   đo được 198/210 có `approved_at` cách `created_at` ≤ 5 giây và gọi đó là **proxy**, không phải lịch sử.

---

## 1. Tóm tắt một trang

**Vấn đề.** Mỗi cửa ghi phiếu tự quyết phiếu sinh ra đã duyệt hay chờ, theo luật chép riêng trong bụng nó.
Cờ `force_approval` khai trên hạng mục chỉ được **3 hàm dùng để quyết định** (trong 9 hàm có nhắc chuỗi đó);
`pay_period_fee`, `pay_utility_bill`, bộ sinh định kỳ, `ie_compat_insert_v2` **không nằm trong số đó**. Chủ
đặt luật lên hạng mục rồi một cửa khác đi vòng qua.

**Đích.** Một **bộ máy quyết định** duy nhất; mọi cửa ghi phiếu đều hỏi nó; nó đọc luật khai **trên hạng
mục**. Mỗi hạng mục khai đúng **một trong ba kiểu**: CAM_KẾT · TRẦN · TỪNG_PHIẾU.

**Hai thứ v1 tưởng là hệ quả miễn phí, audit bác — v2 làm thành việc thật:**

- ~~"Chống chi trùng miễn phí"~~ → **Sai.** Cam kết chống **vượt tổng**; nó **không** chống **gửi lại cùng một
  yêu cầu** (cam kết 100tr, hai request 30tr trùng nhau đều dưới 100tr). Idempotency là lớp riêng, giữ
  nguyên. Cam kết chỉ thay được *khoá khe theo kỳ*, và chỉ khi có **giao thức khoá + tiêu/giữ/hoàn** (§4.7).
- ~~"G1 chỉ là nhập dữ liệu"~~ → **Sai.** Nhập vào bảng giá hiện tại là đổi quyết định duyệt ngay. v2 dùng
  **bảng cam kết MỚI mà writer hiện tại không đọc**, nên nhập liệu thật sự an toàn.

**Chín bước.**

| Bước | Việc | Chặn bởi | Cỡ |
|---|---|---|---|
| **G0** | Chốt ngữ nghĩa cam kết + thiết kế giao thức khoá. Tài liệu + quyết định chủ, **không code** | — | S |
| **G1** | Bảng cam kết mới + màn nhập, **writer chưa đọc**. Chủ nhập dần | G0 | M |
| **G2** | Bộ máy quyết định + facts theo dòng + ghi lý do. **Chạy bóng tại thời điểm sinh**, chưa chặn | G0 | M–L |
| **G3** | Ánh xạ 9 fee key vào danh mục canonical **theo từng org** + khoá quyền cột luật | — | S–M |
| **G4** | Giao thức cam kết: khoá + tiêu/giữ/hoàn, áp **đồng thời cho MỌI writer tiêu bucket** | G1, G2, G3 | M–L |
| **G5** | Bật theo **BUCKET** (org × toà × hạng mục × kỳ), không theo writer | G4 | M |
| **G6** | Sổ chi theo danh sách, với quyền **CHI** | — | S–M |
| **G7** | Một đường duyệt (cả `approve_income_expense_v1` **và** `approve_voucher`) | G5 | M |
| **G8** | Dọn đường cũ, chuyển caller compat, sửa tài liệu + superplan | G7 | S–M |

**G3 và G6 chạy song song với mọi thứ.** G0 phải xong trước tất cả.

---

## 2. Quyết định của chủ (26/09) — giữ nguyên

Nguyên văn ý định: trang Thanh toán tồn tại để quản lý/kế toán *"thanh toán tập trung một chỗ, nhanh gọn,
dễ đối soát"*; luật phải *"đồng bộ về một bộ máy ở thu chi, quản lý theo hạng mục"* để *"mọi quyết định chi
đều rõ ràng, không phải quyết định bẻ ngang"*.

| # | Đã chốt | Trạng thái sau audit |
|---|---|---|
| Đ1 | Một bộ máy quyết định | giữ |
| Đ2 | Luật khai trên hạng mục | giữ — **nhưng lý do "vì bảng riêng sửa được bằng SQL" bị audit bác và đã bỏ**; lý do đúng ở §4.8 |
| Đ3 | Ba kiểu: CAM_KẾT · TRẦN · TỪNG_PHIẾU | giữ |
| Đ4 | Bỏ bước "khoá khe chống chi trùng" | **sửa**: bỏ *khoá khe theo kỳ*, nhưng **phải có giao thức cam kết §4.7 thay thế**, và **giữ nguyên idempotency** |
| Đ5 | Luật huỷ phiếu giữ nguyên | giữ — **nhưng cơ chế hoàn cam kết vẫn phải chạy khi huỷ** (§4.7), đó là hạ tầng, không phải đổi luật quyền |
| Đ6 | Bỏ tầng ngoại lệ theo toà/người | giữ |

---

## 3. Hiện trạng — số đã sửa theo audit

### 3.1. Đã vá 23–25/09

Giữ nguyên bảng của v1 (5 việc: đường hoàn thứ hai · mã phiếu · sửa phiếu chờ duyệt · sổ nhận tiền · khoá
tháng tuyệt đối), **thêm một dòng audit tìm ra**: `record_invoice_payment_v4` **đã bị REVOKE** ở
`20260925083655`, ACL sống `{postgres=X/postgres}`.

Ba đính chính về mức độ "đã xong", theo audit:

- **Mã phiếu**: chỉ bảo vệ **từ mốc migration** (partial unique index `created_at >= <mốc>`). Lịch sử trước
  đó vẫn còn mã trùng. Không tuyên bố "lịch sử sạch".
- **Đường hoàn thứ hai**: đã thu quyền entry point + Copilot; **không DROP mọi hàm liên quan**.
- **Đóng đường sửa cũ**: có migration; **không suy ra mọi caller cũ đã dọn**.

### 3.2. Còn nguyên

| # | Việc | Ghi chú sau audit |
|---|---|---|
| a | Mỗi cửa một luật; `CONFIG_REQUIRED` vẫn dẫn tự duyệt ở `pay_period_fee` | xác nhận |
| b | Cờ hạng mục bị bỏ qua | 9 hàm **nhắc chuỗi** `force_approval`; chỉ ~3 là **điểm quyết định**. `ensure_*`/`seed_*` là ghi/default |
| c | Cửa **chi** chưa dùng danh sách sổ | đúng với 3 cửa của G6. **Không** đếm lại "≈10 server + ≈8 UI" của plan cũ — con số đó chưa kiểm |
| d | `update_cashbook_metadata_v1` ghi thẳng `initial_amount` | đúng; **v2 chưa có phase xử lý** — đưa vào §10 câu 12 |
| e | Huỷ phí không đòi `income_expenses.cancel`/lý do | đúng trong hai thân hàm, **nhưng còn kiểm actor/building/admin và trigger khoá tháng** — "không có luật" là quá rộng. Chủ giữ nguyên (Đ5) |
| f | `receiving_cashbook_ids_v1` | **không phải "một caller"**: còn `allowed`/`assert`/read RPC và `change_collection_tender_method_v1`. Ý "chỉ phủ đường THU" vẫn đúng |

### 3.3. Số nền — đã sửa cách đếm

| Chỉ số | 26/09 | Ghi chú |
|---|---:|---|
| `special_fee_price_versions` | **0 dòng** | nguồn cũ; **v2 không dùng làm sổ cam kết** |
| `utility_ceiling_versions` | **24 dòng / 16 toà** | 16 ELECTRIC + 8 WATER, hiệu lực từ 01/08/2026, **24 trần số tiền, 0 tỷ lệ** |
| — độ phủ trên phiếu còn sống | **14/15 toà · 22/26 cặp toà–loại** | thiếu: `111PVC–WATER`, `158PVC–WATER`, `15KV–WATER`, `Kho Văn Phòng Chung–ELECTRIC` |
| `self_approve_limits` | **0 dòng** | |
| `income_expense_types` | **THẬT 108 · DEMO 103** | **0 nhóm trùng tên trong từng org**; 28 `force_approval` mỗi org |
| Phiếu CHỜ DUYỆT org THẬT | **144 / 781.731.917đ**, 51 treo > 30 ngày | |
| Sổ quỹ âm | **4 / −828.138.725đ** | |
| Khe (toà × tiền nhà × kỳ) > 1 phiếu | **8** | đo theo `item.start_date`; **khác mẫu** `B-TRUNG-KHE` cũ (dùng `voucher_date`) ⇒ **không so 10→8** |
| Phiếu `utility.bill` 90 ngày | **83 / 556.009.060đ** | **78 APPROVED · 5 CANCELLED · 0 UNAPPROVED** |
| Phiếu `fixed_fee` 90 ngày | **0** | lưới phí cố định không ai dùng |
| Phiếu con định kỳ 90 ngày | **223 / 1.300.661.000đ** | **210 APPROVED 810,8tr · 7 CANCELLED 194,9tr · 6 UNAPPROVED 295,0tr** |

**Ba diễn giải v1 sai, audit sửa:**

1. ~~"83/83 tự duyệt ⇒ nghi trần không kích"~~ → **Trần CÓ kích.** Có **3 phiếu APPROVED mang ghi chú
   `[VƯỢT TRẦN …]`, tổng 7.891.317đ**, được duyệt sau khi tạo từ 29 phút tới 1 ngày 18 giờ. Writer chỉ nối
   dấu đó ở nhánh vượt trần. "0 đang chờ" là ảnh chụp hiện tại, không phải lịch sử.
2. ~~"1,30 tỷ nguồn tự duyệt lớn nhất"~~ → **Sai hai lần**: tổng đó gộp cả CANCELLED và UNAPPROVED (thực
   APPROVED là 810,8tr); và "lớn nhất" chưa có mẫu so tiền đồng nhất giữa các nguồn.
3. ~~"100 nhóm trùng"~~ → gộp org, xem §0.1.

---

## 4. Kiến trúc đích

### 4.1. Ba kiểu chi

```
CAM_KET    — có cam kết chủ ký trước cho (org, toà, hạng mục chuẩn, kỳ)
TRAN       — có mức trần cho (org, toà, loại tiện ích, kỳ)
TUNG_PHIEU — không có gì ký trước
```

Mặc định hạng mục chưa khai: **`TUNG_PHIEU`**.

> ⚠ **Không gọi toàn bộ chuyển đổi là "tái cấu trúc bảo toàn chính sách".** B1/B2 và việc bỏ bậc OWNER
> **đổi hành vi** trước khi tới TUNG_PHIEU (§4.3, §10 câu 05/07). Audit bắt đúng chỗ này ở v1.

### 4.2. Nơi luật nằm — hai tầng

| Tầng | Ở đâu | Ai đổi | Chứa gì |
|---|---|---|---|
| **1 · Khung** | trong mã | qua PR + review chéo | Danh sách B0 · "không sổ thật ⇒ CHỜ" · thứ tự bậc · trần cứng không nới bằng dữ liệu |
| **2 · Luật hạng mục** | cột trên `income_expense_types` | chủ, qua **RPC chuyên biệt** (§4.8) | `spend_mode` + tham số |

**Lý do chọn cột-trên-hạng-mục — viết lại sau audit.** Lý do cũ ("bảng riêng sửa được bằng một câu SQL") bị
bác đúng: **cột trên danh mục cũng UPDATE được bằng SQL**, và bảng `app_private` hiện đã có REVOKE + setter.
Ranh giới an toàn đến từ **quyền/enforcement/audit**, không từ vị trí bảng. Lý do thật sự để chọn phương án
này là **nghiệp vụ**: luật dính liền thứ người lập phiếu chọn, nên không có cảnh "tạo hạng mục mới mà quên
khai luật", và chủ đọc được luật ngay tại chỗ họ đã quen. An toàn thì do §4.8 lo, không do vị trí.

### 4.3. Bậc quyết định

```
B0  Nguồn hệ thống tự cân đối (ma trận ĐÓNG trong mã, §4.6)   → ĐÃ DUYỆT   SYSTEM_BALANCED
B3  THU nhập tay                                               → ĐÃ DUYỆT   INCOME_POLICY
B1  CHI không có sổ thật, hoặc người lập không dùng được sổ     → CHỜ        NO_CASHBOOK
B2  (đã bỏ — xem ghi chú dưới)
B4  spend_mode = CAM_KET
      mọi dòng nằm trong phần cam kết còn lại của bucket của nó → ĐÃ DUYỆT   WITHIN_COMMITMENT
      ngược lại                                                → CHỜ        OVER_COMMITMENT
B5  spend_mode = TRAN
      có trần hiệu lực và số tiền ≤ trần                       → ĐÃ DUYỆT   UNDER_CEILING
      không có trần khai                                       → CHỜ        NO_CEILING       ⚠ đổi chính sách
      vượt trần                                                → CHỜ        OVER_CEILING
B6  spend_mode = TUNG_PHIEU
      CHI có force_approval → CHỜ · CHI ≥ ngưỡng → CHỜ · còn lại → ĐÃ DUYỆT
B7  Còn lại                                                    → CHỜ        NEEDS_APPROVAL
```

**Chủ chốt 26/09 (câu 07): KHÔNG đụng phiếu THU.** Nguyên văn: *"đừng sửa cái này đâu liên quan gì đâu,
đừng làm quy trình rắc rối hay phát sinh thêm."* Hệ quả với thang bậc:

- **B3 (THU tự duyệt) lên trước B1.** Phiếu thu giữ nguyên hành vi hôm nay — kể cả **thu cọc**, kể cả phiếu
  dùng sổ ảo. Không đổi một dòng nào ở chiều thu.
- **B1 thu hẹp còn CHI.** Phiếu chi không có sổ thật vốn đã không ghi sổ được; bậc này chỉ làm điều đó tường
  minh, không đổi hành vi.
- **B2 bỏ hẳn.** Nó vốn định bắt hạng mục cọc phải chờ ở mọi chiều — trái quyết định 07 và chỉ ảnh hưởng
  **1 phiếu** trong 90 ngày (293 phiếu THU không nhãn đã duyệt, 0 thiếu sổ, 1 dùng sổ ảo). Không đáng đổi.

**Còn đúng một bậc là đổi chính sách thật: B5 `NO_CEILING → CHỜ`.** Hiện 4 cặp toà–loại đang có phiếu sống
mà chưa khai trần. Bật mà chưa khai đủ là đẩy chúng vào hàng chờ — nên câu 03 phải xong trước.

**Bậc OWNER** (người có quyền duyệt tự duyệt phiếu mình) **không có trong danh sách, mặc định TẮT** — chờ
§10 câu 05.

### 4.4. Facts theo DÒNG, không theo phiếu

Audit (P5) bắt đúng: `create_income_expense_v1` nhận `p_items`, lặp `jsonb_array_elements`, dùng
`bool_or(force_approval)`. Phiếu **hỗn hợp** CAM_KẾT + TRẦN + TỪNG_PHIẾU, hoặc **trải nhiều kỳ**, không có
luật tổng hợp trong v1.

```
ie_spend_decide_v1(facts jsonb) → jsonb        -- IMMUTABLE, thuần
  facts.lines[]  : mỗi dòng { hạng_mục_chuẩn, spend_mode, số_tiền, kỳ, bucket_key, còn_lại/trần/ngưỡng }
  facts.voucher  : { org, toà, chiều, nguồn_writer, có_sổ_thật, người_lập_dùng_được_sổ }
```

**Quy tắc tổng hợp:** phiếu **chỉ tự duyệt khi MỌI dòng đạt** (trừ B0 đã xác thực). Một dòng CHỜ ⇒ cả phiếu
CHỜ. Trả `lý do từng dòng` + `lý do tổng`.

**Phân bổ:** tuyệt đối không nhét tổng tiền phiếu vào một cam kết tuỳ ý. Mỗi dòng tiêu đúng bucket của nó.
Dòng trải nhiều kỳ phải khai phân bổ theo kỳ, hoặc bị từ chối ở G2 với lý do rõ.

### 4.5. Ghi lý do và provenance

Ngoài `decision_reason_code` + `decision_reason_text`, phải lưu **provenance đủ để chứng minh lại quyết
định khi luật đổi** (audit §4):

`rule_version` · `commitment_version` / `ceiling_version` đã dùng · `facts_snapshot` (jsonb) ·
`writer` · `decided_at` · `birth_status`.

Không có bộ này thì "replay" và "rollback" không phân biệt được quyết định lúc nào.

### 4.6. Ma trận B0 — không phải danh sách chuỗi

v1 định dùng `system_source`. Audit bác: nhãn đó **do chính writer ghi**, và các nguồn hệ thống **có cả phiếu
chờ** (`contract.commission` 116 phiếu có 49 chờ; `termination.refund` 79 có 36 chờ). Nâng cả nguồn lên
APPROVED là sai.

B0 phải là **ma trận trong mã**: `nguồn → writer → chiều → cash/non-cash → điều kiện`. Bản đầu sinh từ đo
bóng G2, **chủ duyệt** (§10 câu 06).

### 4.7. Giao thức cam kết — phần v1 thiếu, C2

**Bảng mới (không tái dùng `special_fee_price_versions`):**

```
app_private.spend_commitments
  (id, organization_id, building_id, canonical_type_id, period_from, period_to,
   amount_total, status PUBLISHED|RETIRED, version, note, created_by, created_at, retired_at)

app_private.spend_commitment_draws
  (id, commitment_id, income_expense_id, income_expense_item_id,
   kind HOLD|DRAW|RELEASE, amount, over_commitment bool, reason, actor_id, created_at)
```

**Định nghĩa "đã tiêu" — v1 không định nghĩa, đây là chỗ audit chặn:**

| Sự kiện | Ghi gì | Vì sao |
|---|---|---|
| Phiếu sinh ra **CHỜ** gắn bucket | `HOLD` | 144 phiếu chờ hiện nay nếu vô hình thì lần tự duyệt sau sẽ vượt cam kết mà không biết |
| Phiếu **được duyệt** | `HOLD → DRAW` | tiêu thật |
| Phiếu sinh ra **đã duyệt** | `DRAW` thẳng | |
| Phiếu **huỷ / đảo / restore-về-huỷ** | `RELEASE` | **chạy kể cả khi luật quyền huỷ giữ nguyên (Đ5)** — đây là hạ tầng, không phải quyền |
| **Duyệt phần vượt** | `DRAW` với `over_commitment = true` + lý do | không tự nới cam kết; lần sau đọc đúng số đã tiêu |

`còn_lại = amount_total − Σ HOLD hiệu lực − Σ DRAW hiệu lực`.

**Giao thức khoá — bắt buộc, cùng transaction:**

```sql
-- VOLATILE, không khai STABLE/IMMUTABLE
perform pg_advisory_xact_lock(
  hashtextextended('spend:'||org||':'||building||':'||canonical_type||':'||period_key, 0));
```

- Lấy khoá **TRƯỚC khi đọc** số đã tiêu. Khoá theo **bucket**, không theo row — `SELECT FOR UPDATE` trên tập
  rỗng **không khoá một khe chưa tồn tại**.
- Nhiều dòng / nhiều kỳ: lấy **đủ mọi bucket theo thứ tự sắp xếp cố định** `(org, building, type, period)`
  để tránh deadlock. Sửa phiếu đổi bucket: khoá **cả cũ lẫn mới**, cùng thứ tự đó.
- Sau khi có khoá **đọc lại facts**, rồi mới quyết định.
- **Nguyên tử:** khoá → đọc → quyết định → ghi HOLD/DRAW → ghi phiếu + posting, trong **một** transaction.
- `ie_spend_decide_v1` vẫn thuần; hàm lấy khoá nằm ở lớp `ie_spend_facts_v1`.

**Cam kết KHÔNG thay idempotency.** Cam kết 100tr, hai request 30tr trùng nhau đều dưới 100tr và đều hợp lệ
với khoá hoàn hảo. Giữ nguyên `idempotency_key` theo `(operation, subject, actor, key)`. **Hai lớp độc lập,
cả hai bắt buộc.** v1 nói "chống chi trùng miễn phí" — câu đó đã bị gỡ.

**Khác `special_fee_rule_check_v1` ở một điểm quyết định:** rule cũ so **BẰNG** tổng giá tháng; cam kết so
**≤ phần còn lại**. Nhờ vậy **trả nhiều đợt là hợp lệ** — đây là lý do kỹ thuật buộc phải dùng bảng mới chứ
không nhập vào bảng giá cũ (xem C3, §6 G1).

### 4.8. Quyền sửa cột luật — phần v1 thiếu, P1

Tiền đề cũ ("RLS mở hoàn toàn") sai. Nhưng rủi ro thật vẫn còn: **ai qua được quyền sửa danh mục sẽ sửa được
cột luật mới nếu migration chỉ thêm cột.** Cơ chế bắt buộc:

1. **Thu quyền UPDATE cấp bảng** khỏi role client trên `income_expense_types`, cấp lại **theo cột** cho các
   cột nghiệp vụ thường. `REVOKE UPDATE(spend_mode)` mà vẫn còn table-level UPDATE **không có tác dụng** —
   PostgreSQL cộng quyền bảng và cột.
2. Cột luật (`spend_mode` + tham số), và các cờ ảnh hưởng luật (`force_approval`, `is_deposit`,
   `canonical_type_id`, `fee_category`, `organization_id`) chỉ sửa qua **RPC chuyên biệt**: kiểm danh tính/
   chủ **đúng org**, so old/new, ghi lịch sử, có version/CAS.
3. **Đóng cả INSERT/upsert và xoá-tạo-lại** để đổi luật. Mặc định bản ghi mới phải là chính sách an toàn
   (`TUNG_PHIEU`), không để người có `categories.create` tạo hạng mục "dễ tự duyệt".
4. Có thể dùng trigger bảo vệ old/new thay ACL cột nếu cần tương thích client — **nhưng phải là enforcement
   server có kiểm quyền thật**, bao gồm INSERT/DELETE/mapping. UI ẩn ô không tính.
5. **Nghiệm thu bằng JWT/REST trên TEST**, không chỉ đọc catalog: chủ đúng org · quản lý chỉ sửa được tên ·
   user thiếu capability · cross-org · đổi pointer/flags · INSERT/upsert · helper definer · bulk import.

> ⚠ Audit chỉ xác minh catalog, **chưa thử các thao tác ghi này**. G3 phải tự chạy.

### 4.9. Định nghĩa "xong"

| Mã | Bất biến | Đo bằng | Đích |
|---|---|---|---|
| INV-1 | Mọi phiếu **do writer đã nối** sinh ra có `decision_reason_code` + provenance | đếm theo writer đã nối | 100% |
| INV-2 | Trạng thái khi sinh = kết quả `ie_spend_decide_v1` với facts **chụp lúc sinh** | bảng bóng G2 | lệch 0 *(trừ lệch do chính sách chủ đổi, phân loại riêng)* |
| INV-3 | Writer đã nối không tự đặt `approval_status`; writer **ngoài phạm vi §4.6** nằm trong allowlist có gate riêng | inventory writer ở DB + ACL/guard runtime + test đột biến âm tính | 0 ngoài allowlist |
| INV-4 | **Trong từng org**: mọi fee key ánh xạ đúng một hạng mục canonical; không pointer vòng/cross-org | SQL A-4b | 0 lỗi |
| INV-5 | Giữ bất biến ghi sổ | `B-GHI-SO`/`B-DUYET-TRUOC`/`B-DUYET-CO-SO` | 0·0·0 |
| INV-6 | Tiền không đổi vì chuyển đổi | `gate:reconcile-money` + `-v2` | khớp |
| **INV-7** | **Không bucket nào bị tiêu vượt tổng** (trừ DRAW có `over_commitment` + lý do) | SQL trên `spend_commitment_draws` | 0 |

> INV-1/2/3 của v1 đòi *"mọi phiếu"* trong khi §4.6 loại writer hệ thống ra — **mâu thuẫn**, audit bắt đúng.
> v2 thu hẹp về "writer đã nối" + allowlist có gate.
>
> INV-4 của v1 đòi "0 tên trùng toàn DB" — **bỏ**, vì đếm cross-org và vì UNIQUE per-org đã có sẵn.

### 4.10. Cố ý KHÔNG làm

Như v1, cộng thêm: **không đụng `a01_reservation_type_guard`** (guard vùng thanh lý trên bảng hạng mục — nó
so toàn JSON old/new; đổi cột mới trên type đã dùng cho xử lý bỏ cọc có thể bị chặn `55000`). G3 phải xử lý
bằng cách khác, không disable guard đó.

---

## 5. G3 — Ánh xạ, KHÔNG phải gộp

**Chẩn đoán v1 sai** (C1). Sự thật: mỗi org đã canonical, có UNIQUE `(organization_id, lower(btrim(type)),
normalize_income_expense_type_name(name))` từ `20260728180000`, và **0 nhóm trùng trong từng org**.

**Việc còn lại nhỏ hơn hẳn:**

1. Thêm `fee_category` (nullable) lên `income_expense_types`, **unique theo `(organization_id,
   fee_category)`**, chỉ nhận 9 key hợp lệ (CHECK khớp `GRID_SERVER_KEYS`).
2. Ánh xạ 9 key vào đúng hạng mục canonical **của từng org** — THẬT và DEMO ánh xạ **độc lập**.
   ⛔ Tuyệt đối không chọn một dòng chuẩn chung cho cặp THẬT/DEMO.
3. Bỏ `fee_type_matches` (khớp theo tên) sau khi (2) xong; cập nhật hoặc gỡ mirror TypeScript
   `feeTypeMatches` + test parity. *(Audit: chưa thấy matcher TypeScript có caller production tại SHA này.)*
4. **Alias/`canonical_type_id` chỉ thêm khi có nhu cầu thực đã đo** — hiện chưa có. Nếu thêm: FK composite
   cùng org, cùng chiều, alias trỏ thẳng root, không vòng/chuỗi; root bị RLS ẩn hoặc pointer sai phải
   **thất bại an toàn**, không rơi về luật nhẹ hơn.

**Nghiệm thu:** INV-4. **Không** dùng "parity tuyệt đối 90 ngày" làm nghiệm thu — mâu thuẫn với việc đang
muốn *sửa* matcher gộp sai. Thay bằng: parity trên tập không bị ảnh hưởng, cộng **danh sách lệch có oracle
và được chủ duyệt**.

> Con số "gộp nhầm 16 ô Vệ sinh / 10 Rác / 3 Công an" kế thừa từ 23/09, **chưa chạy lại**. Phải đo lại ở G3.

---

## 6. Các giai đoạn

Khung: **Mục tiêu · Được đụng (ĐÓNG) · Nghiệm thu · Đường lùi · Rủi ro.**
Thứ tự: **G0 → (G1 ∥ G2 ∥ G3 ∥ G6) → G4 → G5 → G7 → G8.**

### G0 — Chốt ngữ nghĩa và thiết kế · không code

- **Mục tiêu:** chốt §10 (12 câu) và viết đặc tả giao thức §4.7 đủ chi tiết để hiện thực.
- **Sản phẩm:** đặc tả cam kết (kỳ tính, hết hiệu lực, trả thiếu/thừa/trước, phân bổ nhiều kỳ, snapshot
  phiên bản, giữ chỗ pending, duyệt vượt, sửa luật hồi tố) · ma trận B0 nháp · ma trận caller duyệt (G7).
- **Nghiệm thu:** chủ ký 12 câu §10. **Không mở G1–G8 khi còn câu treo thuộc giai đoạn đó.**
- **Đường lùi:** — (không đụng hệ thống).

### G1 — Sổ cam kết · **đã có migration, thử xong trên TEST**

> **Phát hiện 26/09 làm G1 nhẹ hơn hẳn dự kiến.** Bản v2 viết G1 là "chủ ngồi nhập từ đầu". Thực tế chủ
> **đã khai xong số liệu** — nhưng ở `public.building_fee_accounts.default_amount`, không phải ở bảng mà
> luật đọc. Đo prod 26/09: **107 dòng có số tiền / 17 toà / 8 hạng mục**; riêng **tiền nhà 15 toà =
> 681.650.000đ/tháng**. Toà không có số tiền nhà (44TL) = **không thuê lại** — luật do chủ nêu.
>
> Nên G1 là **CHUYỂN dữ liệu sang bảng đúng**, không phải nhập lại.

**Vì sao không dùng thẳng hai bảng đang có:**

| | `building_fee_accounts` | `special_fee_price_versions` | Cam kết cần |
|---|---|---|---|
| Theo tháng | ✕ một số cho mỗi (toà × hạng mục) | ✓ | chủ chốt **ký từng tháng** |
| Ai sửa | ✕ ai vào được toà | ✓ chủ/super admin | chủ + super admin |
| Lịch sử | ✕ sửa là mất số cũ | ✓ có retire | tra được "tháng đó ký bao nhiêu" |
| Phép so | — | ✕ **so BẰNG** tổng tháng | **≤ phần còn lại** (cho trả nhiều đợt) |
| Sổ tiêu / giữ chỗ | ✕ | ✕ | bắt buộc (§4.7) |
| Writer có đọc không | có | **có — nên nhập vào là đổi hành vi ngay (C3)** | **không, cho tới G5** |

**Migration:** `supabase/migrations/20260926082454_bang_cam_ket_chi.sql`

Nội dung: hai bảng `app_private.spend_commitments` + `spend_commitment_draws` · hai hàm đọc số còn lại ·
hai RPC cho chủ (`set_spend_commitment_v1`, `list_spend_commitments_v1`) · khởi tạo từ
`building_fee_accounts` thành **12 tháng, từ 2026-10-01 đến 2027-09-01**, nguồn `MIGRATED`.

**Một quyết định thiết kế đáng ghi:** sổ tiêu dùng **một dòng-trạng-thái** cho mỗi (cam kết × dòng hạng mục),
`kind` đi `HOLD → DRAW → RELEASE`, ba mốc thời gian lưu riêng — **không** dùng chuỗi sự kiện. Lý do: số còn
lại phải trừ HOLD *hoặc* DRAW của cùng một dòng **đúng một lần**; chuỗi sự kiện bắt phải lọc "cái nào đã bị
thay", mở đường cho lỗi đếm trùng.

**Kết quả thử trên project TEST** (`hzulujxgonszuleqticb`, trong transaction rồi ROLLBACK, 26/09):

| | |
|---|---|
| Cam kết sinh ra | **106 khe × 12 tháng = 1.272 dòng** |
| Tiền nhà tháng 10/2026 | **15 toà · 681.650.000đ** — khớp đúng số đo production |
| Điện | 16 toà · 156.455.057đ |
| Vệ sinh · Nước · Công an · Rác · Internet · Thang máy | 14 · 12 · 13 · 16 · 14 · 6 toà |
| Chạy lượt hai | **1.272 dòng, không nhân đôi** — idempotent đạt |
| Tự kiểm trong migration | qua (`106 khe nguồn = 106 khe cam kết`) |

*(TEST có 106 khe, production 107 — TEST đồng bộ ngày 23/09 nên lệch 1 khe `cong_an`. Phép tự kiểm so
trong cùng một DB nên đạt ở cả hai.)*

- **Được đụng:** hai bảng mới ở `app_private`, bốn hàm mới, không gì khác.
  ⛔ **Không đụng** `building_fee_accounts`, `special_fee_price_versions`, `pay_period_fee`,
  `generate_special_fees_v1`, `create_income_expense_v1`, phiếu, sổ, hoá đơn.
- **Nghiệm thu:** migration chạy qua + tự kiểm đạt + **quét thân hàm chứng minh 0 writer đọc hai bảng mới**.
- **Đường lùi:** REVOKE hai RPC khỏi `authenticated`; hai bảng để nguyên (không ai đọc). Xoá sạch khởi tạo:
  `DELETE FROM app_private.spend_commitments WHERE source = 'MIGRATED'` — an toàn vì chưa draw nào trỏ vào.
- **ĐÃ ÁP PRODUCTION 26/09/2026** qua lane `migrate:forward --apply` (chủ uỷ quyền trực tiếp, bỏ review
  chéo). Lane tự kiểm hai lượt ROLLBACK → backup full 26,4 MB (`ihomecrm-full-2026-09-26T11-30-32-672Z.dump`,
  sha256 `dcca965ea16f6781…`) → áp 0s → catalog `afe30d1f… → 35e360fe…`. Bằng chứng:
  `docs/generated/schema-change-evidence/20260926082454_bang_cam_ket_chi.json`.
- **Kiểm đọc thật sau áp:** 1.272 dòng / **106 khe** / 12 tháng 10/2026→09/2027; tiền nhà tháng 10 =
  15 toà · 681.650.000đ; 0 draw; RPC mở cho `authenticated` + `service_role`, **anon không có**.
  *(106 chứ không phải 107: seed bỏ dòng `not_applicable = true` — đúng ý đồ; tự kiểm trong migration
  so nguồn và đích cùng bộ lọc nên đạt.)*
- **Gate sau áp:** `gate:reconcile-money` PASS (A = B = C = 5.788.924.013đ) · `gate:reconcile-money-v2` PASS
  (20 sổ thật khớp legacy == v2; phân trang khớp SQL aggregate).
- **Còn thiếu:** màn hình cho chủ xem/sửa cam kết — hiện dùng RPC `set_spend_commitment_v1` /
  `list_spend_commitments_v1` trực tiếp.

### G2 — Bộ máy + facts theo dòng + **bóng tại thời điểm sinh**

> v1 định chấm bóng bằng **job đêm**. Audit (P4) bác: số dư cam kết, phiên bản luật, mapping, trạng thái
> phiếu đều đổi trước lúc chấm. Ví dụ phiếu 26tr đúng lúc còn 26tr; tới đêm chính nó đã tiêu hết, chấm lại
> còn 0 ⇒ **vượt giả**. Job đêm là **hậu kiểm**, không phải shadow.

- **Mục tiêu:** `ie_spend_decide_v1` + `ie_spend_facts_v1` chạy được; writer gọi `facts` **ngay trong
  transaction sinh phiếu**, ghi `facts_snapshot` + kết quả bóng vào bảng bóng, **nhưng vẫn dùng luật cũ để
  quyết định**. Đây là shadow thật.
- **Được đụng:** hai hàm mới, một bảng bóng, cột `decision_*` + provenance trên `income_expenses`, và
  **một dòng gọi facts** trong mỗi writer sẽ nối (chưa đổi nhánh quyết định).
- **Nghiệm thu:** bóng chạy ≥ 14 ngày; **fixture TEST có số ca tối thiểu và đủ biên** (bóng không có ca là
  bằng chứng rỗng — `pay_period_fee` đang 0 phiếu/90 ngày, 14 ngày 0 lệch không xác nhận gì); mọi dòng lệch
  phân loại thành **"chính sách chủ muốn đổi"** hoặc **"sai so oracle"**.
  ⛔ **Không** đặt nghiệm thu "lệch 0 so luật cũ" — sẽ không bao giờ đạt khi chủ thật sự đổi B1/B2/NO_CEILING/OWNER.
- **Đường lùi:** tắt ghi bóng; cột thừa vô hại. **Không xoá hàm** (pg_cron job ma).

### G3 — Ánh xạ fee key + khoá quyền cột luật · **ĐÃ ÁP PRODUCTION 26/09**

Nội dung §5 + §4.8. **Song song, không chặn bởi G1/G2.**

**Migration:** `supabase/migrations/20260926113435_anh_xa_hang_muc_va_khoa_cot_luat.sql` — thêm cột
`fee_category` (unique theo org) và `spend_mode` (mặc định `TUNG_PHIEU`) lên `income_expense_types`;
ánh xạ 9 khoá **theo tên chuẩn hoá trong từng org** (không ghim UUID, không dòng chung THẬT/DEMO); gán
`dien/nuoc → TRAN`, 7 khoá còn lại → `CAM_KET`; trigger `a05_ie_type_rule_columns_guard` bảo vệ cột luật
(spend_mode, fee_category, force_approval, is_deposit, organization_id) — chỉ chủ công ty / super admin.
Chọn **trigger thay ACL cột** để màn Danh mục hiện tại không gãy (P1 mục 4).

**Bài học bắt được trên TEST, trước khi áp:** bản đầu của hàm guard KHÔNG `SECURITY DEFINER` ⇒ chạy trong
phiên của người dùng, mà `authenticated` không có USAGE schema `app_private` ⇒ **guard chặn nhầm cả chủ**
(42501 "permission denied for schema app_private"). Sửa: `SECURITY DEFINER` + bỏ lối vòng theo
`current_user` (trong hàm definer nó luôn là chủ hàm). Thử lại: chủ sửa được, thành viên thường bị 42501
đúng thông báo. **Đây chính là loại lỗi mà chạy thử trên TEST kèm thử hành vi tồn tại để bắt.**

**Đã áp:** backup `ihomecrm-full-2026-09-26T11-39-49-880Z.dump` (sha256 `a55500a6ce0b1ebf…`) → áp 4s →
catalog `35e360fe… → ce4b01d1…`, capture "không object hở". Kiểm đọc thật: 2 cột có; **9 ánh xạ × 2 org**
(iHome CRM và Demo độc lập); trigger có mặt. Bằng chứng:
`docs/generated/schema-change-evidence/20260926113435_anh_xa_hang_muc_va_khoa_cot_luat.json`.

- **Nghiệm thu:** INV-4 + bộ test JWT/REST của §4.8 mục 5.
- **Rủi ro:** `a01_reservation_type_guard` có thể chặn `55000` khi đổi cột trên type đã dùng cho bỏ cọc —
  xử bằng đường khác, **không disable guard vùng thanh lý**.

### G4 — Giao thức cam kết, áp cho **MỌI** writer tiêu bucket

> v1 định nối writer lần lượt. Audit (C2) bác: cửa mới tiêu đủ cam kết rồi **cron cũ vẫn APPROVED theo
> `repeat_auto_approve`**; và `generate_special_fees_v1` là writer tự duyệt riêng **không nằm trong 5 cửa**
> của v1. Writer đứng ngoài giao thức = tổng không kiểm được.

- **Mục tiêu:** mọi writer có thể tiêu một bucket đều **lấy khoá và ghi HOLD/DRAW/RELEASE** — kể cả khi bucket
  đó chưa bật chính sách mới. Ghi sổ tiêu trước, đổi quyết định sau.
- **Tập writer bắt buộc:** `create_income_expense_v1` · `ie_compat_insert_v2` · `pay_period_fee` ·
  `pay_utility_bill` · **`generate_special_fees_v1`** · bộ sinh định kỳ · **mọi transition đổi tiêu thụ**
  (duyệt, huỷ, đảo, restore, sửa phiếu đổi bucket).
- **Nghiệm thu — gate đồng thời, không được bỏ mục nào:** tạo–tạo · tạo–duyệt · tạo–sửa · huỷ/restore ·
  đa tháng/đa item · hai key nghiệp vụ khác nhau và giống nhau · lỗi giữa quyết định và posting · cập nhật
  luật và rollback **trong lúc đang có phiếu chờ**. **Property test hàm thuần KHÔNG chứng minh các bất biến
  này** — phải là test concurrency thật.
- **Đường lùi:** cờ tắt ghi draw; nhưng **nếu đã có HOLD/DRAW thì lùi phải có bước dọn**, không chỉ đổi cờ.

### G5 — Bật theo BUCKET, không theo writer

- **Đơn vị bật:** `(org, toà, hạng mục chuẩn, kỳ)`. Một bucket chỉ bật khi **mọi writer §G4 đã trên giao
  thức** và bucket đó có cam kết/trần hiệu lực.
- **Thứ tự đề xuất:** bắt đầu bằng bucket có **cam kết đã khai đầy đủ và lưu lượng thấp**; nhưng
  ⛔ "0 lưu lượng ⇒ sai không ảnh hưởng ai" **không phải gate an toàn** cho lần dùng đầu tiên — vẫn cần
  fixture TEST đủ biên.
- **Định kỳ:** bóng riêng **30 ngày** (không phải 14) vì nó chạy 01:00 không ai đứng nhìn, và phải phủ ít
  nhất các lần chạy kỳ có ý nghĩa.
- **FROZEN:** "mọi phiếu CHỜ" chỉ an toàn **trong phạm vi birth của writer đã nối**; **không** ngăn các
  đường duyệt cũ. SHADOW sau khi đã có HOLD phải có cách giữ/giải phóng chính xác.
- ⛔ **Không dùng lại cờ `income_expense.posting.v2` / `workflow.v2`.**
- **Đường lùi:** thử rollback **với dữ liệu đã sinh**, không chỉ đổi cờ.

### G6 — Sổ chi theo danh sách, quyền **CHI**

> Audit (P2): `receiving_cashbook_ids_v1` lọc bằng possession của **THU** (nhận CUSTODIAN **hoặc KNOWER**).
> Luật sửa phiếu vừa ship cho **CHI** là chủ sổ / CUSTODIAN / OPERATOR, **chỉ THU mới nhận KNOWER**. Dùng
> nguyên helper THU cho cửa chi sẽ **nâng KNOWER thành người chi** và **loại OPERATOR**.

- **Mục tiêu:** cửa chi dùng **tập sổ cấu hình ∩ quyền CHI**, không phải helper THU nguyên xi.
- **Được đụng:** `generate_special_fees_v1`, `pay_period_fee`, `pay_utility_bill` — **chỉ đoạn chọn/validate
  sổ**. Các RPC `pay_*` chưa nhận TM/TK/TT ⇒ phải định nghĩa cách xác định hình thức.
- **Không để `membership NULL` bỏ qua kiểm possession.**
- **Nghiệm thu:** test **trực tiếp RPC** với quyền đúng/sai, không chỉ UI. Cảnh báo 7 ngày ghi mọi ca "lẽ ra
  bị chặn" trước khi chặn.
- ⚠ **G6 và G5 sửa cùng hàm.** Rollback G6 bằng khôi phục nguyên thân theo md5 **sau khi G5 đã bật sẽ gỡ luôn
  phần máy chi**. Phải rollback theo phiên bản/phụ thuộc, hoặc tách thay đổi thành hàm con riêng.

### G7 — Một đường duyệt

> Audit (P8): `approve_voucher` **cũng có** nhánh người lập tự duyệt (baseline `schema.sql:46368`).
> `pay_draft_fee_voucher` gọi **`approve_voucher`**, không phải v1 — v1 ghi sai. Và wrapper mới
> `approve_pending_income_expense_checked_v1` (ship 25/09) **rẽ sang cả hai**, kèm CAS/version; FE revisions
> gọi wrapper. Danh sách 3 caller của v1 **thiếu wrapper này**.

- **Mục tiêu:** đóng nhánh tự duyệt ở **cả hai** hàm; mọi đường duyệt qua lõi V2.
- **Bắt buộc trước khi sửa:** **ma trận caller/callee/fallback đầy đủ** — không dựa vào grep.
- **Test:** người lập không có quyền duyệt · người lập **có** quyền duyệt (nếu chủ chọn bỏ self-approval) ·
  CAS · engine request · cặp phiếu bỏ cọc.
- ⛔ Không mở rộng sửa vùng thanh lý chỉ vì một wrapper có nhánh chuyên trách.

### G8 — Dọn đường cũ

- **Chuyển caller TRƯỚC khi bỏ compat.** Còn gọi `ie_compat_insert_v2`: `batch.ts:107`, `batch.ts:206`,
  fallback `mutations.ts:136`, và Copilot. Phải có adapter/đích thay thế và triển khai client **trước**
  REVOKE/DROP.
- ~~REVOKE `record_invoice_payment_v4`~~ — **đã xong**, ACL `{postgres=X/postgres}`.
- **Gate chống tái phát:** inventory writer ở DB + ACL/guard runtime + **test đột biến âm tính**. Quét tĩnh
  chỉ là một lớp — compat đặt status vào JSON rồi INSERT qua `jsonb_populate_record`, quét chuỗi không bắt được.
- Sửa `docs/he-thong/08-thu-chi-so-quy.md` §4.2/§5.1 và `20-phe-duyet-tai-chinh.md`.
- **Sửa entry point superplan** — xem §9.

---

## 7. Gate, rollback, bằng chứng

### 7.1. Giữ xanh suốt

`gate:reconcile-money` + `-v2` (chạy tay) · `gate:ie-guard-gates` · `check-money-table-dml` ·
`check-definer-acl` · `security-gates`.

### 7.2. Sửa hai câu sai của v1

- **§7.3 v1 nói "phải DISABLE TRIGGER"** — audit bác đúng: **không nên là hướng dẫn chung**. Ưu tiên không
  đụng lịch sử ngoài phạm vi; liệt kê đúng trigger **từng bảng**; chỉ đánh giá bypass nếu thực sự cần và có
  review. **Cột mới trên `income_expense_types` không tự đụng khoá tháng của `income_expenses`.**
- **R8 v1 nói lane "chắc chắn" chặn agent** — không có bằng chứng trong gói. Contract §4 chỉ nói **đường bỏ
  backup** cần promotion token; lane mặc định có backup. v2 hạ xuống: *"chưa đo; dù ai apply, giai đoạn audit
  tuyệt đối không apply"*.

### 7.3. Vẫn đúng và giữ

Mỗi migration ghim `md5(pg_get_functiondef)` hàm nó thay · **mỗi PR liệt kê trigger cùng bảng nó chạy chung**
(án lệ 25/09: sửa `type` làm kẹt cả dãy mã phiếu do trigger-index không ai lường) · một giai đoạn = một
worktree = một PR · bằng chứng reconcile trước/sau là mục bắt buộc.

---

## 8. Rủi ro — thêm 7 mục audit chỉ ra

Giữ R1–R10 của v1 với hai sửa (R6 lên **trung bình**; R8 hạ xuống "chưa đo"), thêm:

| # | Rủi ro | Giảm thiểu |
|---|---|---|
| **R11** | Canonical/mapping trỏ **cross-org** | FK composite cùng org; nghiệm thu INV-4 theo org |
| **R12** | Phiếu **đa hạng mục / đa kỳ** không có luật tổng hợp | §4.4 facts theo dòng; một dòng CHỜ ⇒ cả phiếu CHỜ |
| **R13** | **G1 đổi hành vi live** | bảng cam kết **mới**, writer không đọc (§6 G1) |
| **R14** | **Rollback G6 gỡ luôn phần G5** (cùng hàm) | tách thay đổi thành hàm con, rollback theo phụ thuộc |
| **R15** | **Luật bị sửa sau khi quyết định** ⇒ không chứng minh lại được | provenance §4.5: rule/commitment/ceiling version + facts snapshot |
| **R16** | **Caller duyệt mới** (wrapper 25/09) bị bỏ sót ở G7 | ma trận caller bắt buộc trước khi sửa |
| **R17** | **Mixed rollout**: bucket đã bật nhưng một writer còn ngoài giao thức | G5 bật theo bucket **sau** khi G4 phủ **mọi** writer |

---

## 9. Quan hệ với plan cũ và superplan

Bảng đính chính plan 23/09: **giữ nguyên như v1** (banner đã gắn ở đầu file đó).

**P10 — việc mới, phải làm TRƯỚC G1:** banner ở plan cũ đủ với người đọc cả file, nhưng **superplan vẫn là
entry point đang chỉ đạo bản cũ**:

- `SUPERPLAN-TOI-UU-NGHIEP-VU-2026-09-23.md` dòng 26: **N6 gọi G1b**, trong đó có sửa luật huỷ — **trái Đ5**.
- Bảng đợt dòng 136–144 còn liệt kê G0/G1a/G1b/khoá khe/T9.
- `superplan-2026-09/T-tai-chinh.md` cũng trỏ các bước cũ.

Phải sửa các entry point này về bản được duyệt, đánh dấu §5 plan cũ là **lưu trữ/không thi hành**, và ghi rõ
mục nào **chỉ kế thừa kỷ luật** (§0, §4.2, §4.4, §7 của bản cũ). Không kế thừa chẩn đoán đã sai
(vd `initial_amount` chưa có phase xử lý). Giữ bản audit/archive cũ nguyên vẹn.

---

## 10. Quyết định của chủ — **đã chốt đủ 12 câu ngày 26/09**

Chủ trả lời qua trao đổi trực tiếp 26/09/2026. Bảng này là **nguồn luật** cho mọi giai đoạn; giai đoạn nào
đi lệch bảng này là sai phạm vi.

| # | Câu | **Chốt** |
|---|---|---|
| **01** | Ai khai cam kết; toà nào có nghĩa vụ tiền nhà | **Chủ tự nhập/duyệt.** Luật xác định tập toà: *"tiền nhà nào không có là căn đó không thuê lại"* ⇒ **15 toà đi thuê** (44TL có dòng nhưng bỏ trống ⇒ không thuê). **107 dòng đã khai còn đúng tới hôm nay.** Sinh cam kết **từ tháng 10/2026** |
| **02** | Ai sửa cột luật / cam kết | **Chủ công ty + super admin** |
| **03** | Trần điện nước, 4 cặp còn thiếu | **Khai đủ trước khi bật B5** cho cặp đó. Mức = cao nhất 3 tháng gần nhất + ~20% |
| **04** | Ngưỡng 600.000đ cho nhóm TỪNG_PHIẾU | **Giữ** |
| **05** | Người có quyền duyệt tự duyệt phiếu mình | **Giữ nguyên, không thêm thao tác nào** — chỉ **ghi dấu vết** *"Tự duyệt — người lập có quyền duyệt"* lên phiếu để lọc và đếm được. *(Đề xuất "bỏ" của bản v2 đã rút: bỏ hẳn thì chủ tự kẹt, vì không có ai trên chủ để duyệt.)* |
| **06** | Danh sách nguồn khỏi cần duyệt (B0) | **Duyệt nguyên danh sách 18 nguồn** ở §4.6 / bảng dưới |
| **07** | B1/B2 với phiếu THU và non-cash | **KHÔNG đụng phiếu THU.** B2 bỏ hẳn, B1 thu hẹp còn CHI — xem §4.3 |
| **08** | Ngữ nghĩa cam kết | **(a) Ký từng tháng.** **(b) Trả nhiều đợt trong tháng: được.** **(c) Trả trước: được, và kỳ lấy theo _kỳ áp dụng của dòng hạng mục_ trên phiếu, KHÔNG lấy ngày phiếu** |
| **09** | Giữ chỗ cho phiếu chờ duyệt | **CÓ.** Nguyên văn: *"phiếu chờ duyệt là coi như đã có phiếu rồi, không được có phiếu thứ 2"* |
| **10** | Chi vượt cam kết | **Phương án A**: vượt ⇒ **chờ duyệt**; duyệt được nhưng ghi nhận "đã chi vượt" + lý do; **cam kết KHÔNG tự nới** |
| **11** | Sửa cam kết khi đã chi | **Không hồi tố** — *"không ảnh hưởng gì tháng đã chi"*. Tháng đã có khoản tiêu thì RPC từ chối sửa |
| **12a** | Mặc định hạng mục mới | **`TUNG_PHIEU`** (chặt nhất) |
| **12b** | `initial_amount` sửa số dư đầu kỳ không cần phiếu | **Để đợt sau**, ghi vào sổ theo dõi |
| *phụ* | Trần mỗi phiếu hay tổng theo kỳ | **Giữ trần mỗi phiếu** (đang chạy đúng). Nhánh tỷ lệ `max_ratio_to_billed` hiện **không kích được** vì caller bỏ tham số `p_billed_to_tenants`; 24 dòng đều không đặt tỷ lệ |

> **Câu 06 và câu phụ được chốt theo lối "chốt toàn bộ"** (chủ duyệt cả gói cuối phiên), không phải trả lời
> từng dòng. Nếu chủ muốn bỏ dòng nào khỏi danh sách B0 thì sửa ở đây trước khi mở G4.

### Danh sách B0 chủ đã duyệt — 18 nguồn, 4 nhóm

Số liệu 90 ngày, org THẬT, đo 26/09.

**A · Thu tiền thật, đã có người bấm và có chứng từ** — thu hoá đơn (657) · đảo lần thu hoá đơn (2) ·
thu tiền đường cũ (84) · thu cọc lúc ký HĐ (239) · phiếu sinh lúc tạo HĐ (62) · thu cọc giữ chỗ (2) ·
khách trả thêm khi thanh lý (1).

**B · Hai người đã xác nhận với nhau** — bàn giao tiền mặt (14 chi + 14 thu, mỗi bên 1,19 tỷ).

**C · Bút toán trên sổ theo dõi, không có tiền thật ra vào** — cấn trừ thanh lý (73 chi, 72/73 sổ ảo) ·
doanh thu thanh lý (72 thu, 69/72 sổ ảo) · cặp bỏ cọc (19 + 19, 19/19 sổ ảo) · bù trừ tiền thuê thanh lý
(2 + 2, 2/2 sổ ảo) · đóng sổ cọc (1 + 1).

**D · Đã qua một bước chốt riêng** — chi lương (3, đã chốt bảng lương) · hoàn cọc giữ chỗ (1, hàm đòi quyền
duyệt + giữ sổ ngay lúc lập) · số cọc nhập lịch sử (3).

**Cố ý ĐỂ NGOÀI** — hoa hồng môi giới (116 chi, **49 đang chờ**, 24 chưa gắn sổ) · trả khách thanh lý
(79 chi, **36 đang chờ**) · điện nước (83, đi kiểu TRẦN) · phí cố định (0, đi kiểu CAM KẾT).

**Danh sách này KHÔNG phủ nhóm lớn nhất:** phiếu **không mang nhãn nguồn** — 666 chi / 2,93 tỷ (58 chờ,
9 không sổ) và 311 thu / 1,26 tỷ. Đó là phiếu lập tay ở trang Thu chi và phiếu định kỳ; chúng đi **luật
thường** (ba kiểu), không vào B0.

## 11. Xử lý từng mục audit

| ID | Mức | Xử lý trong v2 |
|---|---|---|
| **C1** | CHẶN | **Nhận.** §0.1 + §3.3 sửa số; §5 viết lại G3 thành ánh xạ; INV-4 định nghĩa lại theo org. Tác giả đã tự đo lại: THẬT 108 / DEMO 103 / 0 trùng trong org / có UNIQUE per-org |
| **C2** | CHẶN | **Nhận.** §4.7 giao thức cam kết mới (HOLD/DRAW/RELEASE + advisory lock theo bucket + thứ tự khoá + nguyên tử). Gỡ câu "chống trùng miễn phí". G4 áp cho **mọi** writer, G5 bật theo **bucket**. Thêm INV-7 |
| **C3** | CHẶN | **Nhận.** §6 G1 viết lại: **bảng cam kết mới**, writer không đọc; `special_fee_price_versions` không đụng. Tác giả tự xác nhận rule so **BẰNG** |
| **P1** | G3/G4 | **Nhận.** §4.8, gồm cả điểm PostgreSQL cộng quyền bảng+cột. Tiền đề "RLS mở" đã gỡ |
| **P2** | G2 | **Nhận.** §6 G6: tập sổ ∩ quyền **CHI**, không dùng helper THU nguyên xi; cảnh báo rollback chồng G5 |
| **P3** | G3 | **Nhận.** §5 mục 4 (FK composite, fail-safe) + bỏ nghiệm thu parity tuyệt đối |
| **P4** | G4 | **Nhận.** §6 G2: shadow **tại thời điểm sinh**, không job đêm; bỏ nghiệm thu "lệch 0 so luật cũ"; fixture đủ biên |
| **P5** | G4/G5 | **Nhận.** §4.4 facts theo dòng; §4.6 ma trận B0; §4.9 thu hẹp INV-1/2/3 |
| **P6** | G5 điện nước | **Nhận.** §3.3 nêu 4 cặp thiếu; `NO_RULE → CHỜ` ghi rõ là đổi chính sách; §10 câu 03 |
| **P7** | G5 cửa 2–3 | **Nhận.** §4.3 đánh dấu B1/B2 là đổi chính sách kèm số đo; §10 câu 07 |
| **P8** | G7 | **Nhận.** §6 G7: cả `approve_voucher`, sửa `pay_draft_fee_voucher`, thêm wrapper 25/09, đòi ma trận caller |
| **P9** | G8 | **Nhận.** v4 đã REVOKE (bỏ khỏi G8); chuyển caller compat trước khi DROP |
| **P10** | G1 | **Nhận.** §9: sửa entry point superplan trước G1 |
| **Y1** | góp ý | **Nhận.** Gỡ "đã xong"/"chỉ một caller"/"lớn nhất" ở §3.1, §3.2f, §3.3 |
| **Y2** | góp ý | **Nhận.** §7.2 sửa câu DISABLE TRIGGER và câu lane/token |
| **Y3** | góp ý | **Nhận.** §10 câu phụ: trần mỗi phiếu vs tổng kỳ, nhánh tỷ lệ không kích được |

**Phần audit tự khai chưa kiểm** — v2 không coi là đã xong, đưa vào nghiệm thu giai đoạn tương ứng:
thao tác ghi của §4.8 (chỉ xác minh catalog) · fixture chạy writer điện nước · hai gate reconcile ·
lane `migrate:forward` thực tế · con số gộp nhầm 16/10/3 kế thừa từ 23/09.

---

## Phụ lục A — Số đo và câu SQL

Giữ A-1…A-11 của v1 (kết quả ở `docs/audits/2026-09-26-plan-cam-ket-goi-audit/do-nen-26-09.json`), **sửa
A-4** và **thêm A-4b, A-12…A-15** (kết quả trong báo cáo audit và ở lượt tự kiểm của tác giả):

| Mã | Câu | Kết quả |
|---|---|---|
| **A-4** *(sửa)* | `income_expense_types` **group by organization_id** | THẬT `108 / 28 force / 5 user` · DEMO `103 / 28 force / 1 user` |
| **A-4b** *(mới)* | nhóm trùng `(organization_id, lower(btrim(name)), type)` | **0** |
| **A-4c** *(mới)* | unique index trên bảng hạng mục | có `income_expense_types_org_side_normalized_name_uq` |
| **A-12** | policy trên `income_expense_types` | **11 policy**; `income_expense_types_authenticated_all` = **0** (đã DROP) |
| **A-13** | ACL `record_invoice_payment_v4` | `{postgres=X/postgres}` — đã REVOKE |
| **A-14** | `approve_voucher` có nhánh tự duyệt? · `pay_draft_fee_voucher` gọi hàm nào? | **có** · gọi **`approve_voucher`**, không gọi v1 |
| **A-15** | `special_fee_rule_check_v1` so bằng hay ≤? | **so BẰNG** |
| **A-16** | THU không nhãn, 90 ngày, đã duyệt: thiếu sổ / sổ ảo | `293 / 0 thiếu / 1 ảo` |

## Phụ lục B — Vân tay hàm

16 hàm như v1; audit chạy lại **16/16 khớp cả md5 lẫn độ dài**. File:
`docs/audits/2026-09-26-plan-cam-ket-goi-audit/md5-ham-26-09.json`.

## Phụ lục C — Điểm neo trong mã

Giữ C-1…C-10 của v1, **sửa và thêm**:

| # | Khẳng định | Neo |
|---|---|---|
| C-5 *(sửa)* | Nhánh người lập tự duyệt có ở **CẢ HAI** | `approve_income_expense_v1` **và** `approve_voucher` (baseline `schema.sql:46368`) |
| C-11 | Wrapper duyệt mới rẽ sang cả hai, có CAS | `20260925080906_sua_phieu_cho_duyet.sql:1109,1124,1142` |
| C-12 | Trần điện nước được gọi thật | `20260828150000_utility_ceiling_wired_into_pay_bill.sql:218–222` |
| C-13 | Policy hạng mục cũ đã DROP | `20260528000003_rbac_batch_f_drop_legacy.sql:205`; thay bằng `20260528000001…:88–96`; org boundary `20260807163000…:80–83` |
| C-14 | Danh mục đã canonical theo org | `20260728180000_income_expense_type_canonicalization.sql:720–740` |
| C-15 | Guard bảng hạng mục của vùng thanh lý | `20260909172332_reservation_deposit_settlement_v1.sql:625–638` (`a01_reservation_type_guard`) |
| C-16 | v4 đã REVOKE | `20260925083655…:1193–1198` |
| C-17 | Caller compat còn sống | `src/hooks/income-expenses/batch.ts:107,206`; `mutations.ts:136` |

---

## 12. Trạng thái thi hành — cập nhật 26/09/2026 đêm

Chủ uỷ quyền hai lần trong phiên: *"thực hiện chi tiết toàn bộ và đưa toàn bộ lên production"* rồi *"thực hiện
tiếp toàn bộ"*, kèm nhắc: *"quan trọng là thống nhất đường tiền về một máy… đừng lan man, thiếu kiểm soát"*.
Mọi bước dưới đây: thử trên TEST (transaction rồi ROLLBACK) → lane `migrate:forward --apply` (hai lượt ROLLBACK +
backup full + giấy phép) → đọc lại production → hai gate tiền.

| Bước | Trạng thái | Migration · backup · bằng chứng |
|---|---|---|
| G0 chốt 12 câu | **Xong** | §10 |
| **G1** sổ cam kết | **ĐÃ ÁP** | `20260926082454` · `dcca965e…` · 1.272 cam kết (106 khe × 12 tháng) |
| **G3** ánh xạ + khoá cột luật | **ĐÃ ÁP** | `20260926113435` · `a55500a6…` · 9 × 2 ánh xạ |
| ↳ vá hồi quy G3 | **ĐÃ ÁP** | `20260926140000` · `dc533a44…` · guard INVOKER chỉ canh ghi thẳng từ client; TEST trước/sau: `_termination_ensure_type` do quản lý gọi — cũ **chặn 42501**, sau vá được |
| **G2** bộ máy + bóng lúc sinh | **ĐÃ ÁP (SHADOW)** | `20260926150000` · `05389e0e…` · TEST 24/24 ca |
| **G4** sổ tiêu cho MỌI writer | **ĐÃ ÁP** | cùng migration G2 — trigger đồng bộ theo trạng thái, không sửa writer nào; khởi tạo 8 DRAW; audit 0 lệch; câu ghi kiểu PostgREST (CTE) qua được |
| **G5** 5 cửa chi hỏi cổng | **ĐÃ ÁP — cổng chưa áp** | `20260926160000` · `58c6db3f…` · TEST 20/20 + 6/6; md5 6 hàm trên prod trùng bản thử |
| G5 **bật theo bucket** | **CHỜ CHỦ** | cần ≥ 14 ngày bóng (định kỳ 30) — không nén được; công tắc ở màn Cam kết chi |
| **G6** quyền CHI trên sổ | **Cảnh báo (SHADOW)** | helper `ie_spend_cashbook_ok_v1` (chủ sổ/CUSTODIAN/OPERATOR, không KNOWER); cờ `spend.cashbook_chi.v1` = SHADOW; màn đếm ca "không giữ sổ" — bật chặn sau 7 ngày cảnh báo |
| **G7** một đường duyệt | **Dấu vết (câu 05)** | câu 05 giữ tự duyệt cho người có quyền duyệt ⇒ G7 thu về ghi dấu `SELF_APPROVER` + `list_self_approved_vouchers_v1` + thẻ "Tự duyệt" |
| **G8** dọn đường cũ | **Tài liệu xong; compat giữ** | `08`/`20` hệ thống sửa; compat + `create_income_expense_v2` luôn sinh CHỜ nên không lách bộ máy — không gỡ (gỡ đòi viết lại caller giao diện) |
| Màn chủ + RPC trạng thái | **Code xong, chờ lên web** | `20260926170000` · `fcede28d…`; `/settings/finance/cam-ket-chi` (5 thẻ) — kiểm bằng trình duyệt thật với tài khoản chủ |

**Gate tiền sau mỗi lần áp:** `gate:reconcile-money` PASS (A = B = C = 5.788.924.013đ) · `-v2` PASS
(2.688.708.004đ) — **tiền không đổi**. `gate:truoc-push` 44/44 xanh, gồm đo rò dữ liệu xuyên tổ chức.

**Hai lỗi bắt được trong lúc làm, đã sửa trước khi áp:** (1) guard G3 chặn nhầm hàm hệ thống do quản lý gọi —
vá bằng `20260926140000`; (2) sổ bóng tính lại lúc COMMIT làm phiếu sinh sau trong cùng transaction (cron định
kỳ, sinh phí hàng loạt) chấm oan phiếu sinh trước và đè tên writer — sửa bằng cổng chốt kết quả cho từng phiếu
(`z59_spend_capture_gate`) trong `20260926160000`.

**Ba điểm chủ cần xem trong kỳ chạy thử:**
1. **405PVB — công an** cam kết 7.000đ/tháng, chi thật ~750.000đ ⇒ số sót từ lần đóng cũ; màn Cam kết chi tô
   vàng ô này. Sửa trước khi bật `cong_an`.
2. **Quản Lý** đang `force_approval` nhưng kiểu chi là CAM_KET ⇒ khi bật, khoản quản lý trong cam kết sẽ được
   máy duyệt. Muốn giữ bắt buộc duyệt thì đổi kiểu sang "Từng phiếu" ở thẻ Luật hạng mục.
3. **4 cặp trần còn thiếu** (câu 03): `111PVC–nước`, `158PVC–nước`, `15KV–nước`, `Kho Văn Phòng Chung–điện` —
   RPC bật công tắc TRAN tự từ chối khi còn toà thiếu trần.

**Còn lại, không thuộc phiên này:** bật chặn G6 sau 7 ngày cảnh báo; gỡ `fee_type_matches` khỏi lưới trạng thái
`get_period_fee_status` (writer đã dùng ánh xạ); siết compat bỏ `system_source` từ client (hiện chỉ ảnh hưởng sổ bóng).
