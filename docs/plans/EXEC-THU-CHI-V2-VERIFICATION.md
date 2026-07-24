# TỔNG KIỂM & HOÀN THIỆN Thu Chi V2 — Kế hoạch thực thi (2026-07-23)

> Lệnh owner: kiểm tra TOÀN BỘ plan (code + data + hành vi) → sửa → test browser → lặp tới khi
> xong hết. **Định nghĩa "XONG" = đã verify bằng Playwright trên bản deploy, đường bấm thật.**
> Trạng thái 3 mức: 🟢 browser-verified · 🟡 test-verified (unit/DB) · 🔴 built-chưa-kiểm / thiếu.

## Vòng 1 — 3 fix chặn nghiệp vụ (đang chạy)

| # | Việc | Phương pháp verify | Trạng thái |
|---|---|---|---|
| F1 | Dialog **Duyệt / Duyệt-và-Chi** kích hoạt (root-cause: mapper thiếu org/status; +5 bug server 210000–240000, evidence sai tenant) | Playwright localhost cả 2 nhánh + DB assert + fixture tự dọn (commit 4c55ac8) | 🟢 **PROD** (dialog 2 nút mở trên ptcrm, read-only) |
| F2 | Báo cáo lợi nhuận **gồm phiếu Chờ duyệt** (§2.3) + dòng đếm riêng + bỏ "phiếu nháp" | Playwright: fixture 77k vào tổng+bảng; counter riêng; tie-out engine bảo toàn | 🟢 **PROD** (counter "15 phiếu chờ duyệt · thu 19,7tr · chi 112,6tr" live) |
| F3 | Badge composite §12.1 ở danh sách + inbox 2 nút + mobile parity | Playwright: desktop badge Chờ duyệt→Đã Duyệt-Chưa Chi→Đã Chi; mobile tag parity; inbox "Duyệt và Chi…" live (RPC +organization_id 250000) + request tự đóng (a87 260000) | 🟢 **PROD** (badge "Đã Thu" thay "Đã vào sổ" trên org thật) |

> **Finding V2-PRE-1 (pre-existing, KHÔNG do FIX 2):** tie-out engine chia cổ đông lệch
> thu −16.062.882 / chi −743.000 ở 8 toà (102LVT, 111PVC, 1392QT, 158PVC, 15KV, 162NVK,
> 32PVC, 331PHI) — đo y hệt trên baseline HEAD (APPROVED-only) lẫn sau FIX 2 → client
> accrual vs fa_accrual_allocations lệch từ trước. Điều tra ở Vòng 2 (§21.2).

## Vòng 2 — Sượt §21 acceptance (từng dòng → test → fix → re-test)

### Nghiệp vụ/state (§21.1)
- [x] Không còn "Nháp" toàn domain thu-chi (🟢 salary/khoá-LN "Nháp"→"Chưa chốt";
      nhãn DRAFT hợp đồng/hoá đơn giữ nguyên — domain riêng đúng nghiệp vụ)
- [x] Tạo phiếu không đổi balance (🟢 verified — pending không vào tồn)
- [x] **Duyệt không đổi balance** (🟢 F1 — token FINANCE_V2_LIFECYCLE + bridge skip, 240000)
- [x] Duyệt-và-Chi atomic (🟢 F1 — POSTED + line MAIN + evidence ATTACHED + balance đúng)
- [x] Chi sau duyệt không cần quyền approve (🟢 nút "Thu/Chi tiền (phiếu đã duyệt)" +
      dialog POST_APPROVED — browser: G APPROVED→POSTED −21k, evidence đúng tenant)
- [ ] Sửa/hủy pending (🟢 sau 4 hotfix); posted → reversal (🟡 RPC, chưa UI)

### Lợi nhuận (§21.2)
- [x] Pending KQKD vào đúng kỳ + 1 lần (🟢 F2 local — fixture 77k vào bảng+tổng, counter riêng)
- [x] Finding V2-PRE-1: lệch engine pre-existing (🟢 **FIXED, browser "Khớp engine
      ±0 ✓"**). Hai nguồn, cộng khớp TỪNG ĐỒNG (−17.276.000 + 1.213.118 = −16.062.882):
      1. RPC kiểm chứng (fa engine/layer stats, SECURITY DEFINER) với
         p_building_ids=NULL quét MỌI building user thấy — gồm cả org DEMO
         (thu 17,3tr / chi 743k) trong khi client chỉ xem org hiện hành.
         Fix: 2 trang truyền TOÀN BỘ toà org hiện hành khi không lọc.
      2. Client accrual lọc `is_deposit` thay `accounting_class='PNL'` → tính dư
         item CUSTOMER_CREDIT/INTERNAL (+1,2tr — vd "Tiền khách trả thừa").
         Fix: skipDepositItem + rowCounts ưu tiên accounting_class (fallback
         is_deposit cho item cũ null).
- [ ] Approve/post không nhảy P&L lần 2 (🟡 cần test browser sau F2)
- [ ] Close chặn pending + drill-down (🟡 blockers RPC có; close FROZEN — mục 4 owner)

### Sổ quỹ (§21.3)
- [ ] Balance = posting lines (🟢 25/25 khớp, reconcile-v2 PASS)
- [x] Cash report theo posted_on (🟢 prod "Tài khoản theo ngày" render, 0 console error, chuỗi tồn ngày liên tục khớp)
- [x] Retry/concurrency 1 posting (🟢 DB: ux_ie_postings_subject_generation UNIQUE(org,subject,generation) WHERE POSTING + ux idempotency + CAS posting_version; UI disable isSubmitting)

### Phân quyền (§21.4)
- [ ] CUSTODIAN/KNOWER đúng ma trận (🟢 cài đặt 2 danh sách + chặn KNOWER-chi verified)
- [x] KNOWER/list scope (🟢 browser với tài khoản NATHAN thật):
      1. Canary PC2607147 (tòa 417LVT ngoài scope, sổ Tâm Thu KNOWER, NG TÂM tạo)
         → NATHAN KHÔNG thấy ✓; tổng Thu/Chi scoped nhỏ hơn owner ✓.
      2. Phiếu tòa mình quản (102LVT) → thấy đủ (role Quản Lý Tòa ALLOW) ✓.
      3. Balance sổ KNOWER: RLS server chặn số thật (ATam thật −1,42tỷ, NATHAN
         nhận 0 giả) ✓ KHÔNG lộ; UI trang Sổ quỹ nay hiện "—" cho sổ KNOWER
         (desktop + mobile) thay "0 đ" gây hiểu lầm.
      4. Nợ nhỏ: sổ không-binding vẫn hiện TÊN + "0 đ" giả trong list quản trị;
         icon sửa/xoá hiện nhưng server 42501 khi bấm (fail-closed).
- [ ] Admin RPC share-scope (🟢 dialog verified)

### Security/data (§21.5)
- [ ] Base tables không client-DML (🟢 Stage-7 applied + grep 0 raw)
- [ ] Audit --strict CLEAN (🟢) · view invoker (🟢) · delta lag 0 (🟢)
- [x] E2E specs (🟢 `.e2e-fleet/specs/finance-v2.spec.ts` PASS 2/2 ổn định trên
      localhost): seed compat Chờ duyệt (ketoan) → Chỉ duyệt (chunha, RPC v2 200)
      → Thu tiền vào sổ (custodian + evidence thật) → fail-closed huỷ-phiếu-đã-
      ghi-sổ (55000 đúng §2.2) → reversal RPC v2 → huỷ. Passwords fleet reset
      2026-07-24, lưu CLAUDE.local.md. **Spec bắt được 6 regression server thật**,
      đã fix bằng 20260724010000→060000:
      7m id NULL (compat+a86 birth) · 7n total_amount NULL · 7o defaults header
      (generic) · 7p defaults items · 7q policy storage v2/ prefix (MỌI user
      thường không upload được chứng từ!) · 7r registry SELECT own-rows.
      Mốc sổ CANARY renamed (DEMO) sau đợt này: **218.000** (45k bụi test kẹt
      hash-chain trong 2 phiếu CANCELLED — vô hại, không tiền treo).

### Bổ sung 2026-07-24 (sau go-live)
- [x] **HOTFIX P0002 PROD** (NATHAN tạo phiếu chi chờ-duyệt): a86 birth ĐÈ
      source_payload_hash của writer create v1 ⇒ claim lệch hash ⇒
      "no matching in-progress canonical operation". Fix 20260724070000
      (birth tôn trọng hash sẵn có; op birth ghi đúng hash đó — boundary V2 vẫn
      khớp). Verify REST org DEMO: create v1 chờ-duyệt 200 + hash giữ nguyên;
      cancel_income_expense_v1 (đường UI chính) 204 ✅.
- [x] **Bộ lọc trạng thái V2** (yêu cầu owner): dropdown thêm "Đã duyệt - Chưa
      thu/chi" / "Đã thu/chi" / "Đã hoàn tác" (+ đổi nhãn "Đã ghi nhận"→"Đã duyệt
      (tất cả)"), đồng bộ FilterPanel/Chips; RPC layer_stats thêm p_posting
      (20260724080000). Browser-verified: từng trạng thái lọc thuần nhất, cards
      ăn theo, 0 console error.
- [x] **HOTFIX 7t (PROD — phiếu "Tesst" NATHAN)**: duyệt V2 phiếu do writer v1
      tạo → 55000 "may only change lifecycle columns". Allowlist freeze-guard
      chỉ biết cột lifecycle thời v1; widen thêm review_state/review_version/
      review_reason, approval_version/posting_version, posting_status/mode,
      active_posting_id_v2, cancellation_kind, deleted_at, approval_request_id,
      notes (20260724090000+100000). Tổ hợp (phiếu v1 × lifecycle V2) chưa từng
      tồn tại trước 7s — phiếu v1 chờ-duyệt trước đó không tạo nổi.
- [x] **HOTFIX 7u — token transition STALE (gốc rễ)**: PK ie_transition_authorization
      = (income_expense_id) ĐƠN + mọi grant ON CONFLICT DO NOTHING ⇒ phiếu từng
      qua 1 lifecycle V2 giữ token xid CŨ vĩnh viễn ⇒ lifecycle SAU frozen. Fix:
      grant = UPSERT xid (begin_canonical_op + compat cancel + backfill). Compat
      cancel giờ tự cấp token → nợ fallback-cancel cũ ĐÃ VÁ. E2E chạy 2 lần
      liên tiếp PASS (lần 2 trên DB có token cũ — confirm hết stale).
- [x] E2E siết chặt: case v1-pending mở rộng (create v1 vượt ngưỡng → duyệt V2
      → huỷ); bước cleanup lifecycle đổi sang REST-assert CANCELLED (bài học:
      assert "row biến khỏi list" từng false-positive). 2 specs PASS, 0 fixture
      treo sau chạy.
- [ ] Nợ nhỏ mới: nút Huỷ trên phiếu ĐÃ HOÀN TÁC (REVERSED) — cancel v1 từ chối
      phiếu đã duyệt (409) và client chưa fallback compat cho case này → user
      chưa huỷ được phiếu REVERSED qua UI (compat cancel REST thì được).

## Vòng 3 — Nợ kiến trúc ghi nhận (không chặn vận hành, làm sau vòng 2)
- §11.3 hợp nhất: report đọc resolver server. **KẾT LUẬN ĐÁNH GIÁ 2026-07-24: GIỮ
  Vòng 3, chưa wire.** Lý do: mục tiêu của §11.3 là chống lệch client/engine —
  lệch hiện = 0 (browser "Khớp ±0 ✓") và được thanh kiểm chứng GIÁM SÁT TỰ ĐỘNG
  (đỏ ngay khi lệch ≥2đ). Wire resolver = thay nguồn dữ liệu trang báo cáo phức
  tạp nhất (3 nhánh query + gộp HĐ + phòng trống) trong khi resolver server 0
  consumer, chưa từng browser-verified → rủi ro regress cao hơn lợi ích lúc này.
- V5 per-tender lineage đầy đủ §6.2 (hiện bridge voucher-formula, parity đúng)
- resubmit tạo request engine mới; execution-queue UI; evidence-first posting UI
- Mục 4 owner: 52 unsafe locks + 22 phiếu kỳ khóa (profit_close đang FROZEN an toàn)

## NHẬT KÝ LỖI TOÀN ĐỢT (go-live V2 → 24/07) — để dò lại & phân tích mẫu lỗi

> Owner yêu cầu 24/07: ghi lại TOÀN BỘ lỗi đã sửa để phân tích "đang hỏng ở phần nào".

| # | Ngày | Triệu chứng (ai báo) | Root cause | Fix | Lớp |
|---|---|---|---|---|---|
| 7e-7h | 23/07 | NATHAN: huỷ/sửa phiếu chờ duyệt lỗi; selector sổ sai vai | flow-owned quá rộng; STABLE+FOR SHARE read-only txn; cột 42703/42804 compat | 160000–190000 | L2 |
| 7i | 23/07 | Duyệt V2 400 (23514 completion_check) | reserve op stamp subject sớm | 220000 | L2 |
| — | 23/07 | Duyệt V2 500 "no birth provenance" | phiếu cũ/writer cũ không khai sinh | 230000 (a86 + backfill) | L2 |
| 7j | 23/07 | "Chỉ duyệt" nhưng tiền tự vào sổ (sai §2.2) | bridge a85 không phân biệt writer V2 | 240000 token skip | L2 |
| — | 23/07 | Evidence "not FINALIZED in tenant" | FE không truyền org → intent đoán membership org khác | FE + org param | L2 |
| 7k | 23/07 | Inbox không bao giờ hiện nút V2 | RPC inbox thiếu organization_id | 250000 | L2 |
| 7l | 23/07 | "Duyệt và Chi" từ inbox xong nhưng dòng kẹt mãi | request engine không được đóng bởi writer V2 | 260000 (a87) | L2 |
| 7m | 24/07 | E2E: tạo phiếu compat 400 (23502 canonical op) | a86 birth khi NEW.id NULL (compat INSERT nêu id NULL) | 20260724010000 | **L1** |
| 7n-7p | 24/07 | E2E: compat insert nổ lần lượt total/created_at/items.id | `jsonb_populate_record` sinh NULL tường minh đè MỌI DEFAULT | 020000–040000 (generic header+items) | **L1** |
| 7q-7r | 24/07 | E2E: user thường không đính được chứng từ (403) | policy storage chỉ nhận scheme cũ `<uid>/`; registry không grant | 050000–060000 | L2 |
| 7s | 24/07 | **PROD NATHAN**: tạo phiếu chi chờ-duyệt P0002 | a86 ĐÈ source_payload_hash của writer v1 → claim lệch | 070000 (birth giữ hash) | L2 |
| 7t | 24/07 | **PROD NATHAN**: duyệt V2 phiếu v1 → 55000 lifecycle columns | allowlist freeze chỉ biết cột thời v1 | 090000 | L2 |
| 7u | 24/07 | E2E: phiếu qua 1 lifecycle V2 chết ở lifecycle sau ("frozen") | PK token = (income_expense_id) ĐƠN + grant DO NOTHING → xid stale | 100000 (UPSERT 3 chỗ) | **L3'** |
| 7v | 24/07 | **PROD**: huỷ phiếu đã chi → 23505 duplicate token | còn writer khác (forfeit) INSERT token trần | 110000 (trigger UPSERT tầng bảng) | **L3'** |
| — | 24/07 | Owner: muốn huỷ/chi lại phiếu đã chi | UI thiếu flow reversal | FE reverse-then-cancel + mô hình 2 nút + 130000 (generation MAX+1) | feature |
| 7w | 24/07 | **PROD NATHAN**: đóng điện nước 23502 org NULL | pay_utility_bill quên organization_id; phiếu vượt ngưỡng sinh chờ-duyệt → a86 org NULL | 120000 (a86 bù org + writer gán org) | L2 |
| 7y(1) | 24/07 | **PROD NATHAN**: thu tiền hoá đơn V5 → 23503 FK postings→voucher | bridge a85 tạo POSTING trong **BEFORE INSERT** (row cha chưa tồn tại); ngủ yên tới khi có INSERT-đã-duyệt đầu tiên sau go-live | 140000 (tách AFTER INSERT bridge a85b) | **L3** |
| 7y(2) | 24/07 | **PROD NATHAN**: sửa phiếu chờ duyệt → 23502 items.id NULL | `ie_compat_update_pending_v2` cũng populate_record (7o/7p chỉ vá hàm INSERT) | 140000 (trigger a000 defaults-fill TẦNG BẢNG cho income_expenses + items) | **L1** |

### PHÂN TÍCH MẪU LỖI (trả lời "đang hỏng ở phần nào")
1. **L1 — `jsonb_populate_record` đè DEFAULT** (7m,7n,7o,7p,7y2 — 5 lần): một kỹ thuật
   dùng ở NHIỀU writer; tôi vá theo TỪNG HÀM bị lộ thay vì quét mọi hàm dùng nó
   một lần. Đã đóng vĩnh viễn bằng trigger defaults-fill Ở TẦNG BẢNG (140000) —
   từ nay writer nào đưa NULL tường minh cũng được bù, không phụ thuộc vá hàm.
2. **L2 — tổ hợp writer × trạng thái mới xuất hiện lần đầu** (7s,7t,7w…): mỗi trigger/
   guard mới áp TOÀN CỤC nhưng test chỉ chạy luồng đang sửa. Khắc phục quy trình:
   mọi thay đổi trigger toàn cục phải chạy đủ ma trận writer (v1, compat, V5,
   utility, forfeit) × trạng thái sinh (tự duyệt / chờ duyệt) — nay đã có trong
   e2e + smoke in-migration.
3. **L3 — trigger đặt sai pha** (7y1: BEFORE làm việc của AFTER; 7u/7v: token
   1-hàng-vĩnh-viễn cho khái niệm per-transaction): lỗi thiết kế nền — khi phát
   hiện thì fix Ở TẦNG CƠ CHẾ (trigger tầng bảng, tách pha) chứ không vá caller.
4. Mọi fix từ 7m trở đi đều kèm: smoke in-migration tái hiện đúng ca vỡ + verify
   REST/e2e độc lập (Opus) + fixture tự dọn + mốc sổ CANARY đối chiếu.

## Smoke checklist cố định (chạy trước MỌI push main)
1. Login owner → /income-expense: tạo phiếu chi → Chờ duyệt, tồn quỹ KHÔNG đổi
2. Duyệt → 2 nút; "Chỉ duyệt" → badge Đã Duyệt-Chưa Chi, tồn KHÔNG đổi
3. "Duyệt và Chi" → form ngày/sổ/ảnh → tồn đổi đúng sổ
4. Sửa pending OK; hủy OK; báo cáo lợi nhuận: pending có trong tổng + counter
5. Console 0 error đỏ

*Cập nhật trạng thái từng dòng ngay sau mỗi verify. File này là nguồn truth của đợt tổng kiểm.*
