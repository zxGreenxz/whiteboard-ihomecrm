# iHomeCRM Network Center worker

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
nhất** `table inet ihome_network_center`: không `flush ruleset`, không include, và
không một statement nào nằm ngoài bảng đó — VPS này còn chạy một production
service không liên quan, `flush ruleset` sẽ xóa sạch firewall của nó. Installer tự
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
- Hai peer không được claim trùng `AllowedIPs`; merge bị từ chối trước khi ghi.
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
script atomically ghi và verify fallback persistent gồm đúng managed marker với
`net.ipv4.ip_forward=0`, ép live forwarding off, rồi stop/disable và strict-readback
cả firewall lẫn WireGuard. Nó chỉ báo fail-closed đã được thiết lập khi mọi command
và readback đều thành công; lỗi command vẫn được propagate dù trạng thái cuối nhìn
có vẻ an toàn.

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
