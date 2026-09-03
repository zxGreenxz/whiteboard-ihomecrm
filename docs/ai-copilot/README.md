# AI Copilot

> **Current through:** 2026-08-28
> **Status:** source đã có chat streaming, đọc ảnh, gọi tool song song, tool nghiệp vụ và write preview/execute với nonce server; tuy nhiên release evidence chưa đủ để gọi production-ready hoặc full-site control (xem audit/spec).

## Tool đang chạy

Bảng dưới sinh từ `src/copilot/tools/**` — gate `npm run gate:copilot-tools` bắt mọi
sai lệch, kể cả một con số tool gõ tay ở chỗ khác trong file này.

<!-- COPILOT_TOOL_INVENTORY:START -->

<!-- KHỐI NÀY SINH TỰ ĐỘNG. Đừng sửa tay:
     node scripts/check-copilot-tool-inventory.mjs --write -->

**39 tool**: 35 đọc · 3 ghi · 1 điều hướng (chỉ mở trang / trả link).

| Tool | Loại | Quyền | Nguồn |
| --- | --- | --- | --- |
| `ban_do_he_thong` | read | — (lọc theo từng kết quả) | `src/copilot/tools/registry.ts` |
| `bang_luong_ky` | read | `salary.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_dat_coc` | read | `reports_finance.deposits_report` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_dong_tien` | read | `reports_finance.cash_flow` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_gia_han` | read | `reports_real_estate.renewals_transfers` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_hop_dong_moi` | read | `reports_real_estate.new_leases` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_lich_thu_tien` | read | `reports_finance.payment_schedule` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_phong_trong` | read | `reports_real_estate.vacant_rooms` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_thanh_ly` | read | `reports_real_estate.terminations` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_thu_chi_theo_ngay` | read | `reports_finance.daily_cashbook` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_thu_thua` | read | `reports_finance.overpayment` | `src/copilot/tools/nghiepVuTools.ts` |
| `bao_cao_ty_le_chi_phi` | read | `reports_real_estate.expense_ratio` | `src/copilot/tools/nghiepVuTools.ts` |
| `chi_so_cong_to` | read | `meter_readings.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `chi_tiet_hop_dong` | read | `contracts.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `coc_dang_giu` | read | `deposits.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `cong_no_tong_quan` | read | `invoices.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `cong_viec` | read | `tasks.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `doanh_thu_thang` | read | `reports_finance.analysis` | `src/copilot/tools/registry.ts` |
| `ghi_nho` | write | `ai_copilot.view` | `src/copilot/tools/memoryTools.ts` |
| `hoi_thoai_zalo` | read | `chat_zalo.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `hop_cho_duyet` | read | `income_expenses.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `hop_dong_sap_het_han` | read | `reports_real_estate.expiring` | `src/copilot/tools/registry.ts` |
| `huong_dan` | read | — (lọc theo từng kết quả) | `src/copilot/tools/registry.ts` |
| `liet_ke_chu_de` | read | — (lọc theo từng kết quả) | `src/copilot/tools/registry.ts` |
| `loi_nhuan_co_dong` | read | `shareholder_profit.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `mo_trang` | navigate | — (lọc theo từng kết quả) | `src/copilot/tools/registry.ts` |
| `phong_trong` | read | `rooms.view` | `src/copilot/tools/registry.ts` |
| `quen` | write | `ai_copilot.view` | `src/copilot/tools/memoryTools.ts` |
| `so_quy` | read | `cashbooks.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `tao_phieu_thu_chi_nhap` | write | `income_expenses.create` | `src/copilot/tools/writeTools.ts` |
| `tim_hoa_don` | read | `invoices.view` | `src/copilot/tools/registry.ts` |
| `tim_hop_dong` | read | `contracts.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `tim_khach_hang` | read | `customers.view` | `src/copilot/tools/registry.ts` |
| `tim_khach_hen` | read | `leads.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `tim_phieu_thu_chi` | read | `income_expenses.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `tim_xe` | read | `vehicles.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `ton_kho_vat_tu` | read | `materials.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `trang_thai_mang` | read | `network_center.view` | `src/copilot/tools/nghiepVuTools.ts` |
| `ty_le_lap_day` | read | `reports_real_estate.occupancy` | `src/copilot/tools/nghiepVuTools.ts` |

<!-- COPILOT_TOOL_INVENTORY:END -->

## Bề mặt đang chạy

- Nút Copilot chỉ hiện khi có session, entitlement và quyền `ai_copilot.view`.
- Chat gọi model cloud qua Edge Function `llm-proxy`; provider/key/quota/log nằm server-side. Ollama local được browser gọi trực tiếp khi bật.
- Chat đi qua `src/copilot/llmClient.ts` — client OpenAI-compat mỏng nói thẳng với proxy, hỗ trợ SSE, `content` multimodal và mảng `tool_calls`. `@page-agent/llms` chỉ còn phục vụ UI-control; ba giới hạn của nó (không stream, `content` chỉ là chuỗi, `toolCall` số ít) là lý do tách ra.
- Tra tài liệu: chunk theo heading, BM25 hai trường (thân + đường dẫn heading), bỏ dấu + bigram âm tiết + bảng đồng nghĩa + bảng hư từ. Index dựng LÚC CHẠY, chỉ từ tài liệu phiên có quyền đọc.
- Corpus gồm HAI nguồn: tài liệu nghiệp vụ `docs/he-thong/*.md` (allowlist = `manifest.json`) và hướng dẫn người dùng `docs/huong-dan-su-dung/**/index.md` (allowlist = `CAPABILITIES[*].docs.userDoc` có `visibility: public`, gác bằng chính quyền của capability đó). Trang hướng dẫn được dán nhãn `(nguồn: Hướng dẫn › <tiêu đề>)`; link nội bộ của docs-site bị làm phẳng thành chữ vì chúng thuộc một origin khác và sẽ 404 trong ứng dụng.
- Bộ nhớ dài hạn: bảng `ai_user_memory` (RLS own-row, riêng từng công ty, trần 30 mục do trigger cưỡng chế) + tool `ghi_nho`/`quen`. Tối đa 20 mục đi vào system prompt dưới khối "GHI NHỚ CỦA NGƯỜI DÙNG", mỗi mục cắt 100 ký tự, cả khối 2.000 — và khối mở đầu bằng câu nói rõ đây là DỮ LIỆU, không phải mệnh lệnh.
- System prompt mang ngày hôm nay và trang người dùng đang xem.
- Ảnh: nén client về 1024/JPEG, gửi kèm request, KHÔNG lưu.
- UI-control chỉ chạy khi entitlement + quyền `ai_copilot.ui_control` hợp lệ; agent có thể điều hướng, lọc và điền form trên route allowlist, nhưng nút Lưu/Xác nhận/Submit và hành động nguy hiểm bị loại khỏi vùng tương tác.
- Tool ghi `tao_phieu_thu_chi_nhap` bắt buộc trả bản xem trước và chờ người dùng bấm thẻ xác nhận; kết quả là phiếu `UNAPPROVED`, không gắn sổ.
- Luồng ghi hiện hành: tool chỉ gọi RPC preview; nonce được giữ trong bộ nhớ trình duyệt và không đi vào model context. Chỉ nút xác nhận của người dùng mới gọi RPC execute; server kiểm payload/nonce và tạo phiếu `UNAPPROVED` cùng audit trong boundary đã harden. Đây là source/static behavior đã có, nhưng vẫn cần negative E2E cho expiry, payload-change, replay và concurrency trước khi coi là release gate hoàn tất.

## Giới hạn đã biết

- Confirmation nonce đã thay cho boolean `xac_nhan` trong input schema. Kho client hiện là một khe global (đề xuất mới đè đề xuất cũ), nên chưa đáp ứng contract key theo conversation/action/payload-hash và chưa có đủ proof replay/concurrency.
- Organization context đã fail-closed và client dùng danh bạ Copilot. Các tool scoped, gồm `tim_khach_hang` và `hop_dong_sap_het_han`, hiện đi qua RPC server-side có scope tổ chức/toà nhà do server suy ra; live catalog/readback, migration provenance và role-real wrong-org/revocation E2E vẫn thiếu, nên chưa coi đây là boundary release an toàn cho superadmin.
- Evaluation live ngày 2026-08-13 vẫn là baseline lịch sử (headline 15 PASS / 7 PARTIAL / 8 FAIL; các case rows đếm được 16 PASS / 7 PARTIAL / 7 FAIL). Source đã được remediation một phần; harness production-like local đã pass 7/7 và các smoke/golden/page-agent safety spec đã có trong worktree, nhưng chưa có behavioral run hoặc rerun PostgREST deployment đúng SHA.
- Proxy kiểm cả provider lẫn `modelId`: model không có trong `ai_providers.models` bị từ chối 400 `bad_model` **trước khi** reserve, nên sửa request hoặc sửa `profiles.ui_preferences.copilotModel` không còn chọn được model admin chưa bật. Ngoại lệ có chủ ý: provider `mock`, vì `modelId` của nó là tên kịch bản dev/test — công tắc của nó là `ai_providers.enabled`.
- Model đã bật nhưng khai `input_price`/`output_price` bằng `0` vẫn được tính chi phí `0`. Hạn mức USD ba cấp chỉ chính xác bằng metadata giá, nên các cap vẫn là guardrail vận hành cho tới khi mọi model đang bật đều điền giá thật; thứ chặn chắc chắn hiện nay là `rate_per_min`.
- Bốn bảng RAG legacy `ai_conversations`, `ai_messages`, `ai_memory_embeddings`, `ai_usage_stats` và RPC/trigger liên quan đã bị drop bởi migration `20260710190000_drop_legacy_ai_assistant.sql`; runtime hiện dùng schema Copilot mới.

## Tài liệu

- [../AI-SYSTEM-AUDIT-OPTIMIZATION-ROADMAP-2026-07-20.md](../AI-SYSTEM-AUDIT-OPTIMIZATION-ROADMAP-2026-07-20.md) — audit/roadmap snapshot bất biến; không dùng số liệu cũ trong đó thay cho runtime hiện tại.
- [PLAN.md](PLAN.md) — thiết kế v2.1 và rationale; các câu “sẽ làm” cũ phải đọc cùng README này.
- [SPIKE-RESULTS.md](SPIKE-RESULTS.md) — bằng chứng spike ngày 10/07, không phải status vận hành.
- Tham chiếu hệ thống: [../he-thong/21-ai-copilot.md](../he-thong/21-ai-copilot.md).
- Audit/plan cập nhật 2026-08-28: [spec](../superpowers/specs/2026-08-13-ai-copilot-superadmin-control-design.md) và [plan](../superpowers/plans/2026-08-13-ai-copilot-superadmin-full-site-control.md).

## Nguồn sự thật

Runtime nằm ở `src/copilot/**`, backend tại `supabase/functions/llm-proxy`, schema/type trong generated types và migrations `20260710*ai_copilot*`, `20260711050000_ai_write_audit.sql`, các migration nonce/organization/audit-hardening `20260814032500`–`20260814034600`, cùng các migration scope/feature-flag Copilot `20260828140000`, `20260828160000`, `20260828170000`, `20260829020000`, `20260829030000`, `20260829040000`, `20260829050000` (chưa đủ provenance/live-catalog evidence để promote).
