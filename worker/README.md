# Zalo Worker (zca-js) — Chat Zalo

Tiến trình Node giữ phiên **Zalo cá nhân** cho trang Chat Zalo của CRM.
Đọc `zalo_send_queue` → gửi bằng zca-js; nghe tin đến → ghi `zalo_messages`.
Web chỉ nói chuyện với Supabase; Realtime tự đẩy thay đổi sang trình duyệt.

> Bản production chạy trên **VPS** bằng Docker (mục "Chạy bằng Docker" bên dưới). Chạy local
> chỉ để thử. **KHÔNG deploy lên Vercel.** Đây là project riêng (thư mục `worker/`).

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

## Chạy bằng Docker trên VPS (giữ 24/7)

Từ 10/2026 worker chạy trên VPS Minh, container `ihome-zalo-worker`, dựng từ đúng một SHA
trên `main` bằng [`deploy/zalo-worker.sh`](deploy/zalo-worker.sh) (VPS không có docker compose).

```bash
# 1. Trên máy dev: đưa đúng mã của SHA lên VPS
git archive <sha> worker | ssh <vps> "mkdir -p /opt/ihome-zalo-worker/source/<sha12> && tar -x -C /opt/ihome-zalo-worker/source/<sha12>"

# 2. Trên VPS (root): dựng image — tải font và so mã băm trong fonts.sha256
/opt/ihome-zalo-worker/source/<sha12>/worker/deploy/zalo-worker.sh build /opt/ihome-zalo-worker/source/<sha12>/worker <sha>

# 3. Lần đầu: /opt/ihome-zalo-worker/worker.env (chmod 600, root) gồm SUPABASE_URL,
#    SUPABASE_SERVICE_ROLE_KEY, ZALO_SESSION_KEY (`openssl rand -hex 32`), WORKER_ORG_IDS (tuỳ chọn)

# 4. Chạy hoặc thay bản (dừng êm bản cũ 30 giây trước)
/opt/ihome-zalo-worker/source/<sha12>/worker/deploy/zalo-worker.sh run ihome-zalo-worker:<sha12>
docker logs -f ihome-zalo-worker
```

Container chạy user 10002, hệ file chỉ đọc, giới hạn 384 MB RAM và 0,5 CPU, tự khởi động lại
khi lỗi. Chỉ thư mục `/opt/ihome-zalo-worker/sessions` ghi được; đó là nơi giữ phiên Zalo đã
mã hoá. Lùi bản: `zalo-worker.sh run ihome-zalo-worker:<sha12 cũ>`.

Chỉ chạy **1 instance** cho mọi nick (lease `zalo_worker_lease`). Đừng bật lại bản trên máy dev.

## Lưu ý

- `zca-js` là API Zalo **không chính thức** → rủi ro khoá nick; dùng tài khoản phụ,
  tránh thao tác bất thường/spam.
- Một số tên hàm/event của zca-js có thể đổi theo phiên bản; chỗ nhạy cảm trong
  `index.js` đã chú thích để chỉnh nếu cần.
- Hợp đồng bảng + kiến trúc đầy đủ: `../docs/zalo/ZALO-WORKER-SETUP.md`.
- OA/ZNS (chính thức, serverless, không VPS) để sau — schema đã chừa sẵn.
