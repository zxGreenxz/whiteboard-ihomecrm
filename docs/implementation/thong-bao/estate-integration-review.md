# Review độc lập Copilot/Lucky — phần thông báo trong kế hoạch

Review chỉ đọc 30/09/2026; không gọi RPC/storage/provider thật, không sửa domain tiền/auth/Lucky của root. Findings đã bàn giao chủ sở hữu và đọc lại source sau sửa; test final/E2E do owner/root xác minh.

- P1 Copilot money trước sửa: nonce chỉ có idempotency trong từng preview; unknown ở RPC rồi preview/nonce mới có thể tạo lại. Root/owner đã nối stable canonical payload identity, persistentFinancialWorkflow và domain read recovery tại src/copilot/tools/writeTools.ts thucThiXacNhanTheoTool. Income execute positive entity_id cho da_tao/da_tao_truoc_do; thiếu ID không thành success. Source sau sửa được đọc lại; chưa tự chạy test owner hoặc xác minh SQL production.
- P2 Lucky proof trước sửa: unknown upload bỏ planned UUID/path, retry tạo path mới. Root đã thêm onPlanned trước writer và onRejected chỉ cho response rejection xác định trong luckyDrawApi.uploadLuckyProof, lifecycle tới luckyProofUpload và pending trace. Source sau sửa được đọc lại; chưa chạy browser/transport thật.
- Finding auth parser ban đầu được rút lại sau tra live caller HanhDongTab: caller dùng persistentAdminWrite cùng positive exact-user/bool/updatedAt checks. Không coi parser loose riêng lẻ là lỗi live đã chứng minh và không đề nghị sửa lan man.

Review foundation tài chính/bàn giao/lương trước đó ở material-financial-review.md đã bàn giao root. Tài liệu review này không thay evidence test/gates cuối của owner; source scan không chứng minh mọi luồng đạt.
