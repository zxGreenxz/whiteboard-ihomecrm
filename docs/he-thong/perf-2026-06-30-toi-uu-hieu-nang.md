# Đợt tối ưu hiệu năng & độ ổn định — 2026-06-30

> Ghi lại chi tiết đợt sửa để theo dõi và làm nền cho các đợt update sau.
> Triệu chứng ban đầu: app giật/lag toàn cục, trang **Hoá đơn** thỉnh thoảng
> **trắng xoá không load dữ liệu**, và **bấm Lưu khi tạo công việc bị treo** rồi
> phải bấm lại. Chỉ ~2 quản lý dùng + trang Phòng trống lưu log.

## 1. Chẩn đoán (đo trực tiếp prod, không đoán)

| Hạng mục | Số liệu | Kết luận |
|---|---|---|
| Kích thước DB | Bảng lớn nhất `invoice_audit_log` 5.495 dòng/6.4MB; `invoices` 636 dòng; tổng vài MB | **KHÔNG nghẽn do dung lượng** |
| Gói compute | Không có add-on → gói nhỏ nhất (CPU shared/burst, ~1GB RAM) | CPU burst cạn khi spike |
| Query danh sách HĐ (pg_stat_statements) | mean **1.300–2.200 ms** (20 dòng/636!) | Chậm bất thường |
| Cùng query chạy cô lập (owner) | **1–2 ms** | Chậm là do **tranh CPU**, không phải query |
| RPC `get_invoice_statistics_v2` | **403 ms ngay cả khi rảnh**, mean 887 ms × **2.117 lần gọi** | Hotspot thật |
| Dashboard 1 lần load | **~50+ request REST** (N+1 + trùng) | Tự tạo tải dư |
| INSERT `jobs` | **21–70 ms** | Lưu treo KHÔNG do write nặng |
| Realtime | Chỉ bật cho 4 bảng `zalo_*`; WAL decode **98.303 lần** | Cạnh tranh CPU |

**Câu trả lời "tối ưu code hay nâng server?":** tối ưu **code + DB trước**. DB nhỏ → không cần nâng để chứa dữ liệu. Query 2ms mà tốn 1–2s là do (a) gọi quá nhiều query/trang, (b) RPC stats tự chậm + gọi lại liên tục, (c) CPU burst cạn trên gói nhỏ nhất. Nâng server chỉ che triệu chứng ~2×; với 2 user nhiều khả năng **không cần** sau khi tối ưu. → Đo lại rồi mới quyết.

### Nguyên nhân từng triệu chứng
- **Trắng trang Hoá đơn** = (1) `useInvoices` **nuốt lỗi** → hiện "Chưa có hoá đơn" GIẢ khi RLS/timeout/5xx; (2) chunk lazy cũ 404 sau deploy + reload guard 1 lần/60s, không có nút thủ công.
- **Lag toàn cục** = tự tạo tải dư (over-fetch + N+1 + RPC stats chậm + Zalo poll 4s) × CPU burst cạn.
- **Lưu công việc treo** = INSERT nhanh (21ms); treo do token refresh ngẫu nhiên (~mỗi giờ) rơi đúng spike CPU → giảm tải tổng là cách chữa gốc.

## 2. Đã sửa trong đợt này

### P0 — Chặn chảy máu
| Thay đổi | File |
|---|---|
| `useInvoices` **throw lỗi** thay vì trả `{data:[]}` (phân biệt lỗi vs rỗng thật) | `src/hooks/useInvoices.ts` (~L174) |
| `useRooms`, `useBuildings` throw thay vì trả `[]` | `src/hooks/useRooms.ts`, `src/hooks/useBuildings.ts` |
| `InvoicesPage` hiện **panel lỗi + nút "Thử lại"** khi `isError` (trước rơi vào EmptyState giả) | `src/pages/invoices/InvoicesPage.tsx` |
| `ErrorBoundary` thêm thẻ "Có phiên bản mới" + **nút "Tải lại" thủ công** khi lỗi chunk | `src/components/errors/ErrorBoundary.tsx` |
| `chunkReload` nới guard 60s→**180s + 2 lần backoff**; privacy-mode không auto-reload (tránh loop) | `src/lib/chunkReload.ts` |
| Zalo poll **4s→15s** + `refetchIntervalInBackground:false` (dừng khi tab ẩn) | `src/hooks/useZaloChat.ts` (~L325) |

### P1 — Giảm tải gốc (tối ưu thật, không phải band-aid)
| Thay đổi | File |
|---|---|
| **Bỏ query `payments` thứ 2** trong bảng HĐ — tính "mixed TK+TM/TT" trực tiếp từ `invoice.payments` đã embed | `src/components/invoices/InvoiceListTable.tsx` |
| **Gộp N+1**: lần-gửi-cuối của TẤT CẢ HĐ quá hạn trong 1 query (trước mỗi HĐ 1 query) | `src/lib/notificationScheduler.ts` (`checkOverdueInvoices`) |
| **Bỏ 3 query `notification_config` trùng**: nạp 1 lần ở `runScheduledNotifications` rồi truyền xuống | `src/lib/notificationScheduler.ts` |
| Dashboard stats **refetch 60s→5 phút** + `staleTime` (mutation vẫn invalidate ngay khi có thay đổi thật) | `src/hooks/useDashboard.ts` |

### P2 — Database
| Thay đổi | Chi tiết |
|---|---|
| **Tối ưu `get_invoice_statistics_v2`** | Tính phạm vi toà 1 lần (`v_priv`/`v_bids`) thay `can_access_building()` per-row × 5 lần quét. **403ms → 21.8ms (~18×)**. Migration `supabase/migrations/20260630120000_optimize_invoice_statistics_v2.sql`. Đã verify JSON output **khớp 100%** cho owner + bosshuy (14 toà) + joey (7 toà), cả all-time lẫn tháng 6. |

> **KHÔNG thêm index** theo gợi ý audit tự động: `invoices` đã có `idx_invoices_created_at` (DESC),
> `idx_invoices_building_month` (partial), `income_expenses` đã có `idx_ie_active_voucher_date` +
> type/status/building. `staff_assignments` đã có unique `(staff_id, building_id)`. Thêm index nữa
> trên bảng tí hon chỉ làm **chậm ghi**, không lợi đọc → đã loại để tránh "ép giảm hiệu năng".

### Đo lường (mới thêm)
- `src/lib/perfTrace.ts` + init ở `src/main.tsx`: `PerformanceObserver` đo mọi request Supabase.
  - Console: **`__perfReport()`** (bảng count/p50/p95/max/total theo endpoint), `__perf` (200 request gần nhất), `__perfReset()`.
  - Tự `console.warn` khi 1 request > 1000ms.

## 3. KHÔNG làm (cố ý) — để tránh sửa vô ích/sai
- `select('*')`→cột cụ thể trên `invoices`: payload đã nhỏ (~22KB/trang), rủi ro thiếu cột → bỏ.
- `count:'exact'`→`'estimated'`: bảng tí hon, count rẻ; estimated làm sai số tổng/phân trang → giữ exact.
- "Ổn định `statsFilters`": React Query v5 **hash key theo cấu trúc**, đổi reference mảng KHÔNG gây refetch → không phải vấn đề.
- 3 index audit đề xuất: đã tồn tại (xem trên).
- Sửa `InvoiceStatsSummary` "throw → ErrorBoundary": RQ v5 không throw nếu không bật `throwOnError` → không phải nguyên nhân trắng trang.

## 4. Cách kiểm chứng nhanh hơn
1. `npx tsc -p tsconfig.app.json` (baseline ~106 lỗi pre-existing, các file sửa = 0 lỗi mới).
2. Prod: mở /, /invoices, tạo 1 công việc → DevTools Console gọi `__perfReport()`:
   - Số request `/invoices` giảm rõ so với baseline; `rpc:get_invoice_statistics_v2` p95 phải về chục ms.
3. Đo lại DB (Management API), so với baseline đợt này:
   ```sql
   SELECT calls, round(mean_exec_time::numeric,1) mean_ms, left(query,80) q
   FROM pg_stat_statements WHERE query ILIKE '%get_invoice_statistics_v2%'
   ORDER BY total_exec_time DESC LIMIT 5;
   ```

## 5. Backlog đợt sau (ưu tiên giảm dần)
1. **Áp cùng tối ưu cho `get_change_breakdown_v2` + `get_deposit_breakdown_v2`** (LANGUAGE sql → dùng CTE `priv`/`allowed`, verify row-set). On-demand nên hoãn được.
2. **Viết lại RLS `invoice_items` + `payments`** bỏ subquery/`can_access_building` per-row (tính tập 1 lần / denormalize `building_id` vào `invoice_items`). Nhạy cảm quyền — test owner + staff giới hạn toà.
3. **Dashboard 7 query → 1 RPC `get_dashboard_stats`** server-side.
4. **Chuyển scheduler thông báo khỏi mỗi lần mở app** → pg_cron/edge function (pg_cron 1.6.4 đã cài). Hiện vẫn chạy client-side mỗi lần mở app (ghi notifications).
5. **Retention `public_room_events`** 90 ngày qua pg_cron (mới 3.257 dòng — chưa gấp).
6. **Quyết định compute**: sau khi đo lại, nếu vẫn spike → nâng **Small (~$15/tháng)**. Bật add-on qua dashboard (không tự bật vì tốn phí).
7. **Service worker** `updateViaCache:'none'` (bảo hiểm rẻ chống shell cũ sau deploy).

## 5b. Đợt 2 (cùng ngày) — mở rộng sang Hợp đồng + Công việc
Sau khi user hỏi "đã xử lý Hợp đồng + Công việc chưa?", đo lại + mở rộng đúng fix P0:
- **Công việc**: `useJobs` (src/hooks/useJobs.ts) **throw thay vì nuốt lỗi** (`return []`); `TaskManagementPage` + `TasksMobilePage` bắt `isError` → panel lỗi + nút "Thử lại" (hết "Chưa có việc" GIẢ). Lưu công việc treo = môi trường (INSERT 21ms) → không sửa code lưu.
- **Hợp đồng**: trang danh sách (`useContractsPaged`) đã tối ưu + đã throw sẵn; thêm bắt `isError` ở `ContractsPage` + `ContractsMobilePage`; `useContractsLegacy` throw thay vì `return []` (caller IncomeExpenseForm đã default `[]`).
- **Đo RLS per-row** (EXPLAIN, server-side): contracts list scoped **32ms** vs owner 1ms; invoice_items scoped **120ms** vs 46ms → vẫn để dành (đo `__perfReport()` trước, chỉ rewrite nếu còn chậm). Không đụng RLS/bảo mật đợt này.

## 6. Kế hoạch gốc
Xem `C:\Users\Nguyen Tam\.claude\plans\ki-m-tra-to-n-di-n-snoopy-cerf.md`.
