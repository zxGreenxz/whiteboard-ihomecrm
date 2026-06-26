# Zalo Worker (zca-js) — Chat Zalo

Tiến trình Node giữ phiên **Zalo cá nhân** cho trang Chat Zalo của CRM.
Đọc `zalo_send_queue` → gửi bằng zca-js; nghe tin đến → ghi `zalo_messages`.
Web chỉ nói chuyện với Supabase; Realtime tự đẩy thay đổi sang trình duyệt.

> **Chạy LOCAL trước** để quét QR/test, rồi đưa lên **VPS** (pm2/systemd) để giữ
> phiên 24/7. **KHÔNG deploy lên Vercel.** Đây là project riêng (thư mục `worker/`).

## Chạy local

```bash
cd worker
cp .env.example .env          # điền SUPABASE_SERVICE_ROLE_KEY
npm install
npm start
```

1. Trên web mở **Chat Zalo** → bấm avatar đầu cột → **“Kết nối Zalo cá nhân”**.
2. Worker sinh **mã QR** → web hiện QR (qua Realtime).
3. Mở **Zalo trên điện thoại → Cá nhân → biểu tượng quét QR** → quét.
4. Worker đăng nhập xong → trạng thái **“Đang kết nối”**; gửi/nhận tin chạy thật.

Phiên (cookie) được lưu ở `worker/sessions/<account_id>.json` để lần sau **re-login
không cần quét lại**. Bị "văng nick" (mở Zalo Web nơi khác) chỉ rớt nhận tin — worker
tự re-login từ cookie; **dùng tài khoản phụ riêng cho worker**.

## Lên VPS (giữ 24/7) — vd Vultr ~$5/tháng

```bash
# cài Node LTS, copy thư mục worker + .env (+ sessions/ nếu muốn khỏi quét lại)
npm install --omit=dev
npm i -g pm2
pm2 start index.js --name zalo-worker
pm2 save && pm2 startup
```

Chỉ chạy **1 instance / nick** (single-listener). Deploy lại: dừng cũ trước (SIGTERM).

## Lưu ý

- `zca-js` là API Zalo **không chính thức** → rủi ro khoá nick; dùng tài khoản phụ,
  tránh thao tác bất thường/spam.
- Một số tên hàm/event của zca-js có thể đổi theo phiên bản; chỗ nhạy cảm trong
  `index.js` đã chú thích để chỉnh nếu cần.
- Hợp đồng bảng + kiến trúc đầy đủ: `../docs/zalo/ZALO-WORKER-SETUP.md`.
- OA/ZNS (chính thức, serverless, không VPS) để sau — schema đã chừa sẵn.
