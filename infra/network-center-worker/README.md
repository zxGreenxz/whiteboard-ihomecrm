# iHomeCRM Network Center worker

## Camera: xem lại và xuất đoạn MP4

Host camera hiện dùng mục **VPS Minh (NAT)** trong vault. Lấy endpoint và mật khẩu
qua `scripts/lib/vault.mjs`, đối chiếu host key đã ghim; không suy ra host SSH từ
tên miền `crm-hermes` hoặc alias `hermes-vps` cũ. Không in credential ra log.

Gateway camera có thêm API `/camera-live/v1/recorders/:id/channels/:channel/archive`
và `/camera-live/v1/archive/:id[/file]`. Dùng cùng JWT, kiểm quyền theo đầu ghi/tòa
ở mỗi thao tác. Không cần migration hay mở thêm ingress. Tác vụ phải được poll
trong 75 giây; file sẵn sàng tự hết hạn sau 15 phút và được xóa ngay sau khi trình
duyệt tải xong. Dừng gateway cũng dừng bộ chuyển mã trong cùng systemd control group.

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

## Giám sát đầu ghi KBVISION / Dahua

`src/cameraMain.ts` là bộ thu thập riêng, không thay vòng giám sát MikroTik hoặc
thực thi lệnh. Nó đọc RPC2 (kênh), CGI Digest (ổ cứng) và luồng `VideoLoss`,
`StorageFailure`, `StorageNotExist`, `StorageLowSpace`. Không thay cấu hình ghi hình.
Trạng thái khởi tạo/không đọc được là UNKNOWN; sai quyền là AUTH_DENIED; slot
EMPTY không phải camera mất kết nối. Timestamp sự kiện là lúc bộ thu thập nhận
bản tin UTC. Chưa lấy bù nhật ký cũ từ đầu ghi, chưa có video gateway/WebRTC.

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

Xem trực tiếp mặc định dùng luồng phụ SD, có lựa chọn HD để nhận luồng chính
(độ phân giải theo cấu hình camera). Xem lại dùng RTSP `/cam/playback` từ bản ghi
chính. Khi chọn SD/HD, FFmpeg đã ghim chuyển mã ngay sang H.264 tối đa 854×480 /
1280×720; không tạo job MP4 hoặc lưu thêm video. Client cũ không gửi chất lượng
vẫn nhận codec/kích thước gốc. Mỗi lần tìm/tua tạo path UUID riêng; dừng, hết lease
hoặc hết khoảng xem sẽ xóa phiên WHEP, output và input, đồng thời dừng encoder.

MediaMTX cho encoder đọc/publish qua RTSP TCP chỉ tại `127.0.0.1:18895`; quyền
publish chỉ nhận tên `playback-<uuid>`. FFmpeg chỉ nhận URL loopback không chứa
credential, một thread giải mã/mã hóa và không tự khởi động lại. RTCP của đầu ghi
khi tăng tốc có thể làm timestamp FFmpeg nhảy ngược; luồng chuyển mã dùng đồng hồ
thực để phát ổn định, UI nhân theo tốc độ để ước tính vị trí. Dấu giờ trên hình
vẫn là giờ đầu ghi. Luồng gốc dùng timestamp RTP gốc. Giới hạn bốn phiên xem lại
bao gồm cả phiên chụp ảnh trước; ảnh trước luôn dùng SD và chỉ giữ trong bộ nhớ.

- Gateway kiểm JWT và quyền tòa nhà trước mở; renew/delete giữ ràng buộc chủ phiên.
- Khoảng xem tối đa 24 giờ, không giờ tương lai; tối đa 4 phiên phát lại toàn gateway.
- MediaMTX Control API chỉ nghe `127.0.0.1:18897`, chỉ quyền API từ loopback; không
  reverse proxy hoặc mở firewall cho cổng này. RTSP gốc và mật khẩu chỉ ở máy chủ.
- Thanh thời gian phát lại là ước tính theo RTSP. Không tự lấy mốc này điền trích xuất;
  đối chiếu đồng hồ trên hình rồi chọn khoảng xuất. Export vẫn dùng DHAV/kiểm coverage,
  SD 480p mặc định, tải về máy và xóa file tạm, không upload Supabase Storage.
- Khi rollout gateway, giữ artifact/config trước đó và kiểm stop/rollback; canary
  cần xác nhận hình giải mã thật, đóng phiên xóa path và export hoạt động độc lập.
