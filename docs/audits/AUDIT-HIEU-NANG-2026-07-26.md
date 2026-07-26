# Audit hiệu năng toàn trang — 2026-07-26

> **Lifecycle:** historical audit snapshot. Mọi finding phải tái kiểm chứng với runtime/code hiện tại; xem [README.md](README.md).

**Ngày:** 2026-07-26 · **Commit gốc:** `bc68cc1` · **Phạm vi:** initial load, bundle/code-splitting, React render, data fetching (React Query + Supabase), SQL/RLS/migrations, assets/PWA
**Phương pháp:** build production thật (`vite build`, 2 lần — 1 lần kèm sourcemap để attribute từng chunk) → 5 finder song song theo 5 mảng → **mỗi finding được 1 verifier hoài nghi độc lập đọc lại code thật để bác bỏ** → chỉ giữ finding trụ lại. Kết quả: **32 finding, 31 confirmed, 1 hạ mức (hook chết), 0 bị bác bỏ.**

> ⚠️ **Khoảng trống xác minh:** session chạy trong môi trường remote không có `CLAUDE.local.md` (không có mật khẩu tài khoản DEMO, không có PAT Supabase) và network policy chặn tới `ptcrm.vercel.app` → **chưa đo runtime thật trên browser/production, chưa EXPLAIN ANALYZE trên DB thật**. Mọi số liệu kB là từ build thật; số ms của RLS lấy từ số đo mà chính các migration trong repo đã ghi lại (20260725100000/110000). Các finding SQL nên đo lại bằng EXPLAIN ANALYZE trước khi sửa.

---

## 1. Ảnh chụp hiện trạng (build thật 2026-07-26)

| Chỉ số | Giá trị | Ghi chú |
|---|---|---|
| Payload boot (JS) | **829 kB raw / ~237 kB gzip** | entry 186 + vendor-react 164 + vendor-supabase 177 + **vendor-ui 263** + vendor-query 39 (modulepreload cả 5) |
| CSS entry | 137 kB | + thu-tien.css 107 kB (chỉ nạp ở /thu-tien — đã cô lập đúng) |
| Chunk lazy lớn nhất | xlsx 429 kB, @zxing 448 kB, recharts 349 kB, docxtemplater 186 kB, page-agent 114 kB | **Tất cả đều đã cô lập trong chunk lazy — tốt** |
| Ảnh public nặng | og-image.png **1,67 MB**, pwa-512 196 kB, maskable-512 201 kB, bộ splash iOS ~2,5 MB | |
| Service worker | Push-only, không cache fetch | Đúng chủ đích; cache dựa vào header Vercel (assets immutable, HTML no-cache — chuẩn) |

### Những thứ ĐÃ TỐT (kiểm chứng lại, không cần đụng)

- ~80 route đều lazy qua `lazyWithRetry`; HomeRoute/DashboardRoute lazy 2 nhánh.
- xlsx / docxtemplater / recharts / canvas-confetti / page-agent / @zxing đều dynamic-import chuẩn; quyết định giữ recharts NGOÀI manualChunks (comment án lệ trong `vite.config.ts`) là đúng.
- Copilot: mount sau idle, ChatPanel lazy theo click, `createAgent` chỉ load trong ChatPanel.
- QueryClient: `staleTime: 60s`, `refetchOnWindowFocus: false`, auth đi qua cache `staleTime: Infinity` (không round-trip mạng khi boot).
- `useRealtimeDataSync`: debounce 800 ms/bảng, invalidate theo prefix liệt kê tường minh, bỏ payload — thiết kế tốt, **không có finding**.
- Đợt set-based RLS 20260702150000 đã sửa đúng 9 bảng nóng (invoices, payments, contracts, rooms, buildings, income_expenses…).
- date-fns v3 named import, lucide named import, barrel chỉ 2 file re-export hook thuần — tree-shake OK.
- `vaul` + `embla-carousel-react` có trong package.json nhưng **không file src nào import** → gỡ dep được (vệ sinh, không ảnh hưởng bundle).

---

## 2. HIGH — đáng sửa trước (10)

### H1. `vendor-ui` gộp TOÀN BỘ Radix + lucide + cmdk vào chunk preload lúc boot — `vite.config.ts:47`
Chunk lớn nhất trên critical path mọi cold load (262,8 kB / 71,6 kB gzip ≈ **30% JS gzip của màn /login**). Entry thật chỉ cần ~5 gói Radix (tooltip/toast/label/checkbox/slot) + ~10 icon; nhưng regex gộp theo package nên cả 27 gói @radix-ui + **178 icon lucide của toàn app** + cmdk (chỉ dùng sau login) đều bị preload. Comment trong config nói vendor-ui "dùng bởi entry (auth/MainLayout)" — **sai với thực tế**: MainLayout là chunk lazy riêng (43 kB). Waste ước ~45–55 kB gzip / ~200 kB parse.
**Fix:** tách `vendor-ui-core` (đúng 5 gói entry dùng) và `vendor-ui-lazy` (phần còn lại — vẫn 1 chunk ổn định để cache, nhưng không bị preload); bỏ `lucide-react` khỏi manualChunks để icon rải theo chunk sử dụng.

### H2. Trang Hoá đơn: ô tìm kiếm không debounce + không `keepPreviousData` — `src/pages/invoices/InvoicesPage.tsx:186`
Gõ "Nguyen Van A" = 11 request tuần tự, mỗi request là query đắt nhất repo (`INVOICE_LIST_SELECT` 4 embed + `count:'exact'` + order theo cột embed). Mỗi phím tạo query key mới chưa cache → `isLoading` bật lại → **toàn bộ bảng unmount thành "Đang tải"** mỗi phím. Gõ chuỗi giống mã phòng còn kèm 1 query rooms lookup/phím. Bản mobile (`InvoicesMobilePage.tsx:88-91`) đã debounce 350 ms — desktop bị bỏ sót.
**Fix:** debounce 350 ms như mobile + `placeholderData: keepPreviousData` (mẫu sẵn ở `useContracts.ts:347`).

### H3. Trang Thu chi: search không debounce — mỗi phím kích ĐỒNG THỜI list query + stats RPC — `src/pages/payments/IncomeExpensePage.tsx:274`
`amount_target`/`searchQuery` nằm trong query key của cả list (`queries.ts:240,249`) lẫn stats RPC (`queries.ts:530`). Gõ "500000" = 6×(list + RPC `get_income_expense_layer_stats`), kèm skeleton flash toàn bảng. Prefix 1-3 chữ số còn khớp ROOM_CODE_REGEX → thêm 1 vòng key sentinel→resolved (refetch đôi). Mobile đã debounce — desktop bỏ sót.
**Fix:** như H2; stats có thể debounce dài hơn (500 ms).

### H4. `useJobs` kéo TOÀN BỘ bảng jobs, được prefetch từ màn chính + re-warm bởi realtime — `src/hooks/useJobs.ts:16`
Không `.range()/.limit()`, select kèm 4 embed (buildings kèm toạ độ/địa chỉ, rooms, job_types, profiles). Bị `prefetchJobs` kéo ngay lúc idle sau khi mở màn chính (filter mặc định = không lọc gì), và refetch LẠI toàn bộ mỗi khi bảng jobs có event realtime. jobs là bảng nuôi lương, tích luỹ vô hạn → vượt 1000 dòng là PostgREST cắt ngầm: **job cũ biến mất khỏi trang Quản lý công việc không ai biết**.
**Fix:** phân trang server-side (mẫu `useContractsPaged`) hoặc tối thiểu lọc mặc định 90 ngày + `.limit()`; thu gọn select.

### H5. Tab Phiếu tổng: tải 4 tầng KHÔNG giới hạn rồi tính tiền client-side — `src/hooks/income-expenses/queries.ts:674`
Mọi batch → mọi link (cap 1000!) → mọi phiếu con (`.in('id', voucherIds)` không chunk — URL dài chục kB sẽ 400) → mọi item; `total_amount` reduce ở client → **vượt cap là hụt tiền âm thầm**; mọi nhánh lỗi `return {data:[], totalCount:0}` → màn "không có phiếu tổng" giả. Tenant thật ~1.356 phiếu (comment trong chính file) — trần 1000 với tới được.
**Fix:** 1 RPC SECURITY INVOKER trả trang batch đã aggregate + count; tạm thời: chunk `.in()` (mẫu `useInvoiceCollectors` CHUNK=100) + throw thay vì nuốt lỗi.

### H6. Thiếu `preconnect` tới origin Supabase — `index.html:311`
Chỉ preconnect Google Fonts. Mọi cold load: DNS+TCP+TLS tới `*.supabase.co` (~100–300 ms trên 4G) nằm NỐI TIẾP sau khi parse ~237 kB gzip JS, ngay trước data query đầu tiên (useAuth đọc session local nên request mạng đầu tiên chính là data query). **Fix 1 dòng:** `<link rel="preconnect" href="https://<project>.supabase.co" crossorigin />`.

### H7. Google Fonts CSS render-blocking — chặn cả paint của splash — `index.html:313`
`<link rel="stylesheet">` thuần tới fonts.googleapis.com (3 family / 11 weight) chặn first paint của MỌI trang — kể cả `#app-splash` được xây để "paint tức thì" theo án lệ Android 07/2026: nếu request font CSS là request bị treo kiểu dead-socket thì user thấy **màn trắng thay vì splash + màn cứu hộ của watchdog** — vô hiệu hoá chính cơ chế đã dày công xây. Desktop còn không dùng 3 font này (index.css dùng Inter/system; 3 font chỉ ở kit mobile + /thu-tien + 1 dialog QR).
**Fix:** nạp non-blocking (`rel="preload" as="style" onload`) hoặc self-host woff2 subset trong CSS kit lazy; cắt weight thừa.

### H8. RLS per-row: `can_access_org_entity()` TRẦN trong policy customers/tenants (+4 bảng) — `20260703100000_org_entity_tenant_guard.sql:19`
Hàm SECURITY DEFINER không bọc `(SELECT ...)` → chạy TỪNG DÒNG (án lệ repo tự ghi: "Postgres KHÔNG hoist STABLE fn"). Số đo của chính repo: 0,52 ms/lời gọi → 1.000–2.000 khách = **0,5–1 s chỉ cho kiểm quyền**, nhân thêm vì `useCustomers.ts:88` dùng `count:'exact'` (đếm = chạy policy trên toàn bộ dòng khớp). Đã kiểm: không migration nào sau sửa lại (cutover 20260725200000 chỉ đổi policy write).
**Fix:** bọc `(SELECT can_access_org_entity('customers','view'))` cho cả 6 bảng nhóm org-entity; cân nhắc `count:'planned'`.

### H9. RLS per-row: meter_readings + meters còn `can_access_building(building_id)` theo dòng — `20260527000009_rbac_phase5_misc.sql:53`
Bảng nóng duy nhất bị bỏ sót khỏi đợt set-based 20260702150000 (hồ sơ "2–16 s/request cho staff scoped"). Màn Ghi chỉ số: hàng trăm–nghìn dòng/kỳ × ~0,4 ms/call, `count:'exact'` trên view `meter_readings_detailed` (security_invoker → RLS meters/rooms/buildings join kèm cũng chạy; view còn ORDER BY bên trong buộc sort toàn bộ trước phân trang).
**Fix:** rewrite theo mẫu đã verify: `(SELECT has_full_building_scope()) OR building_id IN (SELECT accessible_building_ids())`; bỏ ORDER BY trong view.

### H10. VIEW lồng nặng `legacy_payment_receipt_semantics` chạy lại trên MỌI lần tải trang Hoá đơn + Dashboard — `20260721102000_active_payments_reporting.sql:24`
Chuỗi ~8 CTE với window function quét income_expenses bằng `LIKE 'tiền thối hoá đơn%'`, CTE tham chiếu nhiều lần → materialize TRỌN mỗi request, không đẩy filter invoice_id vào được. `get_invoice_statistics_v2` từng tối ưu 403 ms→22 ms rồi bị patch trỏ vào view này mà chưa đo lại; Dashboard recent-activities trả phí này cho một query limit 5.
**Fix:** dữ liệu legacy đã đóng băng sau cutover v5 → backfill thành BẢNG thật 1 lần (index invoice_id, payment_date), trỏ view vào bảng; EXPLAIN ANALYZE lại để xác nhận mốc 22 ms.

---

## 3. MEDIUM (11)

| # | Finding | File | Tóm tắt |
|---|---|---|---|
| M1 | jsQR import TĨNH trong khi cùng file đã lazy @zxing | `src/lib/qrDecoder.ts:23` | jsQR chiếm **~80% chunk CustomerFormPage** (163 kB / 57,5 kB gzip; jsQR riêng = 46,3 kB gzip — đo bằng esbuild). Pipeline ưu tiên BarcodeDetector native nên trên Chrome jsQR thường không bao giờ chạy nhưng vẫn bị tải+parse khi mở form khách. Fix: lazy y hệt zxing cùng file — mọi call site đã async. |
| M2 | Trang Khách hàng: mỗi phím = 2 request (list + RPC stats), không debounce | `src/pages/customers/CustomersPage.tsx:64` | Cùng pattern H2/H3, nhẹ hơn (không embed nặng). Có thể bỏ `search` khỏi statsFilters để bớt hẳn 1 RPC/phím. |
| M3 | Sơ đồ toà nhà: `useRooms()` kéo phòng MỌI toà dù chỉ vẽ 1 toà + setState trong thân render | `src/pages/building-map/BuildingMapPage.tsx:37` | Cap 1000 → org lớn THIẾU phòng âm thầm trên sơ đồ; `setSelectedBuildingId` trong render → double render toàn trang; search re-render toàn grid RoomCard không memo. Hook đã hỗ trợ `buildingId` — chỉ cần truyền vào. |
| M4 | `useThuTienInvoices` không `.range()`/`fetchAllRows` | `src/hooks/useCollectionReport.ts:41` | Nguồn dữ liệu DUY NHẤT của /thu-tien. Hiện ~290 HĐ/tháng chưa lộ; vượt 1000/kỳ là phòng biến mất khỏi grid thu tiền + báo cáo cộng thiếu — đúng án lệ "mất ~1,5 tỷ". Fix: bọc `fetchAllRows` (helper sẵn có), giữ nguyên queryKey. |
| M5 | AssetHandoverDialog fetch toàn bộ HĐ ACTIVE full-PII ngay khi mở TRANG (chưa mở dialog) | `src/components/assets/AssetHandoverDialog.tsx:33` | Thiếu `enabled: open` — pattern đã chuẩn hoá ở GenerateInvoiceDialog nhưng dialog này bị bỏ sót. Fix 1 dòng. |
| M6 | vendor-ui bị modulepreload lúc boot (góc nhìn bổ sung cho H1, từ sourcemap) | `vite.config.ts:40` | lucide 129 kB(src) + react-select 48 kB + react-menu 34 kB + scroll-area 29 kB… phần lớn của page lazy nhưng nằm trên critical path /login. |
| M7 | Dashboard `useRevenueChart` kéo toàn bộ bút toán P&L 12 tháng về client | `src/hooks/useDashboard.ts:134` | `fetchAllRows` tuần tự từng trang 1000 trên view security_invoker (RLS per-row income_expenses) chỉ để ra 12 con số. Fix: RPC `revenue_by_month` GROUP BY — trùng mẫu `get_dashboard_summary` cùng màn. |
| M8 | Thiếu index cho cột mới luồng thu tiền v5 | `20260721102000:448` | `income_expenses.reversal_of_income_expense_id` (FK không index), `excess_amounts.source_payment_id` (nằm trên hot path stats/invoices), `invoice_payment_collections.collection_date`; index `payment_id` partial theo `deleted_at` không phủ query legacy (thiếu điều kiện) → 2 seq scan/payment bị đảo. |
| M9 | `jobs_select_rbac` còn per-row helper trần + jobs bật realtime | `20260710140000:129` | `can_access_building`/`can_access_org_entity` không bọc → per-row; WALRUS chạy policy này cho MỖI event × MỖI subscriber (bulk giao việc nhân chi phí trên realtime worker). Sửa cùng đợt H9. |
| M10 | GenerateInvoiceDialog kéo TOÀN BỘ HĐ ACTIVE full-PII không phân trang | `src/hooks/useContracts.ts:94` | Đã có `enabled: open` nhưng không limit — org thật đang tiến sát trần 1000 HĐ ACTIVE; vượt là **sinh THIẾU hoá đơn âm thầm**. Fix: select rút gọn + fetchAllRows, hoặc đẩy hẳn vào RPC. |
| M11 | (gộp vào M1 — cùng root cause, 2 finder độc lập cùng tìm ra, số liệu khớp nhau) | | |

## 4. LOW (10)

| # | Finding | File | Tóm tắt |
|---|---|---|---|
| L1 | qrcode import tĩnh lọt vào chunk trang /contracts desktop | `src/lib/contractQrImage.ts:7` | +31 kB raw / 12,6 kB gzip mỗi lượt mở danh sách HĐ; QR chỉ sinh khi bấm. Mobile không bị. |
| L2 | Google Fonts blocking trên route không dùng font (góc nhìn bổ sung H7) | `index.html:313` | CSS entry không chứa 3 family — chỉ kit lazy dùng. |
| L3 | Trang Công việc: 5 lượt filter trên allJobs mỗi render, không useMemo | `TaskManagementPage.tsx:88` | Vài ms với ≤1000 job; gom vào 1 useMemo. |
| L4 | /thu-tien: RoomCell không memo + handler inline — mở/đóng drawer re-render toàn lưới 4 lần | `RoomCellGrid.tsx:33` | 50–300 ô × 4 render/chu trình trên điện thoại yếu (đúng đối tượng màn thu tiền). |
| L5 | Filter "kỳ áp dụng" Thu chi: select không limit + `.in('id', ids)` không chunk | `income-expenses/queries.ts:100` | Cap 1000 thiếu voucher âm thầm + nguy cơ URL quá dài 400; lỗi bị nuốt thành rỗng. Cùng bug class đã sửa cho filter hạng mục nhưng sót nhánh kỳ. |
| L6 | `useUnhandedVouchers` không limit — cap 1000 làm sót phiếu khi bàn giao tiền mặt | `useCashHandovers.ts:49` | Fail-open trên tiền, xác suất thấp với nhịp bàn giao hiện tại. |
| L7 | Lương quản lý v5: RPC `v5_month_money` gọi lặp theo từng staff (N+1) | `useManagerSalary.ts:327` | 5–10 quản lý = vài trăm ms; thêm biến thể RPC nhận `uuid[]`. |
| L8 | Icon PWA chưa nén: pwa-512 196 kB + maskable-512 201 kB | `public/` | pngquant giảm ~80%; chậm luồng cài PWA trên mạng yếu. |
| L9 | og-image.png 1,67 MB | `public/og-image.png` | Crawler Zalo/FB có thể timeout → preview không hiện khi share /r/:token, /phongtrong. Xuất 1200×630 lossy <150 kB. |
| L10 | Realtime publication phủ 7 bảng ghi-nhiều — chi phí WALRUS server-side | `20260704120000` | FE đã tốt; khi số user online tăng, cân nhắc broadcast-from-trigger (FE vốn bỏ payload). Trước mắt: sửa xong H8/H9/M9 thì mỗi lần WALRUS check rẻ đi. |

**Hạ mức sau xác minh:** `usePaymentsSummary` (fetchAllRows + reduce client trên view nặng, `usePayments.ts:248`) — code đúng như finding nhưng **không page/component nào gọi** (chỉ test import) → nợ tiềm ẩn, chỉ thành vấn đề nếu được nối vào UI.

---

## 5. Thứ tự sửa đề xuất (theo tỉ lệ ăn/công)

1. **Nhóm fix 1-dòng, ăn ngay:** H6 (preconnect Supabase), M5 (`enabled: open`), H7/L2 (font non-blocking), L8/L9 (nén ảnh) — nửa buổi, giảm 100–400 ms cold load + sửa preview share.
2. **Nhóm debounce + keepPreviousData:** H2, H3, M2 (cùng 1 pattern, mẫu sẵn ở mobile + useContracts) — 1 buổi, giảm 5–15× số request khi tìm kiếm trên 3 màn chính, hết nháy bảng.
3. **Nhóm bundle:** H1/M6 (tách vendor-ui), M1 (lazy jsQR), L1 (lazy qrcode) — 1 buổi, giảm ~50 kB gzip boot + ~46 kB gzip form khách. Sau khi sửa PHẢI `vite build` kiểm tra lại danh sách modulepreload trong `dist/index.html`.
4. **Nhóm RLS set-based (migration):** H8, H9, M9 — theo đúng mẫu 20260702150000 đã verify; sau migration chạy `node scripts/check-view-invoker.mjs` + EXPLAIN ANALYZE đối chứng số đo cũ.
5. **Nhóm cap-1000 / unbounded:** H4, H5, M4, M10, L5, L6 — dùng `fetchAllRows`/chunk `.in()`/RPC aggregate; chạy `node scripts/reconcile-money.mjs` sau khi đụng các luồng tiền.
6. **Nhóm SQL nặng:** H10 (backfill bảng legacy), M7 (RPC revenue_by_month), M8 (4 index) — cần đo EXPLAIN ANALYZE trước/sau trên DB thật.

---

## 6. Addendum thực hiện — 2026-07-26 (đo lại trên DB production, có PAT)

Session thực hiện có `CLAUDE.local.md` nên đã đo được những gì audit gốc chưa đo. Toàn bộ EXPLAIN ANALYZE impersonate staff scoped NATHAN (10 toà) trên DB thật.

### RLS set-based (H8/H9/M9) — migration `20260726130000`

| Query | Trước | Sau | Ghi chú |
|---|---|---|---|
| `count(*)` customers (504 dòng) | **2.610 ms** | **11,6 ms** | ~5 ms/dòng chỉ cho kiểm quyền — TỆ HƠN ước tính audit |
| `count(*)` meter_readings_detailed (744 dòng quét) | **4.086 ms** | **~44 ms** | gồm cả bỏ Sort do ORDER BY nội view |
| `select *` jobs (182 dòng) | **1.059 ms** | **~47 ms** | |

Ngữ nghĩa kiểm chứng: số dòng NATHAN thấy được khớp CHÍNH XÁC trước/sau (494/474/147); user DEMO thấy 0 khách ngoài org demo (cách ly tenant nguyên vẹn). Bẫy syntax đã gặp: `= ANY((SELECT fn()))` bị Postgres hiểu thành ANY-subquery → phải dùng `IN (SELECT unnest(fn()))` (đúng pattern org_boundary sẵn có). `check-view-invoker` 12/12 xanh.

### M8 (4 index) — migration `20260726131000` · M7 (RPC) — `20260726132000`

Index reversal_of/source_payment_id/org+collection_date đã tạo; index `payment_id` partial `deleted_at` thay bằng partial `payment_id IS NOT NULL` (phủ cả query legacy-reversal thiếu điều kiện deleted_at). `get_invoice_statistics_v2` sau đổi index: ~50 ms — không regress. `revenue_by_month(p_start, p_end, p_building_id)` SECURITY INVOKER thay đường `fetchAllRows` của `useRevenueChart` (range vẫn client tính — giữ múi giờ user).

### H10 — **HOÃN CÓ CĂN CỨ** (tiền đề audit sai với thực tế)

Đo thật 2026-07-26: `payments.collection_id IS NULL` có `max(created_at)` = **hôm nay 04:29 UTC** và `invoice_payment_collections` mới có **1 dòng** — tức luồng "legacy" **vẫn là luồng ghi chính hàng ngày**, v5 collection chưa thật sự cutover (nhánh `fix/v5-collection-completion` còn đang hoàn thiện). Backfill bảng frozen lúc này = báo cáo thiếu phiếu mới âm thầm — đúng loại bug audit đang diệt. Chi phí thật của view cũng chỉ **46–48 ms/request** (không phải giây). → Làm lại H10 SAU khi v5 collection cutover thật và luồng legacy ngừng ghi; khi đó cần kèm RLS cho bảng frozen (mirror `payments_select_rbac`) + join live `payments.reversed_at`.

### Behavior delta đã biết của migration RLS (ghi nhận có chủ ý, không sửa)

Review hoài nghi phát hiện phép thay `can_access_building(building_id)` → `has_full_building_scope() OR building_id IN (SELECT accessible_building_ids())` **không còn tương đương tuyệt đối** sau cutover `20260725210000`: nhánh org-wide của `can_v3` trả TRUE với mọi toà kể cả đã soft-delete, còn `buildings_for_v3` lọc `b.deleted_at IS NULL`. Nghĩa là staff có quyền org-wide (không phải super admin) sẽ **không còn thấy** dòng meters/meter_readings/jobs/vehicles thuộc toà đã xoá mềm. Comment "≡ theo chứng minh 20260702150000" trong migration là chứng minh cho thân helper CŨ — đã stale.

Đo blast radius thật trên prod: **0 dòng bị ảnh hưởng** (6 toà soft-deleted, không toà nào còn jobs/meter_readings/meters/vehicles), và staff org-wide duy nhất là tài khoản DEMO. Giữ nguyên vì đồng bộ với hành vi sẵn có của `rooms`/`contracts` (cùng pattern từ 20260702150000) và ẩn dữ liệu của toà đã xoá là hành vi hợp lý. Nếu sau này cần cho staff org-wide thấy lại, sửa `buildings_for_v3` chứ đừng revert migration này.

### Ghi chú kiểm chứng khác

- `reconcile-money.mjs`: **INCONCLUSIVE** — kỳ nhiều phiếu nhất chỉ 348 dòng (≤1000) nên không kích hoạt được trần cap-1000 để chứng minh đường phân trang trên dữ liệu thật; các fix `fetchAllRows` đúng theo hợp đồng helper (đã có property test riêng).
- Bundle sau tách vendor-ui (đo `vite build` thật): boot 829 → **647 kB raw** (~237 → **191 kB gzip**); phần Radix bị preload 262,8 → 61,6 kB raw (71,6 → 21,5 gzip). Thực tế entry cần **23 gói** Radix (5 component + 18 helper nội bộ) chứ không phải ~5 như audit ước — danh sách tối thiểu đã ghi trong `vite.config.ts` kèm cách đo lại.
- H4: chọn phương án cửa sổ 90 ngày mặc định + select rút gọn + `fetchAllRows`, KÈM đổi hành vi có chủ ý: trang Công việc mặc định chỉ hiện 90 ngày gần nhất, có lựa chọn "Toàn bộ lịch sử" trong panel filter.
