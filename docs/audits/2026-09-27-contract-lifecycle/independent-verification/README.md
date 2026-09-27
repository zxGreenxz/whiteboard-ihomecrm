# Bằng chứng của lượt audit độc lập ngày 27/09/2026

Báo cáo chính: [`../independent-audit.md`](../independent-audit.md). Đề xuất sửa plan, tách riêng: [`de-xuat-sua-plan.md`](de-xuat-sua-plan.md).

Thư mục này không chứa secret.
- Các script `.cjs` tự đọc mật khẩu từ vault `CLAUDE.local.md` lúc chạy và không in mật khẩu ra.
- Truy vấn production luôn nằm trong `BEGIN READ ONLY … ROLLBACK`, chỉ đọc catalog và số đếm tổng hợp theo org.
- Các phép thử ghi chỉ chạy trên TEST (`ihomecrm-test`), mọi giao dịch đều ROLLBACK. Hai lượt đọc lại xác nhận không còn dấu vết.

| File | Nội dung |
|---|---|
| `live-catalog-prod-20260927/*.sql` (45 file) | Thân hàm sống trên production (`pg_get_functiondef`), kèm md5 `prosrc`; mục lục ở `INDEX.json` |
| `live-catalog-prod-20260927/catalog-and-aggregates.json` | Enum, constraint, index, trigger, RLS, grant, danh mục 125 hàm, cron, publication, cờ, số đo theo org THẬT/DEMO |
| `live-catalog-prod-20260927/flags-copilot-and-routes.json` | Cờ Copilot liên quan vòng đời; cờ route server |
| `live-catalog-prod-20260927/cat1…cat7.sql`, `cat-test*.sql`, `ro-query.cjs`, `ro-query-test.cjs` | Truy vấn và script đã chạy |
| `live-catalog-prod-20260927/cat-test*.json` | Catalog TEST: md5 so với production, pg_cron, bộ máy chi |
| `test-probe-legacy-entrypoints.json`, `t-probe-legacy.cjs` | IA-01 (duyệt thanh lý cũ sinh phiếu hoàn) và IA-02 (PATCH trạng thái) |
| `test-probe-lock-order.json`, `t-probe-lock-order.cjs` | IA-05: deadlock `40P01` |
| `t-verify-rollback.sql`, `t-verify-rollback*.json` | Xác nhận TEST không còn dấu vết |
| `baseline-vitest-rerun.txt` | Chạy baseline đúng lệnh của người lập plan ở checkout gốc: 40 file / 992 test, vì Vitest quét cả `outputs/…/source` |
| `baseline-vitest-rerun-excl-outputs.txt` | Chạy lại với `--exclude "outputs/**"`: 20 file / 496 test PASS |
| `extra-vitest-settlement.txt` | 6 file / 259 test liên quan quyết toán, credit và Copilot: PASS |

## Kiểm tài liệu

`node scripts/check-docs.mjs` sau khi ghi báo cáo: **exit 1, 348 file Markdown, 28 lỗi**.
- Cả 28 lỗi nằm ở các tài liệu cũ ngày 21–23/09 (cùng tập lỗi đã ghi ở `../verification/root-handoff.md`).
- **Không có lỗi nào ở thư mục `2026-09-27-contract-lifecycle/`**, kể cả hai file mới của lượt audit này.
- Tôi không sửa các tài liệu cũ nằm ngoài phạm vi.
