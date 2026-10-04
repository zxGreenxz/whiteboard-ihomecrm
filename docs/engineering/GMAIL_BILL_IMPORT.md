# Thiết lập lấy bill Gmail vào Thu chi

Tính năng dùng Gmail để điền sẵn phiếu chi từ thư Grab/Shopee. Người dùng mở **Lấy hóa đơn Gmail**, cấp quyền, chọn khoảng ngày, kiểm tra thư và hạng mục, rồi mở form thu chi hiện có. Chỉ nút **Lưu** trong form mới tạo phiếu. Người dùng phải chọn tòa và sổ quỹ; trạng thái duyệt/ghi sổ sau lưu tuân theo bộ máy thu chi đang dùng, không mặc định là phiếu nháp.

## Dữ liệu và quyền truy cập

- Dùng Google Identity Services (GIS) theo [token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model), chỉ yêu cầu `https://www.googleapis.com/auth/gmail.readonly`. Quyền này cho phép đọc thư và cài đặt Gmail; bộ lọc Grab/Shopee của ứng dụng không thu hẹp phạm vi OAuth ở Google. Không yêu cầu quyền gửi, sửa hay xóa thư. [Danh sách scope Gmail](https://developers.google.com/workspace/gmail/api/auth/scopes).
- Người dùng chủ động mở cửa sổ cấp quyền và tìm thư. Access token chỉ ở bộ nhớ trong phiên màn hình đang mở, không ghi localStorage, sessionStorage, log, database hoặc gửi tới server CRM. Không có refresh token, mật khẩu Gmail hay quét nền. Hết hạn token thì người dùng kết nối lại.
- Đóng màn hình xóa token cục bộ, không tự thu hồi quyền đã cấp ở Google. Người dùng có thể gỡ quyền tại [các kết nối bên thứ ba của tài khoản Google](https://myaccount.google.com/connections). Cấp quyền OAuth và phiên đăng nhập CRM là hai việc riêng.
- Nội dung thư được đọc trực tiếp từ Gmail REST trong trình duyệt, xử lý thành chữ, không hiển thị HTML email hay tự mở ảnh/link ngoài. Không lưu toàn bộ thư ở server. Khi người dùng bấm Lưu, server nhận thông tin phiếu đã kiểm tra và dấu nguồn tối thiểu để chống trùng: nhà cung cấp, mã đơn/chuyến, message ID và mailbox; hệ thống lưu liên kết phiếu cùng hash yêu cầu.
- Bản này không đọc tự động PDF/ảnh đính kèm hoặc email chỉ chứa file đính kèm. Mẫu chưa hỗ trợ, thiếu mã giao dịch, chưa thanh toán, hủy/hoàn tiền phải đối chiếu thư gốc hoặc nhập tay; không lấy một con số bất kỳ làm số tiền chi. Không tự tải chứng từ email lên kho file.

## Google Cloud và cấu hình công khai

1. Tạo Google Cloud project riêng cho thử nghiệm; dùng project riêng cho production theo [hướng dẫn chuẩn bị phát hành của Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance). Trong API Library của project tương ứng, bật **Gmail API**.
2. Trong **Google Auth Platform → Branding**, khai tên ứng dụng, email hỗ trợ/liên hệ; chuẩn bị homepage và privacy policy phản ánh dữ liệu thực sự đọc, gửi/lưu và cách gỡ quyền. Chọn Audience: **External** nếu có tài khoản Gmail cá nhân; chỉ chọn **Internal** khi project và mọi người dùng thuộc Google Workspace organization phù hợp. Khai scope `gmail.readonly` ở Data Access. [Thiết lập consent](https://developers.google.com/workspace/guides/configure-oauth-consent).
3. Với External đang **Testing**, thêm đúng địa chỉ Gmail vào **Audience → Test users**. Google hiện giới hạn tối đa 100 test users; quyền cấp ở chế độ Testing hết hạn sau 7 ngày. Đây là thời hạn consent thử nghiệm, không phải thời hạn access token. Google Workspace admin hoặc cơ chế bảo vệ tài khoản vẫn có thể chặn ứng dụng. [Giới hạn Audience](https://support.google.com/cloud/answer/15549945).
4. Trong **Clients**, tạo client **Web application**. Khai **Authorized JavaScript origins** gồm scheme/hostname/port, không có path hoặc wildcard. Local thêm `http://localhost` và `http://localhost:8080` (hoặc port thực tế); TEST thêm origin HTTPS Preview ổn định; production thêm origin HTTPS thực vào client production. Popup/callback JavaScript của token model không cần redirect endpoint CRM. [Thiết lập GIS](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).
5. Đặt cấu hình build công khai `VITE_GMAIL_CLIENT_ID` bằng OAuth client ID dạng `...apps.googleusercontent.com` ở đúng môi trường Vercel Development/Preview/Production. Local có thể đặt trong cấu hình môi trường đã được gitignore. Không ghi client secret, access token hay refresh token vào biến `VITE_*`. Bản này không cần OAuth client secret. Khởi động lại dev server hoặc build/deploy mới sau khi đổi client ID vì Vite đưa biến vào bundle lúc build.

Client ID không phải bí mật. Việc nhập giá trị vào môi trường build không tự bật Gmail API, đăng ký origin, thêm test user hoặc hoàn thành verification trên Google Cloud.

## CSP

`vercel.json` cho phép các đích cần cho token client và Gmail REST:

| Directive | Đích thêm | Mục đích |
|---|---|---|
| `script-src` | `https://accounts.google.com/gsi/client` | Nạp GIS trực tiếp từ Google |
| `connect-src` | `https://accounts.google.com/gsi/` | Các endpoint GIS |
| `connect-src` | `https://gmail.googleapis.com` | Đọc profile, danh sách và nội dung thư |
| `frame-src` | `https://accounts.google.com/gsi/` | Frame nội bộ của GIS |

Đối chiếu [CSP của Google](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid#content_security_policy). Giữ nguyên các giới hạn CSP còn lại. Bản này không dùng `gapi`, One Tap, stylesheet nút đăng nhập hay revoke; nếu thêm sau này, kiểm lại endpoint/style-src. Nếu hạ tầng thêm COOP, kiểm popup trên header thực trước khi phát hành.

## Điều kiện trước khi phát hành

`gmail.readonly` là **restricted scope**, cần verification theo audience; Publish app không xác nhận đã được duyệt. Google yêu cầu security assessment khi dữ liệu restricted được lưu/truyền qua server. CRM vẫn nhận dữ liệu phiếu/dấu nguồn suy ra từ Gmail: không coi xử lý raw email ở trình duyệt là bằng chứng được miễn. Chủ dự án cần khai đúng luồng dữ liệu và xác định yêu cầu với Google trước khi mở rộng. [Scope và verification](https://developers.google.com/workspace/gmail/api/auth/scopes).

Trước rollout, cần đủ:

- Gmail API, consent/audience/test users hoặc verification, client ID và authorized origins đúng môi trường; privacy policy công khai mô tả đúng luồng dữ liệu. Không trộn origin thử nghiệm vào OAuth client production.
- Migration/RPC nguồn bill đã qua lane và kiểm quyền, chống trùng, retry/concurrency trên TEST; không chỉ deploy giao diện khi backend chưa sẵn sàng.
- Draft PR, review và gate theo [Project Contract](PROJECT_CONTRACT.md), gồm kiểm tiền/schema liên quan. Thay đổi phát hành cần `npm run check:external-controls`; quy trình phát hành app giữ nguyên qua nhánh `production` và lệnh promote.
- Kiểm trình duyệt thật trên Preview HTTPS được cấp origin với tài khoản Gmail thử nghiệm: cấp/từ chối quyền, đóng/chặn popup, hết hạn token, chuyển mailbox, phân trang, thư không hỗ trợ, đóng form không ghi, chỉ Lưu mới ghi và bill trùng không tạo thêm phiếu. E2E ghi dữ liệu chỉ trong DEMO hoặc TEST.
- Kiểm console/CSP và Network trên deployment thật: GIS/Gmail tải được; không có token hoặc toàn bộ thư trong request tới CRM, log hay storage trình duyệt. Đối chiếu header response thực vì dev server không chứng minh CSP của Vercel.

Kiểm CSP tĩnh sẵn có:

```powershell
node --test scripts/__tests__/check-csp-build-attestation.test.mjs
```

Test trên chỉ kiểm hợp đồng CSP/build của repo. Mock transport, unit test, typecheck hoặc build xanh không chứng minh OAuth đã kết nối được, mẫu bill thật đã parse đúng, Google đã verification hay deployment đã có cấu hình. Ghi riêng bằng chứng Gmail thật và phần chưa kiểm trong biên nhận phát hành; không đính kèm token/nội dung thư riêng tư vào log hoặc artifact.

## Chạy lại kiểm thử trình duyệt trên local TEST

Spec `.e2e-fleet/specs/gmail-bill-import.spec.ts` chạy desktop và mobile với app thật, đăng nhập/đọc dữ liệu TEST thật; GIS, Gmail và hai RPC nhập bill dùng dữ liệu mô phỏng. Spec chặn mọi Supabase production request và mọi thao tác ghi chưa cho phép, không tạo phiếu thật.

Khởi động Vite trên `http://127.0.0.1:<port>` với `APP_ENV=test`, `VITE_APP_ENV=test`, cấu hình Supabase TEST và một `VITE_GMAIL_CLIENT_ID` mô phỏng. Tiến trình Playwright cần `FLEET_BASE_URL` trỏ đúng origin đó, `GMAIL_E2E_LOCAL_TEST=1`, `GMAIL_E2E_TEST_HOST=hzulujxgonszuleqticb.supabase.co`, cùng `GMAIL_E2E_TEST_EMAIL`, `GMAIL_E2E_TEST_PASSWORD`, `GMAIL_E2E_TEST_KEY` của TEST. Nạp credential vào môi trường tiến trình theo vault/lane hiện hữu; không ghi giá trị vào Git hoặc lịch sử lệnh. Actor TEST cần quyền tạo phiếu và dữ liệu tòa `102LVT` trong bản sao TEST hiện hành.

```powershell
npx playwright test --config .e2e-fleet/playwright.config.ts gmail-bill-import.spec.ts --workers 1
```

Thiếu cấu hình hoặc đích không đúng thì spec từ chối chạy; không tính đó là kiểm chứng đạt. Kiểm OAuth và CSP trên Preview HTTPS vẫn là bước riêng trước rollout.
