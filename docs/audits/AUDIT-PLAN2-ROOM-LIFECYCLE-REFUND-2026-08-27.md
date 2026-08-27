# Audit Plan 2 `room-lifecycle-refund-v2` — đối chiếu kế hoạch với thực tế

**Ngày chốt:** 2026-08-27

**HEAD khi đo:** `a80b70c2e557b72f42e2453b7a4ef45490a378cb`

**Tài liệu bị kiểm:** `docs/superpowers/plans/2026-07-30-room-lifecycle-refund-v2.md` (1.860 dòng, 9 Task, 72 checkbox).

**Đọc kèm:** `docs/superpowers/plans/2026-07-30-danh-gia-2-plan-thu-tien-v2.md` §12-§18 (nhật ký thi hành thật) và `docs/superpowers/plans/2026-07-30-special-payment-governance-v2.md` (Plan 1, cùng mặt cắt `/thanh-toan`).

**Phạm vi:** toàn bộ Task 0 → Task 8 của Plan 2, gồm hai nhánh mà plan gộp chung — hàng đợi Hoàn cọc trên `/thanh-toan` và panel Chu trình phòng trên `/thu-tien`.

**Tính chất:** snapshot audit read-only; không sửa code, migration hay dữ liệu production.

**Vì sao có đợt kiểm này:** chủ đi tìm chức năng "xem vòng đời hợp đồng — biểu đồ cây toàn bộ hợp đồng của một phòng trên trục thời gian". Truy ra chức năng đó chưa từng được viết; nó là Task 6 + Task 7 Step 4 của plan này. Từ đó mở rộng thành kiểm toán toàn plan.

## 1. Kết luận điều hành

Plan có 9 Task. **Task 0 xong gần trọn. Task 4 xong một phần. Task 1, 2, 3, 5 bị thay bằng một kiến trúc giản lược khác hẳn văn bản. Task 6, Task 7 Step 4 và Task 8 chưa làm gì.**

Điểm số trên 26 tiêu chí Definition of Done: **XONG 6 · LỆCH 8 · CHƯA 12**.

Phần **hiển thị tiền cho người dùng** đã được vá tốt và đúng hướng — `/deposits` không còn tuyên bố "Đã hoàn" theo `refund_date`/`COMPLETED`, nhánh số âm đã hiện "Khách còn nợ", nhãn trang chi tiết hợp đồng đã đổi cả hai chỗ. Đây là phần mạnh nhất của đợt thi hành.

Phần **đường ghi tiền mới** thì ngược lại: nó tồn tại, gọi được từ UI, nhưng mang **ba lỗi chặn** chưa nổ chỉ vì production còn 0 nghĩa vụ hoàn cọc. Nghiêm trọng nhất là `system_source` mà writer ghi ra không khớp vị ngữ của bất kỳ màn đọc nào — nghĩa là lần đầu ai đó bấm nút thật, tiền sẽ ra khỏi két trong khi mọi màn báo cáo vẫn nói chưa hoàn.

Phần **đường ghi tiền cũ** vẫn nguyên vẹn: bốn writer thanh lý còn mở cho `authenticated`, hai trong số đó vẫn nuốt lỗi audit bằng `RAISE WARNING`, và `approve_contract_termination_v1` vẫn tính tiền từ cột GENERATED. Việc khoá đường cũ là **cố ý chưa làm** (§17.6 của tài liệu đánh giá), với điều kiện gỡ chặn đặt ra từ 31/07 và **đến nay vẫn chưa đạt**.

Ngoài ra tài liệu đang tự mâu thuẫn ở ba chỗ, và 72 checkbox của plan **không cái nào được tick** dù nhiều phần đã lên production.

## 2. Phạm vi, phương pháp và mức tin cậy

### 2.1. Nguồn đã dùng

1. Toàn bộ `supabase/migrations/` và `supabase/baseline/schema.sql` trong repo tại HEAD trên.
2. Code frontend `src/` — hook, component, trang liên quan hoàn cọc / thanh lý / cọc.
3. Database production `tryymsxyyckgbrmmvozx` qua Supabase Management API, **chỉ `SELECT`**: `pg_proc`, `pg_indexes`, `pg_publication_tables`, `information_schema`, và đếm hàng trên bảng nghiệp vụ.
4. Nhật ký thi hành ở `danh-gia-2-plan-thu-tien-v2.md` §12-§18.

Mọi số dòng trích trong tài liệu này đã được mở ra đọc lại từng dòng một, không lấy từ trí nhớ hay từ báo cáo trung gian.

### 2.2. Bẫy phương pháp đã dính, ghi lại để không lặp

**Sổ migration không dùng được để tra trạng thái.** `supabase_migrations.schema_migrations` dừng ở `20260727095000` và không ghi nhận gì từ 28/07 trở đi, dù repo có migration tới tận tháng 8. Ai tra bảng đó sẽ kết luận sai rằng cả loạt migration tháng 8 chưa apply. Phải kiểm object thật bằng `pg_proc` / `information_schema`.

**`docs/generated/rpc-surface.md` không phải catalog production.** Nó là bản đồ **RPC được client gọi**. Một hàm vắng mặt ở đó chỉ có nghĩa không màn nào gọi nó, không nói gì về việc đã apply lên prod hay chưa. Trong đợt này đã suy sai một lần theo hướng đó rồi phải đính chính bằng `pg_proc`.

**Chuỗi tiếng Việt có dấu trong `curl -d` JSON bị hỏng mã**, làm `LIKE` trả 0 hàng một cách im lặng — dễ đọc thành "không có dữ liệu". Dùng `chr()` ghép hoặc mẫu không dấu.

### 2.3. Giới hạn của chính đợt audit này

- Không chạy được đường ghi tiền mới với dữ liệu thật: `preview_termination_refund_v1` đòi phiên đăng nhập thật (ném `42501 'Bạn không thuộc tổ chức này'` khi gọi qua Management API). Mọi kết luận về writer là **đọc mã** — mã trên đĩa **và** `prosrc` của hàm đang chạy trên prod — chứ không phải chạy thử.
- Không kiểm bằng trình duyệt trong đợt này; các phán quyết về UI dựa trên đọc code.
- Một số tiêu chí DoD ở tầng SQL sâu chỉ phán được "chưa kiểm được", không phán "đạt".

## 3. Bảng trạng thái theo Task

| Task | Nội dung | Trạng thái |
|---|---|---|
| **0** | Khoá audit chuyển phòng + residence segments | **XONG** — trừ Step 0.1/0.6 (script test không tồn tại) |
| **1** | Settlement snapshot + obligation ledger bất biến | **LỆCH nặng** — bảng `termination_settlement_snapshots` chưa từng được viết; obligation chỉ 16 cột, không state machine, không hash, không idempotency |
| **2** | Canonicalize 3-4 termination writer | **CHƯA** — không migration nào tồn tại; writer cũ nguyên vẹn |
| **3** | Legacy correlation + signed deposit basis | **LỆCH** — `resolve_signed_contract_deposit_basis_v1` có và được dùng; backfill/report thì không |
| **4** | Queue / preview / status reads + ô KPI | **LỆCH** — `get_refund_forfeit_summary` đã redefine đúng nguyên tắc; 3 RPC còn lại không tồn tại, UI đọc thẳng bảng qua RLS |
| **5** | Exact refund writer trên trang đóng tiền | **LỆCH có chủ ý** — thay bằng writer giản lược, phiếu ra CHỜ DUYỆT |
| **6** | Room lifecycle read model | **CHƯA — 0%** |
| **7** | Hooks và UI | Step 5(a,c,d) **XONG** · Step 1,2,3 **LỆCH** · Step 4 **CHƯA** |
| **8** | Verification, rollout, rollback | **CHƯA** — 0/6 script, 0 runbook, 0 feature route |

### 3.1. Đánh số migration: không tên nào của plan tồn tại

§2.1 của plan (dòng 405-455) liệt kê 10 tên file. Đối chiếu đĩa:

| Tên plan dự kiến | Thực tế |
|---|---|
| `20260731010500_contract_transfer_audit_hardening.sql` | ship dưới tên `20260731050000_...` |
| `20260731011000_room_residence_segments.sql` | ship dưới tên `20260731051000_...`; timestamp gốc bị `slice_minus1_guards.sql` chiếm |
| `20260731030000_termination_settlement_snapshot.sql` | **chưa từng được viết**; timestamp bị `voucher_slot_warning.sql` chiếm |
| `20260731031000_termination_refund_obligations.sql` | thay bằng `20260731090000_termination_refund_obligation.sql` (số ít, giản lược) |
| `20260731031500_termination_writer_canonicalization.sql` | **không tồn tại** |
| `20260731032000_termination_refund_read_rpcs.sql` | **không tồn tại** |
| `20260731032200_realtime_termination_tables.sql` | ship dưới tên `20260731060000_realtime_lifecycle_tables.sql` (đúng nội dung) |
| `20260731032500_room_lifecycle_read_rpc.sql` | **không tồn tại** |
| `20260731033000_termination_lifecycle_backfill.sql` | **không tồn tại** |
| `20260731034000_termination_refund_special_writer.sql` | thay bằng `20260731100000_termination_refund_writer.sql` (giản lược) |

Hệ quả vận hành: **kịch bản rehearsal ở Task 8 Step 1 hiện không chạy được**, vì nó gọi tên file theo danh sách trên.

`danh-gia-2-plan-thu-tien-v2.md:1487-1494` (§16.2) tự khai đây là "điểm rẽ kiến trúc, có chủ ý, khác plan gốc". Phần lớn "CHƯA" trong tài liệu này là chủ ý, không phải bỏ sót — nhưng vẫn là lệch so với văn bản, và văn bản chưa được cập nhật.

## 4. Finding

### F1 (P1, MỚI) — `system_source` của đường hoàn mới là chuỗi mồ côi

`create_termination_refund_voucher_v1` ghi `'termination.refund.v2'` tại `supabase/migrations/20260731100000_termination_refund_writer.sql:143`. Đã đối chiếu `prosrc` của hàm đang chạy trên production — khớp, không phải chỉ trên đĩa.

Mọi nơi đọc lại đều lọc **bằng đúng** `'termination.refund'`:

| Nơi đọc | Vị ngữ | Thấy `.v2`? |
|---|---|---|
| `get_refund_forfeit_summary` (ô KPI `/deposits`) | `ie.system_source = 'termination.refund'` | không |
| `src/hooks/useDepositDashboard.ts:228`, `:454` | `.eq('system_source', TERMINATION_REFUND_SOURCE)` | không |
| `src/hooks/contracts/useContractDetailData.ts:166` | `.eq("system_source", TERMINATION_REFUND_SOURCE)` | không |
| `src/lib/voucherSources.ts:38`, `:58` | tra khoá chính xác, fallback `"Nhập tay"` | không |
| `src/hooks/useThanhToanLedgers.ts:72` | `.like('system_source', 'termination.refund%')` | **có** |

**Tác động nghiệp vụ:** lần đầu ai đó bấm nút hoàn cọc thật, phiếu chi được tạo và có thể được duyệt cho tiền ra khỏi két, nhưng ô "Đã hoàn cọc" trên `/deposits` **không cộng**, trang chi tiết hợp đồng **vẫn nói chưa hoàn**, và `/thu-chi` hiển thị nguồn phiếu là **"Nhập tay"** thay vì "Hoàn khách thanh lý (tiền thật)". Chỉ hàng đợi `/thanh-toan` nhìn thấy nó, vì nó là chỗ duy nhất dùng `like` thay vì `=`.

**Vì sao chưa nổ:** production hiện có **0 phiếu `termination.refund.v2`** (đã đếm). Đường mới chưa từng chạy thật.

Đây đúng khuôn lỗi mà `danh-gia-2-plan-thu-tien-v2.md` §16.5 mục 2 đã ghi thành án lệ: "thêm một trạng thái mới mà quên rà mọi nơi đang lọc theo trạng thái cũ".

**Khuyến nghị:** đổi writer ghi `'termination.refund'` cho khớp mọi reader sẵn có. Cách thay thế — thêm `.v2` vào `VOUCHER_SOURCES` **và** nới cả ba vị ngữ `=` thành prefix — đúng về lý nhưng chạm nhiều bề mặt hơn và để lại hai chuỗi cùng nghĩa.

### F2 (P1, ĐÃ BÁO 13/08, CHƯA VÁ) — không có gì chặn hai phiếu hoàn cho cùng một hồ sơ

`AUDIT-TIEN-HOA-DON-THU-CHI-THANH-TOAN-2026-08-13.md` đã ghi: "obligation hoàn cọc lưu fingerprint nhưng không kiểm lại, cho phép nhiều version cùng một termination và index chống trùng hiện không chặn nhiều voucher sống giữa các version". Đo lại hôm nay: **vẫn nguyên**.

Cơ chế cụ thể:

- `record_termination_refund_obligation_v1` tăng `version` vô hạn, mỗi version một dòng riêng.
- `create_termination_refund_voucher_v1` chỉ kiểm `voucher_id IS NULL` **trên chính dòng obligation đó**.
- Index mang tên bảo vệ là `ux_tro_voucher`, định nghĩa thật đọc từ `pg_indexes` trên prod: `UNIQUE (organization_id, id) WHERE voucher_id IS NOT NULL`. Vì `id` đã là PRIMARY KEY, **index này không ràng buộc gì cả** — nó chỉ tạo cảm giác an toàn.

Gọi record hai lần rồi create hai lần ⇒ hai phiếu chi cùng số tiền, cùng hợp đồng, không lỗi.

**Khuyến nghị:** `UNIQUE (organization_id, termination_id) WHERE voucher_id IS NOT NULL`.

### F3 (P1, MỚI) — không kiểm hồ sơ đã duyệt trước khi sinh phiếu

`create_termination_refund_voucher_v1` không đọc `contract_terminations.status` ở bất kỳ đâu. Một hồ sơ `DRAFT` hoặc `PENDING_APPROVAL` vẫn record được nghĩa vụ và vẫn sinh được phiếu chi.

Plan Task 2 Step 8 nêu đích danh hai hợp đồng `8b564ddf`, `f7affb2a` làm fixture cho đúng ca này.

### F4 (P2, MỚI) — cảnh báo mù với phiếu đã duyệt mà chưa vào sổ

`src/hooks/contracts/useContractDetailData.ts:109` lọc `.eq("approval_status", "UNAPPROVED")`. Trên production có **3 phiếu `termination.refund` ở trạng thái `APPROVED` nhưng `posting_status = NOT_APPLICABLE`, tổng 9.515.634đ**.

`/deposits` xử lý đúng — không tính chúng là đã hoàn, vì đòi `POSTED` + `active_posting_id_v2`. Nhưng cảnh báo "Phiếu thanh lý chờ xử lý" trên trang hợp đồng cũng không thấy chúng. **Không màn nào nhắc.**

Cùng họ với khuyến nghị dòng 362 của audit 13/08: mọi nhãn "đã trả/đã chi" phải dùng `posting_status=POSTED && active_posting_id_v2 != null`, và `APPROVED+UNPOSTED` phải hiện "Đã duyệt - Chưa chi".

### F5 (P2, MỚI) — toà/phòng của phiếu hoàn suy từ phòng HIỆN TẠI

`supabase/migrations/20260731100000_termination_refund_writer.sql:82` lấy `rooms.building_id` của `contracts.room_id` hiện tại. `src/hooks/useDepositDashboard.ts:432-442` cũng join phòng hiện tại, không dùng snapshot.

Plan cấm đích danh (Task 1 Step 1b, Task 4 Step 3: "không join `contracts.room_id` hiện tại để gán lịch sử"). Hợp đồng đã chuyển phòng ⇒ dòng tiền ghi vào toà cuối chứ không phải nơi phát sinh cọc; lọc theo toà nhà sẽ đặt nhầm chỗ hoặc giấu dòng.

Trớ trêu: `get_room_residence_segments_v1` (Task 0, **đã có trên production**) trả lời đúng câu hỏi này nhưng không client nào gọi.

### F6 (P1, CỐ Ý CHƯA LÀM) — đường thanh lý cũ vẫn mở và vẫn nuốt lỗi audit

- `terminate_contract_move_out`, `terminate_contract_forfeit` và hai biến thể `_with_credit_v1` đều còn `EXECUTE` cho `authenticated` (kiểm bằng `has_function_privilege` trên prod). Plan Task 2 Step 4(ii) đòi REVOKE route giữa, chỉ để wrapper gọi.
- `terminate_contract_move_out_impl` bản mới nhất `supabase/migrations/20260822093000_termination_customer_refund_items.sql:381` vẫn bọc audit trong `EXCEPTION WHEN OTHERS THEN RAISE WARNING`. `terminate_contract_forfeit_impl` y hệt trong baseline.
- `approve_contract_termination_v1` vẫn `v_refund := coalesce(v_term.refund_amount,0)` (cột GENERATED), vẫn set `status='COMPLETED', refund_date = now()` **trước** khi tạo phiếu, và INSERT **không có cột `system_source`**.

**Tác động:** hôm nay vẫn có thể thanh lý xong, tiền đã đi, mà không một dòng `contract_terminations` nào tồn tại — đúng lớp lỗi sinh ra tình trạng "phiếu hoàn không correlate được" mà chính plan trích dẫn làm động cơ. Task 0 đã sửa đúng lỗi này cho `contract_transfers`; hai writer tiền thì chưa.

**Ghi rõ:** đây là việc **cố ý chưa làm**, có lý do chính đáng ghi ở `danh-gia-2-plan-thu-tien-v2.md` §16.8 và §17.6 — đường hoàn cọc mới chưa từng chạy với dữ liệu thật, khoá đường cũ trước sẽ đẩy mọi ca thanh lý sang đường chưa ai kiểm. Điều kiện gỡ chặn: dựng spec E2E chạy trọn thanh lý → nghĩa vụ → phiếu hoàn trên DEMO. **Điều kiện đó đặt ra 31/07 và đến 27/08 vẫn chưa đạt.**

### F7 (P2) — ba màn nói ba số cho cùng một hồ sơ

`refund_amount` là cột GENERATED. Plan §0.1 và DoD tuyên bố nó "không còn là payable truth ở bất kỳ đâu". Thực tế: `/deposits` và trang chi tiết hợp đồng đã bỏ, nhưng `src/hooks/useThanhToanLedgers.ts:98` vẫn dùng nó làm `refundAmount`, và `src/components/thu-tien/SettlementPanels.tsx:30` vẫn lọc `refundAmount > 0` để xếp hàng đợi.

### F8 (P2) — hàng đợi hoàn cọc dính cap-1000, không chunk

`src/hooks/useThanhToanLedgers.ts:48-59` truy vấn `contract_terminations` không phân trang; `:71` `.in('contract_id', contractIds)` không chia lô ≤500 như plan đòi. Kỳ nhiều thanh lý ⇒ hàng đợi **im lặng thiếu dòng**, không lỗi, không cảnh báo. Đúng lớp fail-open mà plan Task 7 Step 2 cấm.

### F9 (P2) — không có feature route nào trên đường hoàn mới

Đường refund mới không đọc `evaluate_feature_route`. Không SHADOW, không CANARY, không OFF, không freeze; `set_feature_freeze_v1` không tồn tại. Nếu writer tính sai thì cách duy nhất để dừng là deploy.

`danh-gia-2-plan-thu-tien-v2.md:1490-1494` giải thích lựa chọn này: vì phiếu ra `UNAPPROVED` chứ không tự vào sổ, người duyệt chính là cổng. Lập luận hợp lý cho rủi ro **tiền tự động chạy**, nhưng không phủ rủi ro **tính sai số** — phiếu sai số vẫn được duyệt bởi người tin vào số hệ thống đưa.

### F10 (P3) — quyền lỏng hơn plan

- `preview_termination_refund_v1` là SECURITY DEFINER và chỉ kiểm membership tổ chức (`organization_memberships` + `is_super_admin()`), **không kiểm toà, không kiểm permission**. Mọi thành viên đọc được số cọc/số hoàn của mọi hồ sơ trong tổ chức, kể cả toà ngoài phạm vi được gán.
- `create_termination_refund_voucher_v1` chỉ đòi tầm nhìn toà (`can_access_building` / `ie_all_buildings_scope` / `is_admin`), **không** đòi quyền tạo phiếu chi (`thu_tien.collect` / `income_expenses.create`).
- Plan Task 4 Step 4 đòi ba permission khác nhau cho ba bề mặt.

### F11 (P3) — thứ tự khoá bị đảo âm thầm khi vá "nhận cả id hợp đồng"

Bản Đợt 7 khoá hồ sơ **trước** khi chụp cơ sở cọc: `supabase/migrations/20260731090000_termination_refund_obligation.sql:181` là `PERFORM 1 FROM contract_terminations WHERE id = p_termination_id FOR UPDATE;`, rồi `:186` mới gọi `preview_termination_refund_v1`. Chú thích `:216` nói rõ chủ ý: "Khoá hồ sơ FOR UPDATE trước khi chụp cơ sở để cơ sở đứng yên."

Bản vá `supabase/migrations/20260731110000_refund_preview_accept_contract.sql` đảo ngược: `:96` gọi `preview_...` **trước**, `:101` mới `FOR UPDATE`. Không comment nào ghi nhận invariant đã mất.

Đã xác nhận **bản đảo là bản đang chạy trên production**: trong `prosrc` của `record_termination_refund_obligation_v1`, chuỗi `preview_term` ở vị trí ký tự 201 còn `FOR UPDATE` ở vị trí 451.

**Cửa sổ race:** hồ sơ đổi số giữa lúc preview và lúc INSERT ⇒ obligation lưu `basis_fingerprint` của một trạng thái đã trôi.

## 5. Chỗ nghi mà kiểm ra KHÔNG phải lỗi

Ghi lại để không ai đi lại đường này:

- **Quy tắc `refund_done` trên `/deposits` đã sửa đúng.** Hiện là phiếu `termination.refund` + `APPROVED` + `POSTED` + có `active_posting_id_v2` (`src/hooks/useDepositDashboard.ts:454-457`); `refund_date` và `status='COMPLETED'` đã bị bỏ hẳn khỏi truy vấn, có chú thích lý do ở `:207-223` và `:423`. Điều này quan trọng vì prod có 52 hồ sơ `COMPLETED` cả 52 và 0 hồ sơ có `refund_date` — nếu quy tắc cũ còn thì trang đã báo "Đã hoàn" cho toàn bộ 52.
- **Nhánh số âm đã sửa.** `stillOwed` tính ở `src/pages/deposits/DepositsPage.tsx:691` và dùng cho cả hai nhánh: `:727` "Khách nợ", `:759` "Khách còn nợ". Hết clamp `Math.max(0, …)` ở nhánh REFUND. Đúng lúc: prod có 17 hồ sơ `refund_amount < 0`.
- **Nhãn trang chi tiết hợp đồng đã đổi cả hai chỗ**: `src/components/contracts/detail/ContractSummary.tsx:112` là "Net quyết toán (hồ sơ, lịch sử):" và `:236` là "Đã thu (còn đang giữ):". Hết cảnh "Đã thu 0đ" đứng cạnh "Hoàn lại khách 2.428.500đ".
- **`get_room_residence_segments_v1` CÓ cổng quyền**, ngay trong CTE đầu: `can_access_building` / `ie_all_buildings_scope` / `is_admin` / `is_super_admin`. Khác tên hàm so với phụ lục 01/08 đòi (`building_org_visible_v1`) nhưng tương đương về hiệu lực. **Không phải lỗ hổng.**
- **Fail-closed ở tầng query là cố ý, đừng "tối ưu" đi.** `src/hooks/useDepositDashboard.ts:466-470` và `src/hooks/contracts/useContractDetailData.ts:174-176` đều `throw` khi không đọc được phiếu, thay vì hiện "chưa có phiếu hoàn". Đó đúng là lối plan đòi — chỉ là thực hiện ở tầng query chứ không phải tầng chunk. Đừng đổi thành `?? []`.

## 6. Còn hở — plan coi là bắt buộc

| Hở | Mức |
|---|---|
| **Toàn bộ Task 6** + panel "Chu trình phòng" trên `/thu-tien` — chặn Task 7/8 theo chính BLOCKED-BY của plan | Cao |
| 4 query key realtime (`period-fee-status`, `period-commissions`, `period-maintenance`, `fee-accounts`) + 2 bảng `building_fee_accounts`/`building_utility_accounts` chưa vào `SYNC_TABLES` | Cao |
| 5 named termination wrapper + routing ownership-first — 0/5 | Cao |
| 6 script gate (`test-room-lifecycle.mjs`, `audit-room-lifecycle-rollout.mjs`, `test-contract-transfer-segments.mjs`, `test-termination-obligations.mjs`, `test-termination-refund-reads.mjs`, `test-termination-refund-special-page.mjs`) — **0/6**; khối lệnh §5 của plan chạy hôm nay sẽ gãy 6 dòng | Cao |
| 2/3 spec e2e (`room-lifecycle.spec.ts`, `deposit-refund-status.spec.ts`) — không gate nào bảo vệ hai bất biến tiền vừa sửa | Cao |
| Thư mục `docs/superpowers/runbooks/` **không tồn tại** ⇒ không có runbook rollout/rollback | Cao |
| Bug singleton `hubActive` trong `src/hooks/useRealtimeDataSync.ts:126` chưa ref-count | Trung bình |
| `.e2e-fleet/tsconfig.json` + `typecheck:e2e` — vùng mù type còn nguyên | Trung bình |
| `IncomeExpenseForm.tsx` chưa disable amount/items cho phiếu owned | Trung bình |
| ~~Fixture chỉ phủ 2/5 ca regression~~ **ĐÍNH CHÍNH 28/08: SAI — đọc lại  thì cả 5 ca (a)–(e) đều đã phủ** (drift −978.500, drift +500.000, UNAPPROVED không tính, 3 phiếu DEMO 50/40/30k, net âm). Phán quyết gốc lấy từ báo cáo trung gian chưa tự kiểm. | — |

Mọi "8/8", "12/12" trong nhật ký §14 là phép kiểm chạy tay qua Management API rồi ghi vào tài liệu — **không tái chạy được, không vào CI**.

## 7. Tài liệu tự mâu thuẫn

1. **Ô KPI `/deposits`.** DoD §7 đòi KPI khớp tổng cột bảng (4.302.000đ). Chủ quyết ngày 30/07 lấy tiền thật đã ra két gồm cả phiếu mồ côi (28.039.100đ), lý do: lấy phần nối được hồ sơ là khai **thiếu** 23.737.100đ tiền đã chi thật. Code theo quyết định của chủ và có dòng cảnh báo đối chiếu; plan thì chưa cập nhật. Nguồn: `danh-gia-2-plan-thu-tien-v2.md:117-136`.
2. **`docs/he-thong/realtime-sync.md:32-33`** vẫn liệt kê `contract_terminations` trong danh sách "Chưa có realtime", trong khi bảng này đã vào publication và `SYNC_TABLES` từ `20260731060000` (đã xác minh `pg_publication_tables` trên prod). Tài liệu nói ngược code.
3. **Task 8 Step 1** liệt kê 10 tên migration, không tên nào tồn tại — xem §3.1.
4. **72 checkbox của plan, 0 cái được tick** dù nhiều phần đã lên production.

## 8. Số đo production (27/08/2026)

| Số đo | Giá trị |
|---|---|
| `termination_refund_obligations` | **0 hàng** — đường mới chưa từng chạy thật |
| Hồ sơ thanh lý | 52, `COMPLETED` cả 52 |
| `refund_amount > 0` / `< 0` / có `refund_date` | 16 / **17** / **0** |
| Phiếu `termination.refund` `APPROVED+POSTED` + posting sống | 14 — 40.279.100đ |
| … `UNAPPROVED + UNPOSTED` | 13 — 37.756.923đ |
| … `APPROVED` + `NOT_APPLICABLE` (mù ở mọi màn, xem F4) | **3 — 9.515.634đ** |
| … `CANCELLED` | 5 — 12.091.067đ |
| … `termination.refund.v2` (xem F1) | **0** |
| 4 bảng cấu hình Plan 1 (`sale_bonus_cap_versions`, `commission_tier_versions`, `utility_ceiling_versions`, `maintenance_rule_versions`, đều ở schema `app_private`) | **rỗng cả bốn** — cỗ máy Plan 1 đã dựng nhưng chưa bật cho ô nào |
| `contracts.parent_contract_id` có giá trị | **0 / 366** |
| `contract_extensions.new_contract_id` có giá trị | **0 / 101** |
| `contract_transfers` | 3, tất cả `COMPLETED` `ROOM_CHANGE`, đủ cả hai phòng |
| Phòng / hợp đồng / phòng có ≥2 hợp đồng | 330 / 366 / **52** (nhiều nhất 6 hợp đồng một phòng) |

### 8.1. Hệ quả cho chính tính năng đã khởi ra đợt audit này

Trên production **không tồn tại một liên kết cha-con nào giữa các hợp đồng**: `parent_contract_id` rỗng hoàn toàn, `contract_extensions.new_contract_id` cũng rỗng hoàn toàn. Gia hạn được làm bằng cách sửa ngày trên chính hợp đồng cũ chứ không sinh hợp đồng mới.

Nghĩa là **"biểu đồ cây" theo nghĩa nối hợp-đồng-này-đẻ-ra-hợp-đồng-kia không dựng được từ dữ liệu hiện có.** Thứ dựng được là **timeline theo phòng**: mỗi hợp đồng một thanh trên trục thời gian, gia hạn là phần kéo dài của chính thanh đó, khoảng hở giữa hai thanh là thời gian bỏ trống, và 3 lượt chuyển phòng nối được bằng `contract_transfers`.

Ai định làm Task 6 phải biết điều này **trước** khi thiết kế, nếu không sẽ dựng một cấu trúc cây rồi phát hiện không có cạnh nào để vẽ.

## 9. Khuyến nghị theo thứ tự

**Nhóm A — vá trước khi ai đó bấm nút hoàn cọc thật.** F1, F2, F3, F4. Cả bốn nhỏ, độc lập, không đụng kiến trúc plan, đi được trong một migration `migrate:forward`.

Bắt buộc kèm test **gọi trọn hàm** trong transaction rollback — án lệ `v_voucher_id` ngày 01/08: vá hàm bằng `replace` trên `pg_get_functiondef` rồi chỉ assert chuỗi trên `prosrc` **không** chứng minh hàm còn chạy; lỗi tên biến PL/pgSQL chỉ nổ lúc thực thi.

**Nhóm B — món nợ đã có tên.** F7 (thống nhất nguồn số phải trả), F8 (chunk hàng đợi), §7.1 (chốt một hướng cho KPI), §7.2 (sửa `realtime-sync.md`).

**Nhóm C — Task 6A + Task 7 Step 4**, dựng timeline theo phòng. Không bị chặn bởi Task 1 hay Plan 1 (chỉ 6B mới bị chặn). Dùng lại `get_room_residence_segments_v1` đang nằm không — và đọc §8.1 trước khi thiết kế.

**Nhóm D — điều kiện để khoá đường thanh lý cũ (F6).** Cần E2E chạy trọn thanh lý → nghĩa vụ → phiếu hoàn trên DEMO trước. Điều kiện này đặt ra từ 31/07 và vẫn chưa đạt.

**Không khuyến nghị** tuyên bố Task 7 "xong" ở bất kỳ mức nào cho tới khi Task 6 tồn tại — plan tự đặt `BLOCKED-BY Task 6` cho Task 7.
