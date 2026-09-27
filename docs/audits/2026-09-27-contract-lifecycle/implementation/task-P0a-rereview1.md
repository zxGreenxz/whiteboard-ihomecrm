### Spec Compliance

- ✅ Spec compliant trong phạm vi sửa P0a: capture thiếu hoặc bị sửa giờ không thể trả `ready: true`; các trường `rows`, `rowCount`, `sha256` được kiểm cấu trúc và hash được tính lại (`scripts/contract-lifecycle/preflight.mjs:128-134`). Live TEST transport vẫn là task riêng, không phải điều kiện của local API này.

### Strengths

- Sửa đúng điểm hở đã nêu, không mở rộng phạm vi; test mới bao phủ rows rỗng/sai, thiếu trường, count không nguyên và hash không hợp lệ (`scripts/tests/contract-lifecycle/preflight.test.mjs:50-67`). Test 1001 dòng trước đó tiếp tục kiểm đầu ra hợp lệ.

### Issues

- Không có finding còn mở trong diff sửa này.

### Assessment

**Task quality:** Approved.

**Reasoning:** Điều kiện so catalog giờ ràng buộc metadata với chính rows, nên capture thiếu/hỏng không báo sẵn sàng. Diff không cho thấy hồi quy mới. Không chạy lại test đã ghi trong báo cáo fix.
