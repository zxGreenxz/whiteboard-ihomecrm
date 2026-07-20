# Runbook đối chiếu vận hành

Hai tài liệu này là quy tắc đi kèm script đối chiếu tiền thật. Chúng chứa mapping sổ và bẫy dữ liệu theo nguồn Excel cụ thể; không phải báo cáo tài chính tổng quát.

- [NABUBU ↔ Hiển Thu](nabubu-hienthu.md) — dùng với `node scripts/doi-chieu-nabubu-hienthu.mjs`.
- [686-TCB/BVB ↔ TKHIEP/Hiệp Thu](so-quy-686tcb.md) — dùng với `node scripts/doi-chieu-thu-tien.mjs` và `node scripts/doi-chieu-tm-hiepthu.mjs`.

Khi mapping tài khoản hoặc format Excel đổi, cập nhật cả script và runbook trong cùng commit. Không ghi PAT, số tài khoản đầy đủ mới hoặc dữ liệu nhận diện khách hàng vào log/tài liệu.
