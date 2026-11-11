# iHomeCRM Network Center worker

## Camera: xem lại và xuất đoạn MP4

Host camera hiện dùng mục **VPS Minh (NAT)** trong vault. Lấy endpoint và mật khẩu
qua `scripts/lib/vault.mjs`, đối chiếu host key đã ghim; không suy ra host SSH từ
tên miền `crm-hermes` hoặc alias `hermes-vps` cũ. Không in credential ra log.

Gateway camera có thêm API `/camera-live/v1/recorders/:id/channels/:channel/archive`
và `/camera-live/v1/archive/:id[/file]`. Dùng cùng JWT, kiểm quyền theo đầu ghi/tòa
ở mỗi thao tác. Không cần migration hay mở thêm ingress. Client lưu `requestId`
theo tài khoản/đầu ghi trước POST; GET `/recorders/:id/archive[/requests/:requestId]`
khôi phục tác vụ, DELETE theo requestId hủy được cả trước khi POST trả về. Retry
cùng mã/khoảng cắt dùng lại tác vụ; khác chủ không thể tìm hay hủy tác vụ đó.
Tác vụ mới tồn tại tối đa `2 × thời lượng + 120 giây`, kể cả khi đóng trang; client
cũ không gửi requestId vẫn dùng lease 75 giây. File sẵn sàng giữ 15 phút để tải lại,
mỗi lần tải đã bắt đầu có tối đa 120 giây hoàn tất. F5 chỉ tra tác vụ cũ; khi không
xác minh được hoặc gateway đã khởi động lại, cần người dùng bấm tạo lại. Dừng
gateway cũng dừng bộ chuyển mã trong cùng systemd control group.

Mặc định xem lại tắt. Trong credential `live-config.json`, chỉ đặt
`archiveEnabled: true` cùng `archiveOrigin` (HTTP/HTTPS IP private, cổng quản trị
qua WireGuard) cho đầu ghi Dahua/KBVISION hỗ trợ `loadfile.cgi?action=startLoad`
và bản ghi DHAV có timestamp theo đồng hồ UTC+7. Giữ nguyên credential và
`rtspOrigin` của đầu ghi. Video cũ có thể đã bị
ghi đè; lỗi lấy bản ghi không được diễn giải thành “không có sự việc”.

Release gateway phải chứa binary FFmpeg đã kiểm SHA-256, hỗ trợ DHAV demuxer,
trim/atrim/setpts/asetpts/showinfo, H.264/libx264 và AAC. Gateway tải bản gốc qua
HTTP Digest vào file riêng tư có giới hạn dung lượng rồi cắt theo timestamp
tuyệt đối; lấy thêm 5 giây trước điểm cắt để giải mã đủ khung ở biên tải xuống,
nhưng không dịch khoảng giờ người dùng chọn. Không dùng RTSP để cắt vì đầu ghi có thể nhảy tới keyframe kế tiếp,
làm mất phần đầu. Credential không đi vào URL/argv/log của FFmpeg.
Ghim binary bất biến trong `/opt/ihome-camera-live/releases/<sha>/`, khai báo
`CAMERA_FFMPEG_BINARY` và `CAMERA_FFMPEG_SHA256` trong runtime.env. Không lấy binary
latest lúc khởi động. Gateway xác minh digest trước khi mở listener. Unit mới
cấp `StateDirectory=ihome-camera-live` (0700), giới hạn RAM 768 MiB và CPU 150%.
Chỉ có một tác vụ chuyển mã cùng lúc, tối đa bốn file kết quả, mỗi file dưới 256 MiB;
bản DHAV đang xử lý cũng bị giới hạn dưới 256 MiB và xóa khi kết thúc tác vụ;
dành tối thiểu 2 GiB đĩa cho thư mục state. Không đặt video ở public webroot.

UI cho chọn khoảng tìm tối đa 24 giờ, phát WebRTC, kéo tua có ảnh xem trước và
tốc độ 1×/2×/4×/6×/8×. Xem lại mặc định SD 480p, tùy chọn HD 720p. Xuất tối đa
30 phút/file, mặc định SD 480p; có thể chọn HD 720p, Full HD 1080p hoặc kích thước
hình gốc, luôn giữ tỷ lệ và không phóng lớn nguồn.
Video chuyển mã H.264/AAC, không phải bản bitstream gốc. File bàn giao chứa độ phân giải, camera,
khoảng giờ yêu cầu, thời lượng video theo timestamp khung hình và SHA-256; không chứng nhận đồng hồ đầu
ghi chính xác. Khi bàn giao, đối chiếu dấu giờ trên hình. Gateway kiểm thời lượng
và timestamp khung hình đầu/cuối, từ chối khoảng rỗng giữa các khung hình lớn hơn
0,5 giây (hoặc hai chu kỳ khung hình với camera FPS thấp). Vẫn cần kiểm thực tế
firmware và gián đoạn vì thời lượng không tự chứng minh mọi khung hình nguồn.

Trước bật trên host: giữ bản release/config/unit cũ; kiểm file MP4 có hình, tua,
thời lượng, dấu giờ và hash trên đầu ghi được cấp quyền; thử hủy, hết hạn và người
không có quyền. Kiểm các ô live vẫn hoạt động khi xuất. Rollback về đúng artifact,
config và unit cũ, dừng process group trước đổi release; không ghi/xóa bản gốc
trên đầu ghi. Dọn file tạm chỉ trong StateDirectory đã xác minh. Chưa có các bằng
chứng đó thì chưa đánh dấu runtime production đã sẵn sàng.

## Camera: mã lỗi trả ra ngoài

Gateway camera nằm sau Cloudflare. Phản hồi HTTP 502/504 của origin không tới được
trình duyệt nguyên vẹn (mất thân JSON `{code}` và header CORS), nên `fetch` chỉ ném
"Failed to fetch" và giao diện báo "Mất kết nối tới máy chủ video" thay cho mã lỗi
thật (đo 10/11/2026: gateway trả 502 `CAMERA_UNAVAILABLE` đúng giây trình duyệt báo
lỗi mạng). Vì vậy `reply()` gửi mọi 502/504 ra ngoài bằng 503 (`publicStatus`);
client chỉ đọc `code` trong thân nên không phụ thuộc con số. Không thêm đường trả
phản hồi lỗi nào bỏ qua `reply()`. Tra lại mã trạng thái thật trên host (chỉ đọc):

```bash
timeout 75 tcpdump -i lo -l -n -A -s 160 'tcp port 18751' 2>/dev/null | grep --line-buffered -a -o -E 'HTTP/1\.1 [0-9]{3}[ A-Za-z]*'
```

## Camera: chia sẻ một kênh cho khách xem lại

Khách thuê không nhận tài khoản đầu ghi (đo 10/11/2026 trên KBVision 4.005: tài khoản
chỉ có `Replay_NN` vẫn tải được bản ghi kênh khác qua `loadfile.cgi`). Người xem
được Trung tâm mạng của toà tạo "lượt chia sẻ" (migration
`network_center_camera_share_v1`): một kênh, một khung giờ tối đa 24 giờ, hiệu lực
1 giờ đến 7 ngày. Khách mở `/xem-camera/<ID>`, nhập mật khẩu và nhận chuỗi phiên
`cs_…`; trình duyệt gửi chuỗi đó làm Bearer tới gateway thay cho JWT.

Gateway hỏi RPC `camera_share_authorize_v1` bằng publishable key ở mỗi lần phát, tua
và gia hạn (25 giây một lần), nên hết hạn hoặc thu hồi cắt hình trong tối đa một kỳ
lease (75 giây). Chuỗi phiên chỉ dùng được cho `GET /recorders/:id`, `/playback` và
`/sessions/:id[/renew|/playback]`; live, live-view, archive và ảnh thu nhỏ `/preview`
trả 403 `SHARE_SCOPE_DENIED` (ảnh thu nhỏ dùng chung hai chỗ toàn gateway với nhân viên).
Khung giờ của lượt chia sẻ luôn nằm trong quá khứ lúc tạo, nên khách không theo dõi
được gần như trực tiếp. Khách luôn xem bản chuyển mã SD/HD (H.264), mỗi lượt một người
xem, toàn gateway tối đa 2 luồng khách cùng lúc để còn chỗ cho xem lại của nhân viên.
Không cần đổi `live-config.json`, ingress hay unit; chỉ cần release gateway mới sau
khi migration đã áp. Gateway cũ nhận chuỗi `cs_…` sẽ trả 401 như JWT sai.

Trước bật: tạo một lượt trên đầu ghi được cấp quyền, kiểm khách chỉ xem được đúng
kênh và khung giờ, thử thu hồi lúc đang phát, thử hết hạn, và kiểm xem lại của nhân
viên vẫn chạy khi có khách đang xem.

## Camera: đầu ghi Hikvision ở cổng xem trực tiếp và xem lại

Mỗi đầu ghi trong `live-config.json` có thêm khoá tuỳ chọn `vendor`: `DAHUA`,
`KBVISION` hoặc `HIKVISION`. Không khai thì là Dahua/KBVision, URL và lệnh FFmpeg
giữ nguyên từng byte; giá trị lạ làm gateway từ chối cả file lúc khởi động. Mọi
quyết định theo hãng nằm trong `src/cameraLiveVendor.ts`; bảng URL và quy trình
chạy thử trên host ở `deploy/camera-live.md`.

- Xem trực tiếp: `/Streaming/Channels/<kênh×100+1>` (luồng chính) và `+2` (luồng
  phụ, dùng cho SD). Kênh 1 là 101/102, kênh IP 9 là 901/902.
- Xem lại: `/Streaming/tracks/<kênh×100+1>?starttime=YYYYMMDDTHHMMSSZ&endtime=…`,
  giờ là giờ trên đầu ghi (UTC+7) dù có chữ `Z`. Bật bằng `playbackEnabled: true`;
  cần `CAMERA_FFMPEG_BINARY`/`CAMERA_FFMPEG_SHA256`, không cần StateDirectory. Lượt
  chia sẻ cho khách dùng chung đường này.
- Không xuất được đoạn MP4: `archiveEnabled: true` hoặc `archiveOrigin` trên đầu ghi
  `HIKVISION` bị từ chối lúc khởi động. API báo `archive: false`, giao diện khoá
  phần trích xuất như với đầu ghi chưa bật xuất.
- Mã hoá luồng (Hik-Connect) đang bật thì hình trực tiếp không giải mã được, xem
  lại vẫn được. Gateway thử giải mã một khung hình luồng phụ trước khi mở trực
  tiếp và trả `LIVE_STREAM_UNDECODABLE` (HTTP 503) thay vì để ô hình đen; tắt mã
  hoá trên đầu ghi là xem được sau tối đa 30 giây, không cần khởi động lại.
- Tua và đổi tốc độ là mở luồng mới. Đo 11/11/2026 trên hai đời firmware (V4.70 và
  V3.4 năm 2017): cả hai nhận lệnh `Range` (`clock=` lẫn `npt=`) trên luồng đang
  chạy rồi bỏ qua, mốc xem không đổi. Vì vậy gateway không gửi Range cho Hikvision:
  API báo `playbackControl: false`, giao diện mở phiên mới bắt đầu tại mốc đã chọn,
  tốc độ đi theo `Scale` ngay ở lần PLAY đầu. `clock`/`npt` chỉ còn là lựa chọn dự
  phòng trong `hikvisionDefaults`.
- Luồng chuyển mã không có tiếng. Đo trên firmware V3.4: đầu ghi khai một track âm
  thanh ở cả trực tiếp lẫn xem lại nhưng không gửi gói âm thanh nào, mà FFmpeg chỉ
  ghi header đầu ra khi mọi luồng được map đã có khung đầu tiên, nên bộ chuyển mã có
  map track đó không bao giờ phát. Vì vậy mọi bộ chuyển mã của Hikvision (trực tiếp
  HD/Full HD, xem lại SD/HD/Full HD) chỉ có hình (`-an`); V4.70 có gửi tiếng nhưng
  xử lý giống nhau cho cả hãng. Luồng gốc (SD trực tiếp, "Gốc") vẫn chuyển nguyên
  những gì đầu ghi gửi.
- Tốc độ `[1, 2, 4]`: 2× đúng trên cả hai; V4.70 chạy đúng 4×/6×/8×; V3.4 chỉ đạt
  khoảng 3,6× khi xin 4× và không nhanh hơn khi xin 6×/8×. Luồng SD chuyển mã mở
  thẳng ở 4× đã đo chạy được trên cả hai (V3.4 chỉ khi bỏ tiếng). Vị trí trên thanh
  thời gian là đồng hồ của trình xem nhân tốc độ đã chọn, nên với đầu ghi chạy chậm
  hơn tốc độ xin thì thanh chạy trước hình và trình xem dừng trước khi hình tới cuối
  khoảng.
- Hình đầu tiên lệch mốc yêu cầu: đúng giờ hoặc trễ tới 2 giây (V4.70), sớm 1–11
  giây (V3.4, lùi về khung hình chính trước đó); cả hai tự dừng đúng `endtime`. Phiên
  của nhân viên xin đúng mốc đã chọn; dấu giờ trên hình là căn cứ.
- Lượt chia sẻ cho khách được chặn không lộ hình trước khung giờ theo số đo: phiên
  của khách xin đầu ghi trễ hơn 15 giây so với mốc khách chọn (`playbackStartLead`).
  Đo 17 lần mở trên firmware V3.4, đầu ghi bắt đầu sớm 0–11 giây, nên còn dư 4 giây;
  đây là biên thực nghiệm, không phải bảo đảm tuyệt đối, vì đầu ghi không cho đọc
  khoảng khung hình chính. Mốc sau khi dời mà chạm cuối khung thì bị từ
  chối (`SHARE_SCOPE_DENIED`). Gateway tự áp dụng, không phụ thuộc trình xem, và báo
  con số đó cho trình xem của khách (`playbackStartLeadSeconds`, chỉ có trong trả lời
  cho phiên khách, không có khi bằng 0): thanh thời gian của khách chạy từ đầu khung
  + 15 giây tới cuối khung và mốc gửi gateway là mốc trên thanh − 15 giây, nên thanh
  khớp mốc đầu ghi được xin và cuối khung được nhận ra như thường. Khách không xem
  được 15 giây đầu khung giờ. Dahua/KBVision không đổi.
- Lùi release: trước khi trỏ `current` về bản cũ hơn thay đổi này phải gỡ các đầu ghi
  có `vendor`/`playbackEnabled` khỏi `live-config.json`, nếu không schema cũ từ chối
  cả file và mọi đầu ghi mất hình (chi tiết ở `deploy/camera-live.md`).

> Tài liệu hệ thống (nguồn sự thật): `docs/he-thong/22-network-center.md`. File này là runbook host worker.

Worker Node.js riêng cho MikroTik Network Center. Tiến trình này chạy trên VPS,
gọi Edge API hẹp bằng `x-network-worker-secret`, rồi kết nối SSH tới MikroTik qua
địa chỉ quản trị WireGuard. Trình duyệt và Supabase không bao giờ nhận private key,
mật khẩu backup hay lệnh RouterOS tùy ý.

## Phạm vi

- Đọc inventory, telemetry, DHCP client và RouterOS neighbor.
- Aruba chỉ được phát hiện/hiển thị; không có credential và không có thao tác ghi.
- Aruba không có quota tổng. Mỗi request inventory tối đa 256 Aruba và worker gửi
  lặp bao nhiêu batch cũng được.
- Chỉ có bốn thay đổi RouterOS đóng: flush DNS cache, renew DHCP lease, cycle một
  access port đã được DB xác nhận, và reboot router.
- Mọi thay đổi có lease, backup mã hóa, export đã che sensitive, post-check, audit
  và reconciliation. Worker không nhận raw RouterOS CLI từ API hay người gọi.

## Secret files

`.env` chỉ chứa cấu hình không bí mật. Tạo thư mục secrets trên VPS, không nằm
trong repo:

```text
/opt/ihome-network-center/secrets/
  worker-secret
  router-credentials.json
  router-demo-key
  router-demo-backup-password
```

File gốc trên host phải thuộc `root:root`, mode `0600`; thư mục secrets
`root:root 0700`. Khi stage, activation script tạo snapshot content-addressed bất
biến dưới `/opt/ihome-network-center/secret-generations/<sha256>`, rồi materialize
đúng generation đó vào `/run/ihome-network-center/secret-generations/<sha256>`
với owner `10001:10001`, mode `0400`. Pointer release schema v2 khóa cả exact
image ID và secret generation nên current, canary, previous không thay secret của
nhau và reboot không fallback sang source mutable. Container chỉ mount generation
runtime được pointer chỉ định; không thể đọc kho secret gốc.

```json
{
  "router/demo": {
    "username": "ihome-nc-worker",
    "privateKeyFile": "/run/secrets/network-center/router-demo-key",
    "backupPasswordFile": "/run/secrets/network-center/router-demo-backup-password"
  }
}
```

Không dùng password SSH; worker yêu cầu key authentication và fingerprint
`SHA256:...` được pin trong connection record. Không truyền secret qua CLI hoặc
biến môi trường inline.

## Chạy kiểm thử

Yêu cầu Node 20:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Image smoke cục bộ:

```bash
docker build --build-arg NETWORK_CENTER_RELEASE_SHA=0000000000000000000000000000000000000000 \
  -t ihome-network-center-worker:local .
docker inspect ihome-network-center-worker:local \
  --format '{{json .Config.User}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
```

Compose không build/pull và chỉ nhận `NETWORK_CENTER_IMAGE_REF` đã được inspect.
Container chạy non-root, root filesystem read-only, drop toàn bộ Linux capability,
không mount Docker socket, dùng host networking để đi tới WireGuard và giới hạn
0.5 CPU / 512 MiB RAM / 128 process, Node old-space 320 MiB. Poll, claim và
command concurrency bị chặn tối đa 3; SFTP concurrency toàn process là 1.
Worker này độc lập, không đọc hoặc restart 9Router/Zalo.

## Bootstrap và immutable release trên Vultr

`install-host.sh` chạy root, tạo UID/GID 10001, cấu trúc
`/opt/ihome-network-center/{releases,incoming,state,config,secrets,secret-generations,backups,bin}`
và systemd unit. Script chỉ ghi `wg0.conf`/firewall fragment khi cả source lẫn
destination có marker `# ihomecrm-network-center-managed:v1`; bản cấu hình cũ
được hash và backup trước atomic replace. `wg0.conf` **không** còn bị thay nguyên
file: nó được merge additive theo `PublicKey` (xem phần onboarding bên dưới). Nó
không flush firewall và không restart workload khác.

Trước khi chạy trên host mới, đặt hai source ở thư mục chỉ root truy cập. Cả
`wg0.conf` và `ihome-network-center.nft` phải là regular file (không phải symlink),
owner `root:root`, mode `0600`, và chứa nguyên một dòng marker
`# ihomecrm-network-center-managed:v1`. Firewall fragment phải định nghĩa **duy
nhất một** `table inet ihome_network_center` và không gì khác: không `flush ruleset`,
không include, và không một statement nào nằm ngoài bảng đó — VPS này còn chạy một
production service không liên quan, `flush ruleset` sẽ xóa sạch firewall của nó.
Checker quét theo **từng ký tự** (nft không phải cú pháp theo dòng), nên một dòng
vừa đóng bảng managed vừa mở `table inet unrelated_service {`, hay bất kỳ statement nào
đi sau dấu `}` trên cùng dòng, đều bị từ chối; chuỗi trong nháy kép và comment `#`
được hiểu đúng, và mọi thứ checker không phân loại được chắc chắn (brace lệch, nháy
kép không đóng, bảng thứ hai) đều fail-closed. Installer tự
render preamble scoped (`table inet ihome_network_center` rồi
`delete table inet ihome_network_center`) lên trước nội dung fragment, nên chạy
lại `install-host.sh` là atomic replace đúng một bảng đó thay vì cộng dồn rule;
`ExecStop` của unit cũng chỉ `delete table inet ihome_network_center`. Chạy từ thư
mục `infra/network-center-worker` đã checkout đầy đủ các asset trong `deploy/`:

```bash
sudo ./deploy/install-host.sh \
  --asset-dir "$(pwd)/deploy" \
  --wg0-source /root/ihome-network-center-bootstrap/wg0.conf \
  --firewall-source /root/ihome-network-center-bootstrap/ihome-network-center.nft
```

### Onboard tòa 2..15 vào WireGuard

`wg0.conf` là một file dùng chung cho cả 15 tòa. Hành vi cũ — replace nguyên file —
im lặng xóa sạch peer của những tòa đã onboard trước đó, nên bootstrap giờ merge
theo `PublicKey`:

- Peer trong source được add mới hoặc update tại chỗ theo đúng `PublicKey`.
- Peer đã có trên host mà source không nhắc tới thì được **giữ**, và script in
  `retaining existing wg0 peer <key>`.
- Peer chỉ rời `wg0.conf` khi operator gọi đích danh public key của nó bằng
  `--remove-peer <PUBLIC_KEY>`. Preflight từ chối `--remove-peer` cho key host
  không có, cho key mà source vẫn còn định nghĩa, và cho cùng một key lặp lại.
- Ghi xong, script readback lại `wg0.conf` và **fail install** nếu một peer trước
  đó biến mất mà không có `--remove-peer` tương ứng
  (`refusing an install that would drop wg0 peer ...`).
- Hai peer không được claim trùng `AllowedIPs`, và cũng **không được claim dải
  chồng nhau** (`10.77.0.0/24` với `10.77.0.5/32` là hai chuỗi khác nhau nhưng
  cùng một route trên một interface — tòa nào wg0 match sau sẽ nuốt traffic của
  tòa kia). Script so sánh theo subnet thật (IPv4 lẫn IPv6, thiếu prefix hiểu là
  `/32`, `/128`), từ chối trước khi ghi, và **từ chối luôn** entry không đọc được
  thành IP network thay vì so sánh nó như chuỗi. Overlap cố ý thì phải khai báo
  tường minh `--allow-peer-overlap`; cờ đó **không** nới lỏng luật trùng khít —
  hai peer claim y hệt một địa chỉ luôn bị chặn.
- Đổi block `[Interface]` (PrivateKey/ListenPort/Address) làm vỡ cả 15 tòa cùng
  lúc vì router nào cũng pin key + port của VPS, nên nó cần opt-in tường minh
  `--allow-interface-change`. Không có cờ đó, install dừng ngay ở preflight.

Onboard tòa thứ N: source chỉ cần `[Interface]` y hệt bản đang chạy cộng thêm
`[Peer]` mới, không cần liệt kê lại peer của các tòa cũ.

```bash
sudo ./deploy/install-host.sh \
  --asset-dir "$(pwd)/deploy" \
  --wg0-source /root/ihome-network-center-bootstrap/wg0-building-07.conf \
  --firewall-source /root/ihome-network-center-bootstrap/ihome-network-center.nft
```

Gỡ một tòa (trả router, rotate key) — key phải khớp chính xác 44 ký tự base64:

```bash
sudo ./deploy/install-host.sh \
  --asset-dir "$(pwd)/deploy" \
  --wg0-source /root/ihome-network-center-bootstrap/wg0-building-07.conf \
  --firewall-source /root/ihome-network-center-bootstrap/ihome-network-center.nft \
  --remove-peer <PUBLIC_KEY-cua-toa-do>
```

Chấp nhận một overlap `AllowedIPs` cố ý (hiếm — chỉ khi thật sự muốn một peer ôm
supernet của peer khác):

```bash
sudo ./deploy/install-host.sh \
  --asset-dir "$(pwd)/deploy" \
  --wg0-source /root/ihome-network-center-bootstrap/wg0-building-07.conf \
  --firewall-source /root/ihome-network-center-bootstrap/ihome-network-center.nft \
  --allow-peer-overlap
```

Script preflight toàn bộ argument, source và asset trước khi tạo identity, cài
package hay ghi bất kỳ cấu hình host nào. `90-ihome-network-center.conf` phải
đúng chính xác managed marker và `net.ipv4.ip_forward=1`; mọi destination sẽ ghi
đều bị từ chối nếu là symlink (kể cả dangling), directory hay special file. Nếu
destination đã tồn tại dưới dạng regular file, nó cũng phải chứa đúng nguyên dòng
managed marker; bootstrap không ghi đè file chưa được iHomeCRM nhận quyền quản lý.

Khi activate network, script ép `ip_forward=0` và dừng `wg0`, khởi động/đọc lại
firewall trước, rồi mới bật forwarding và WireGuard. Drop-in systemd của
`wg-quick@wg0` cũng `Requires` và `After` firewall. Trước khi ghi, script snapshot
nguyên bytes/metadata/absent-state của toàn bộ script, unit và cấu hình managed,
cùng live forwarding và active/enabled state của firewall/WireGuard. Một
transaction duy nhất bao trùm `install_assets`, ghi WireGuard/firewall,
`nft --check` và activation; mọi lỗi hoặc signal đều rollback persistent lẫn live
state trước khi báo kết quả. Readback systemd chỉ coi rc `3` là inactive và rc `1`
là disabled theo từng lệnh; rc `2` hay lỗi DBus/query là fatal, không bị diễn giải
thành `false`.

Nếu không thể khôi phục chính xác (kể cả edge WG active nhưng firewall inactive),
script fail-closed: **gỡ bỏ** file sysctl.d managed của chính nó (chỉ khi file đó
mang managed marker — file không marker ở đúng đường dẫn đó là của người khác, script
báo lỗi chứ **không** xóa), đưa live `net.ipv4.ip_forward` về **đúng giá trị đã
capture trước khi chạy**, rồi stop/disable và strict-readback cả firewall lẫn
WireGuard. `ip_forward` là công tắc host-global và VPS này còn chạy một production
service không liên quan, nên script **không bao giờ persist một giá trị nó không sở
hữu** và **không bao giờ để cờ đó lệch khỏi giá trị ban đầu** — fail-closed cho tài
nguyên của mình là wg0 down + bảng nft managed được gỡ, không phải tắt forwarding
của co-tenant. Đường rollback cũng chỉ hạ forwarding xuống 0 khi giá trị capture
được vốn đã là 0. Nó chỉ báo fail-closed đã được thiết lập khi mọi command và
readback đều thành công; lỗi command vẫn được propagate dù trạng thái cuối nhìn có
vẻ an toàn.

Mọi file scratch trong lúc cài (đáng kể nhất là bản wg0.conf đã merge — chứa
`[Interface] PrivateKey` dùng chung cho cả fleet) được tạo mode `0600`/`0700` và bị
xóa trên **mọi** đường thoát: thành công, `die`, hay SIGHUP do rớt session SSH.

Từ Windows, xem plan không chạm host:

```powershell
.\infra\network-center-worker\scripts\deploy-vultr.ps1 `
  -ReleaseSha <40-char-sha> -HostName <vultr-host> `
  -KnownHostsFile <pinned-known-hosts> -PlanOnly
```

Live deploy dùng `git archive` của đúng clean HEAD, upload/hash lại trên host,
build image có OCI revision label, inspect exact image ID, rồi start canary với
emergency stop. Chỉ sau Docker health + heartbeat `PAUSED`/revision readback mới
drain active worker, switch và commit ba pointer JSON atomic:
`state/{current,previous,pending}.release`.

Promotion/rollback ghi journal durable `state/transition.json` qua phase
`prepared` rồi `commit-intent`, chốt sang `state/last-transition.json`
(`committed`/`compensated`), và chỉ dọn dẹp khi transition được finalize tường
minh. Mọi journal lẫn pointer đều ghi theo fsync file → rename → fsync directory;
snapshot secret generation cũng fsync từng file bên trong rồi mới fsync và rename
cả directory, nên một hard reset không thể để lại generation rỗng — thứ sẽ làm
`validate_pointer` từ chối `current.release` ở mọi lần boot. `inspect-state` trả
receipt v2 gồm image, container security, health và generation; `reconcile-state`
hội tụ về exact before/after sau mất SSH, reboot hoặc pointer move dở dang.
Cleanup xóa release/generation không còn pointer, journal hoặc container đang chạy
tham chiếu, cộng thêm residue của stage bị ngắt giữa chừng
(`releases/.release-<sha>.XXXXXX`, `secret-generations/.generation.XXXXXX`) — đúng
shape mktemp của chính project và chỉ trong thư mục của chính project, nên nó
không bao giờ đụng dữ liệu của workload khác trên cùng ổ đĩa.

Rollback không pull/build/retag. Nó chỉ khởi động `previous.imageId` đã có
local, đọc lại health/revision/generation và chứng minh assignment hash/count
không đổi bằng exact worker+revision readback:

```powershell
.\infra\network-center-worker\scripts\rollback-vultr.ps1 `
  -HostName <vultr-host> -KnownHostsFile <pinned-known-hosts> -PlanOnly
```

## Kill switch và vận hành

> **ĐỌC TRƯỚC KHI DÙNG TRONG SỰ CỐ — `EMERGENCY_STOP` là ĐÓNG BĂNG GHI, không
> phải DỪNG HẲN.** Tên gọi "emergency stop" dễ gây hiểu nhầm; đây là hợp đồng
> chính xác:
>
> | Thành phần | `NETWORK_CENTER_EMERGENCY_STOP=true` |
> | --- | --- |
> | Command claim (`CommandCoordinator.runCycle`) | **DỪNG** — không gọi claim RPC |
> | Thực thi command (`CommandProcessor`) | **DỪNG** — recheck trước SSH và ngay sau backup, trả `CANCELLED_BY_KILL_SWITCH` |
> | Poll loop read-only (`PollingCoordinator.runCycle`) | **VẪN CHẠY** — vẫn SSH vào router để đọc trạng thái |
> | Heartbeat | vẫn gửi, nhãn `PAUSED` |
> | Maintenance RPC + telemetry ingest | **VẪN CHẠY** |
>
> Đây là **chủ ý**, không phải sót: deploy gate khởi động canary với
> `EMERGENCY_STOP=true` rồi chỉ promote khi nó đã sinh ra bằng chứng poll thật
> (`scripts/deploy-vultr.ps1` → `Test-ExactPollEvidence`). Chặn polling ở đây sẽ
> khoá cứng mọi lần deploy đúng theo kiểu bế tắc mà cờ `-AllowNoConnections` đã
> bị từ chối vì nó. Giữ polling cũng có nghĩa operator **không bị mù** trong lúc
> xử lý sự cố.
>
> Hệ quả phải biết: một canary "paused" **vẫn nói chuyện với router production**.
> Nếu sự cố là *worker đang làm hại router* (ví dụ SSH dồn dập làm CPU router
> quá tải) thì `EMERGENCY_STOP` **không** cứu được — phải `docker compose stop`
> hoặc `systemctl stop network-center-worker`. Đó mới là "dừng hẳn".
>
> Hợp đồng này được ghim bằng test (`test/fleetHealthHonesty.test.ts` →
> `EMERGENCY_STOP contract`), nên không đổi được một cách âm thầm theo cả hai
> chiều.

- Giữ `NETWORK_CENTER_EMERGENCY_STOP=true` trong lần deploy đầu. Polling vẫn đọc
  trạng thái nhưng command loop không gọi claim RPC; canary không thể lấy lease
  của worker active. Processor vẫn recheck kill switch trước SSH và ngay sau
  backup để chặn race.
- Sau khi heartbeat, WireGuard, host-key pin và read-only polling đều xanh, đổi
  bằng lệnh host fail-closed sau; script giữ exact image, backup env rồi restart:

  ```bash
  sudo /opt/ihome-network-center/bin/activate-release.sh set-emergency-stop false
  ```

  Việc "tự phục hồi env cũ nếu health readback thất bại" **chỉ đúng cho
  `set-emergency-stop false`** (gỡ pause). Chiều ngược lại,
  `set-emergency-stop true`, **không bao giờ tự revert**: health gate chỉ xanh sau
  một vòng poll hoàn chỉnh cộng round trip Supabase, mà đó đúng là thứ con worker
  vừa bị pause không thể làm được — revert ở đó sẽ tự bật lại chính con worker
  operator đang muốn dừng. Lệnh chỉ verify container còn `running` rồi trả
  `health:"unverified"` kèm cảnh báo trên stderr; nếu container không chạy thì nó
  die và **vẫn để nguyên env đã pause**. Thấy `health:"unverified"` nghĩa là stop
  đã áp dụng nhưng chưa được health readback xác nhận — **không phải** stop thất
  bại. Muốn xác nhận thì đọc heartbeat `PAUSED` hoặc `inspect-state`.
- Khi boot (`start-current`) đọc lại `state/runtime-intent.json` mà **không** áp
  dụng lại được (intent trỏ tới release không còn là current, hoặc worker không
  trở lại đúng runtime state đã ghi), script **quarantine** file đó sang
  `state/runtime-intent.corrupt.<timestamp>.<pid>` kèm cảnh báo stderr rồi đi tiếp,
  giống hệt cách transition journal hỏng được xử lý — `die` ở đây sẽ kẹt boot và
  mọi command khác cho tới khi có người SSH vào xóa file bằng tay. Với intent của
  release **đang** current, giá trị emergency stop đã được ghi vào env của release
  trước khi quarantine, nên quarantine không bao giờ tự gỡ pause.
- `changesPaused` theo từng tòa là kill switch thứ hai và được kiểm tra lại trước
  khi kết nối router.
- Healthcheck đọc timestamp tại `/tmp/network-center-worker-health`; log JSON được
  rotate ở 3 file x 10 MiB và mọi key/secret/token/password đều bị che.
- Binary backup mã hóa AES-SHA256 chỉ nằm trong volume VPS. Supabase chỉ nhận
  export `show-sensitive=no` đã redaction lần hai và SHA-256.

## Mô hình lỗi

- Lỗi kết nối trước thao tác: retry có backoff.
- Lỗi vĩnh viễn/validation: `FAILED`.
- Cycle port hoặc reboot bị mất kết nối sau khi đã gửi lệnh: `UNCERTAIN`, không
  tự chạy lại. Queue sẽ phát reconciliation claim; worker chỉ post-check, không
  lặp thao tác disruptive.
- Lỗi control-plane (Edge API) cũng theo cùng luật đó: chỉ là retry sạch khi nó
  xảy ra **trước** khi thao tác router được bắt đầu; nổ **sau** một thao tác
  disruptive thì thành `UNCERTAIN` để reconciliation lo, không phải `FAILED`.
- `UNCERTAIN` của cycle port **không** có nghĩa là port nằm disable vĩnh viễn:
  worker arm một one-shot `/system/scheduler` guard trên chính router trước khi
  disable bất cứ thứ gì, nên container bị SIGKILL, WireGuard đứt hay host reboot
  giữa cửa sổ cycle thì router vẫn tự enable lại port rồi tự xóa guard. Bằng chứng
  disable→enable được ghi durable dưới `backups/router/.port-cycle-evidence`, để
  một pass reconciliation chạy trên connector/process mới vẫn chứng minh được cycle
  đã thực sự xảy ra.
- SIGTERM/SIGINT abort hai loop, đợi công việc đang chạy, gửi heartbeat `STOPPING`
  rồi thoát trong `stop_grace_period`.

## Heartbeat nói thật về sức khỏe fleet

Hai loop cùng gửi heartbeat và chúng **không** giống nhau:

| | Poll heartbeat (cuối mỗi `runCycle`) | Periodic heartbeat (60 s, `main.ts`) |
| --- | --- | --- |
| `status` | suy ra từ chính vòng vừa chạy | suy ra từ **vòng poll gần nhất đã hoàn tất** (`PollingCoordinator.fleetStatus()`) |
| `safeMetadata` | có `connections` / `successfulPolls` / `failedPolls` | **không có** ba key đó |

Vì sao periodic heartbeat **không** được mang ba key poll: migration
`20260729136000` đóng dấu `poll_observed_at = now()` ngay khi có **bất kỳ** key
nào trong ba key đó. Lặp lại số cũ ở đây sẽ chế ra "bằng chứng poll tươi" từ số
liệu cũ, và freshness gate của deploy sẽ đọc đồng hồ của heartbeat này thay vì
của một lần quan sát thật.

`status` được suy ra chứ **không** được khẳng định:

- `PAUSED` — `EMERGENCY_STOP` bật (trạng thái operator, không phải tuyên bố sức khỏe).
- `ONLINE` — vòng poll gần nhất hoàn tất và **không** có connection nào đang lỗi.
- `DEGRADED` — có connection lỗi, hoặc inventory degraded, **hoặc chưa có bằng
  chứng nào**: trước vòng poll đầu tiên, và sau bất kỳ vòng nào chết giữa chừng.
  Schema không có trạng thái "chưa biết", nên `DEGRADED` là sàn trung thực.

Đếm poll tính trên **tập connection đã cấu hình**, không phải tập được thử trong
vòng này:

- `connections` = số connection MIKROTIK/ROUTEROS_SSH còn bật monitoring — khớp
  đúng predicate của `expectedConnectionCount` (`20260729143000`). Backoff
  **không bao giờ** làm con số này nhỏ đi.
- `successfulPolls` = poll thành công trong vòng này **+** connection bị bỏ qua
  vì lần poll trước đã thành công và chưa hết `pollIntervalSeconds` (`freshPolls`).
- `failedPolls` = poll lỗi trong vòng này **+** connection bị backoff hoãn
  (`deferredPolls`).
- `attemptedPolls` / `deferredPolls` / `freshPolls` được gửi kèm để phân biệt
  "không thử vì đang backoff" với "không có gì để thử" — hai trạng thái ngược
  nhau nhưng trước đây hiện ra y hệt.

Backoff (`5s · 2^n`, trần 300 s) có thể đẩy một connection lỗi ra khỏi vòng poll
khi delay vượt chu kỳ 60 s, nên periodic heartbeat không được ghi đè `ONLINE`
cứng. Nếu không giữ invariant này, một fleet mà **mọi** router đều mất kết nối có
thể hiện thành `ONLINE / connections=0 / successful=0 / failed=0`, trùng khít chữ
ký của một fleet khỏe mạnh chưa provision gì. Server chốt thêm lần nữa:
`20260729144000` hạ `ONLINE` xuống `DEGRADED` khi bằng chứng poll (của chính
heartbeat đó, hoặc bằng chứng đang lưu của cùng release) có `failedPolls > 0` —
chỉ hạ, không bao giờ nâng — nên một bản rollback về image cũ vẫn không nói dối
được.

## Giám sát đầu ghi KBVISION / Dahua / Hikvision

`src/cameraMain.ts` là bộ thu thập riêng, không thay vòng giám sát MikroTik hoặc
thực thi lệnh. Nó đọc RPC2 (kênh), CGI Digest (ổ cứng) và luồng `VideoLoss`,
`StorageFailure`, `StorageNotExist`, `StorageLowSpace`. Không thay cấu hình ghi hình.
Trạng thái khởi tạo/không đọc được là UNKNOWN; sai quyền là AUTH_DENIED; slot
EMPTY không phải camera mất kết nối. Timestamp sự kiện là lúc bộ thu thập nhận
bản tin UTC. Chưa lấy bù nhật ký cũ từ đầu ghi, chưa có video gateway/WebRTC.

Đầu ghi Hikvision (vendor `HIKVISION`) được đọc bằng ISAPI trong
`src/camera/hikvisionClient.ts`: kênh analog, kênh IP kèm cờ online và ổ cứng,
chỉ bằng HTTP Digest, không bao giờ Basic. Bản này chưa có luồng sự kiện: độ phủ
luôn là theo lần kiểm tra, không sinh `COVERAGE_GAP` hay
`EVENT_STREAM_UNAVAILABLE`. Một kênh/ổ không xác định được thì riêng nó là
UNKNOWN, đầu ghi vẫn ONLINE kèm cờ thiếu dữ liệu. Tên phần tử XML, cách đọc
`resDesc`, cờ online và cách đánh số kênh IP đã đối chiếu ngày 10/11/2026 trên
hai đầu ghi thật: một DVR lai 8 kênh analog (firmware V4.70, kênh IP mang id 9
và 10) và một DVR 16 kênh (firmware V3.4, chỉ có HTTPS với chứng thư tự ký đã
hết hạn). Vẫn chỉ theo tài liệu ISAPI: nhánh "id IP đếm lại từ 1 thì cộng số
kênh analog", các từ trạng thái ổ cứng ngoài `ok`, và thân phản hồi lúc bị khoá
đăng nhập. Chưa có xem trực tiếp hay xem lại cho vendor này.

Vendor đi từ database (`camera_recorders.vendor`, ra khoá `vendor` của
`camera-connections`), không khai trong file credential. `KBVISION`, `DAHUA` hoặc
thiếu khoá dùng client Dahua; `HIKVISION` dùng client ISAPI; giá trị khác thì bỏ
qua đầu ghi đó, ghi log và không mở kết nối nào. Sau AUTH_DENIED bộ thu thập chờ
300 s với Dahua và 1800 s với Hikvision, vì đầu ghi Hikvision khoá tài khoản và
IP nguồn sau vài lần đăng nhập sai. Bị từ chối (401) là chung cuộc, không gửi
lại. Ngoại lệ duy nhất: socket tái dùng bị đầu ghi đóng trước khi trả lời thì
yêu cầu đó được gửi lại đúng một lần trên kết nối mới, và từ đó client thôi tái
dùng socket với đầu ghi này.
Thời gian chờ Hikvision được giữ khi collector dựng lại trong cùng tiến trình,
còn restart service là một lần thử mới: sửa mật khẩu trong file rồi mới restart.

Tab Camera chỉ đọc qua hai RPC có kiểm quyền theo tòa, phân trang lịch sử theo
thời gian và ID. Dữ liệu quá hạn được hiển thị chưa xác minh, không suy tất cả
camera đều offline. Transition từ polling do database sinh, chống lặp qua restart
và replay. Luồng sự kiện chỉ bao phủ các mã trên; `COVERAGE_GAP` ghi nhận restart
hoặc mất luồng, không tuyên bố mọi sự kiện trong khoảng gián đoạn đều đã lưu.

Trước phát hành cần migration `network_center_camera_monitoring_v1`, Edge routes
`camera-connections`/`camera-ingest`, read RPC và kiểm JWT/RLS theo Contract.
Operator dùng `network_center_admin_enroll_camera_v1` (service_role only) để ghim
recorder vào đúng organization/building/router connection đã có. Worker không
được tự gán scope hoặc đổi đầu ghi. Không ghi fixture vào org thật.
Vendor `HIKVISION` cần thêm migration `network_center_camera_vendor_hikvision_v1`
và collector bản mới chạy TRƯỚC khi đăng ký đầu ghi: bản cũ bỏ qua khoá `vendor`
và sẽ nói giao thức Dahua với đầu ghi đó.

Build artifact bằng `node infra/network-center-worker/scripts/build-camera-monitor.mjs`.
Artifact và SHA256 ở `infra/network-center-worker/camera-dist/` (ignored). Chỉ
chuyển artifact của SHA đã review/gate đạt; đối chiếu hash sau khi tải lên.
Runtime yêu cầu Node **22.23.2**, service mẫu `deploy/camera-monitor.service` kiểm
đúng phiên bản trước khi chạy, không mở listening port.

Layout cho mỗi bản phát hành:

- `/opt/ihome-camera-monitor/releases/<reviewed-sha>/cameraMain.mjs` cùng SHA256SUMS;
  `current` trỏ bản được duyệt, giữ bản trước để rollback.
- `/opt/ihome-camera-monitor/config/worker.env` chỉ chứa `NETWORK_CENTER_EDGE_URL`
  của đúng project; endpoint HTTPS, không userinfo/query.
- `/opt/ihome-camera-monitor/secrets/worker-secret` là credential worker có scope
  router phù hợp; `/opt/ihome-camera-monitor/secrets/camera-credentials.json` map
  credentialRef sang `{origin,username,password}`. Hai file root-only0600, thư mục0700.
  `origin` phải đúng IP private+port của enrollment, không dùng DDNS/publicIP.
  systemd LoadCredential cấp bản mount riêng cho DynamicUser; không truyền mật khẩu
  qua CLI, URL, frontend, Git hoặc log. Vault950NK dùng các tên
  `NVR_950NK_USERNAME`/`NVR_950NK_PASSWORD`, nạp qua `scripts/lib/vault.mjs`.
- Đầu ghi `HIKVISION` có origin `https://` bắt buộc thêm khoá `tlsFingerprint256`
  trong mục của nó: SHA-256 của chứng chỉ DER, 64 ký tự hex, hoa hay thường, có
  hoặc không dấu `:`. Lấy từ trong mạng quản trị bằng
  `openssl s_client -connect <ip>:<port> </dev/null | openssl x509 -noout -fingerprint -sha256`.
  Chứng chỉ tự ký hoặc hết hạn vẫn dùng được vì collector chỉ tin đúng dấu vân
  tay này và so nó trước khi gửi bất kỳ byte HTTP nào; lệch thì đóng kết nối, log
  `TLS_PIN_MISMATCH` và đầu ghi hiện UNKNOWN. Đầu ghi đổi chứng chỉ (reset, nâng
  firmware) thì phải cập nhật khoá. Khoá đặt cạnh origin `http://` làm cả file bị
  từ chối; đặt cho đầu ghi Dahua thì đầu ghi đó không được thu thập. Collector
  bản cũ từ chối cả file khi gặp khoá này: thêm khoá SAU khi lên bản mới, gỡ khoá
  TRƯỚC khi lùi về bản cũ.

Đường HTTP phải chạy qua mạng quản trị riêng đã kiểm chứng. Giữ NAT giới hạn
nguồn/interface/đích và rollback riêng; không mở WAN để chạy collector.
Snapshot/luồng sự kiện được xếp hàng trên `/var/lib/ihome-camera-monitor/<recorder-id>`.
Mỗi batch ghi atomic+fsync; chỉ xóa sau receipt ingest. Giới hạn64MiB/recorder:
đầy thì báo lỗi và dừng lưu mới, không xóa lịch sử cũ. Khi CRM trở lại, batch giữ
nguyên eventKey để chống trùng; ingest nhận dữ liệu chậm tối đa30ngày. Theo dõi
log delivery/capacity và UI freshness, không coi process đang chạy là bằng chứng
đã thu thập thành công.
Batch thuộc connection cũ hoặc quá cửa sổ30ngày được chuyển nguyên vẹn vào
`quarantine/BINDING_CHANGED` hoặc `quarantine/EXPIRED` để operator đối chiếu;
không gửi lại dưới danh tính connection mới. Có log lỗi và COVERAGE_GAP cho
khoảng không nhập được này; batch hợp lệ phía sau tiếp tục gửi.

Canary: kiểm snapshot đúng số kênh, heartbeat stream và đọc lại CRM; kiểm ngắt/kết
nối bằng fixture, không tự tắt camera đang bảo vệ nhà để thử. Sau rollout mới có
thể xác nhận hoạt động liên tục; không dùng unit test thay bằng chứng live.
Rollback collector: stop service, chuyển `current` về artifact có hash đã xác
minh rồi start; giữ nguyên state/outbox và credentials. Không drop schema hoặc
xóa journal để rollback app. Nếu chưa có bản cũ thì stop service, UI sẽ hết độ mới.

### Phát lại trực tiếp và trích xuất

Xem trực tiếp mặc định dùng luồng phụ SD; SD và gốc đi trực tiếp qua MediaMTX,
giữ video và âm thanh tương thích WebRTC (đã kiểm G.711/PCMA trên đầu ghi).
HD 720p và Full HD 1080p dùng encoder chung theo kênh/chất lượng, H.264/Opus.
Trình duyệt giữ một MediaStream khi track âm thanh đến sau và hiện ngay khung hình
đầu tiên đã giải mã. Xem lại dùng RTSP `/cam/playback` từ bản ghi
chính. FFmpeg chuyển mã ngay sang H.264: SD tối đa 854×480, HD 1280×720,
Full HD 1920×1080 hoặc kích thước gốc (không nâng độ phân giải nguồn). Không tạo
job MP4 khi xem lại. Lựa chọn trực tiếp/xem lại/xuất được lưu riêng trong
profiles.ui_preferences theo tài khoản qua RPC set_my_ui_preference; SD cho
người chưa chọn, bộ nhớ máy hỗ trợ khi mất mạng. Không ghi đè các preference khác.
Tua/đổi tốc độ dùng lại RTSP, encoder và WHEP; chỉ đổi chất lượng/khoảng/kênh mới
tạo phiên khác. Dừng, hết lease hoặc hết khoảng xem xóa cả output/input/encoder.

Build media bằng `node infra/network-center-worker/scripts/build-camera-media.mjs`
(Go bootstrap cần có trong PATH). Script kiểm commit upstream v1.21.2, áp dụng
`media/playback-control.patch`, dùng Go 1.27.0 và xuất mediamtx, LICENSE cùng
MEDIA-PROVENANCE.json vào camera-dist. `npm test` của worker kiểm cả patch Go.
Triển khai cả gateway và binary này vào cùng release; đối chiếu hash provenance,
ghim CAMERA_MEDIA_SHA256. Không dùng binary upstream chưa vá cho gateway này.
Rollback chuyển đồng thời gateway, binary và runtime.env về release đã xác minh.

MediaMTX cho encoder đọc/publish qua RTSP TCP chỉ tại `127.0.0.1:18895`; quyền
publish chỉ nhận tên `playback-<uuid>`. FFmpeg chỉ nhận URL loopback không chứa
credential, một thread giải mã/mã hóa và không tự khởi động lại. RTCP của đầu ghi
khi tăng tốc có thể làm timestamp FFmpeg nhảy ngược; luồng chuyển mã dùng đồng hồ
thực để phát ổn định, UI nhân theo tốc độ để ước tính vị trí. Dấu giờ trên hình
vẫn là giờ đầu ghi. Luồng client cũ không chuyển mã dùng RTP gốc. Media chờ reader
PLAY trước khi yêu cầu bản ghi, tránh mất keyframe đầu. Lệnh tua được xác nhận
sau PLAY thành công, timeout 3 giây; về 1× bỏ hẳn Scale vì firmware đầu ghi trả
quá ít khung hình nếu gửi Scale: 1. Giới hạn bốn phiên xem lại. Ảnh trước dùng
một JPEG 320px trong bộ nhớ, tối đa 128KiB/5 giây xử lý, hai yêu cầu toàn gateway
và một yêu cầu/tài khoản; hủy phải đợi tiến trình thoát trước khi nhả chỗ.

- Gateway kiểm JWT và quyền tòa nhà trước mở; renew/delete giữ ràng buộc chủ phiên.
- Khoảng xem tối đa 24 giờ, không giờ tương lai; tối đa 4 phiên phát lại toàn gateway.
- MediaMTX Control API chỉ nghe `127.0.0.1:18897`, chỉ quyền API từ loopback; không
  reverse proxy hoặc mở firewall cho cổng này. RTSP gốc và mật khẩu chỉ ở máy chủ.
- Thanh thời gian phát lại là ước tính theo RTSP. Không tự lấy mốc này điền trích xuất;
  đối chiếu đồng hồ trên hình rồi chọn khoảng xuất. Export vẫn dùng DHAV/kiểm coverage,
  SD 480p mặc định, tải về máy; file tạm xóa khi hủy/hết hạn, không upload Supabase Storage.
  Bộ xuất dùng hai thread giải mã, một thread filter/mã hóa; tắt checksum từng frame
  trong showinfo nhưng vẫn kiểm PTS/coverage/gap và SHA-256 của file hoàn chỉnh.
  Giới hạn một bộ xuất gồm cả giai đoạn dọn dẹp, ngân sách nguồn + đầu ra 1 GiB và
  giữ tối thiểu 2 GiB đĩa trống. Tiến độ phân biệt lấy nguồn, mã hóa, kiểm file và tải.
- Khi rollout gateway, giữ artifact/config trước đó và kiểm stop/rollback; canary
  cần xác nhận hình giải mã thật, đóng phiên xóa path và export hoạt động độc lập.
