# Demo MikroTik — WireGuard/worker runbook

Runbook này dành riêng cho MikroTik dư dùng làm demo. Không áp dụng thẳng lên
router đang phục vụ nhà trọ. Mục tiêu là giữ đường phục hồi LAN cho tới khi
WireGuard, SSH key, host-key pin và polling đều đã được xác minh.

## 0. Điều kiện dừng ngay

Dừng và rollback nếu một trong các điều sau xảy ra:

- máy vận hành mất đường LAN tới router;
- WAN demo mất ngoài khoảng reboot dự kiến;
- fingerprint SSH qua LAN và WireGuard không giống nhau;
- generated file xuất hiện trong Git workspace hoặc log;
- worker cần password SSH, raw RouterOS CLI hoặc service-role key;
- port định cycle đang nối máy Codex/uplink/WAN/WireGuard.

Không apply `router-lockdown.rsc` trong cùng bước với bootstrap.

## 1. Giữ đường phục hồi và chụp trạng thái trước thay đổi

Giữ nguyên topology demo:

```text
Internet/switch -> ether1 (WAN demo)
Máy vận hành    -> ether2 (bridge member; LAN recovery đi qua bridge 192.168.88.1/24)
```

Đường phục hồi là **bridge** chứ không phải port vật lý: trên `defconf` các port
ether2-ether5 là bridge member và không có IP riêng. Không cycle port đang cắm máy
vận hành, và bridge thì worker tự đánh dấu `protected` nên không cycle được.

Trong phiên LAN hiện tại, chỉ đọc và lưu evidence cục bộ ngoài repo:

```routeros
/system/identity/print
/system/resource/print
/system/routerboard/print
/interface/print detail without-paging
/ip/address/print detail without-paging
/ip/service/print detail without-paging
/ip/firewall/filter/print detail without-paging
/ip/ssh/print
/user/print detail without-paging
```

Chụp một binary backup mã hóa AES-SHA256 và một export
`terse show-sensitive=no`. Mật khẩu backup phải nằm trong file mode `0600`, không
đưa vào terminal history, chat hoặc commit. Ghi lại SHA-256 của hai artifact; raw
artifact nằm ngoài repo.

## 2. Sinh key và input ngoài repo

Sinh **cả hai** cặp WireGuard (router + VPS) bằng chính generator. Trước đây bước
này là "chạy `wg genkey` hai lần bằng tay" và thực tế đã hỏng: hub reserve peer
bằng một public key mà nửa private của nó không tồn tại ở đâu cả, nên tunnel không
bao giờ lên được. Lệnh dưới đây không in gì ra stdout, ghi file `0600`, và từ chối
ghi đè file đã có:

```bash
umask 077
export NETWORK_BOOTSTRAP_KEYPAIR_FILE=/secure/tmp/demo-wireguard-keys.json
node scripts/generate-router-bootstrap.mjs
```

File này chứa bốn trường `routerWireGuardPrivateKey`, `routerWireGuardPublicKey`,
`vpsWireGuardPrivateKey`, `vpsWireGuardPublicKey`. Chép nguyên vào input JSON.
Generator tự kiểm tra từng public key đúng là nửa công khai của private key khai
báo (X25519, cùng kết quả với `wg pubkey`) và từ chối nếu lệch, nên chép sai bị
bắt ngay chứ không lộ ra ở lần handshake đầu tiên.

Mỗi private key chỉ có đúng một đích đến:

- `routerWireGuardPrivateKey` -> `router-bootstrap.rsc` -> import vào router rồi
  xóa khỏi Files ở bước 3.5;
- `vpsWireGuardPrivateKey` -> `wg0.conf` -> `install-host.sh` cài root-owned
  `0600` trên VPS.

Public key của router đi vào `[Peer]` của `wg0.conf` trong cùng một lần chạy, nên
peer trên hub luôn khớp với private key đã nạp vào router. Với tòa 2..15 lặp lại
đúng quy trình này cho từng tòa: `install-host.sh` merge peer theo `PublicKey`
(additive), tòa mới không đụng tới tòa 1..N-1; chỉ gỡ peer bằng
`--remove-peer <PublicKey>` khi thật sự muốn gỡ.

Sinh một SSH key Ed25519 riêng cho worker; không tái sử dụng key của 9Router,
Zalo, Supabase hoặc tài khoản quản trị cá nhân.

Tạo input JSON owner-only ở thư mục tạm ngoài Git với các trường:

```json
{
  "routerIdentity": "MikroTik Demo",
  "deploymentId": "demo-router-<change-id>",
  "routerUser": "ihome-nc-worker",
  "routerPassword": "<random 32+ chars; recovery only>",
  "routerWireGuardPrivateKey": "<secret>",
  "routerWireGuardPublicKey": "<public>",
  "vpsWireGuardPrivateKey": "<secret>",
  "vpsWireGuardPublicKey": "<public>",
  "workerSshPublicKey": "ssh-ed25519 <public>",
  "vpsEndpointHost": "<VPS public IP or DNS>",
  "wireGuardPort": 51820,
  "managementCidr": "<dedicated /24>",
  "vpsAddress": "<VPS /24>",
  "vpsPeerAddress": "<VPS /32>",
  "routerAddress": "<router /24>",
  "routerPeerAddress": "<router /32>",
  "recoveryCidr": "<one RFC1918 /28 to /32 recovery network; prefer laptop /32>",
  "recoveryInterface": "<L3 edge của LAN: thường là `bridge`; hoặc ether2-ether99 out-of-band>",
  "recoveryInterfaceAddress": "<địa chỉ của chính router trên interface đó, vd 192.168.88.1/24>",
  "wanInterface": "<actual WAN interface>",
  "sshStrongCrypto": false,
  "managementServices": {
    "ssh": { "disabled": false, "address": "<captured exact value>", "port": 22 },
    "winbox": { "disabled": false, "address": "<captured exact value>", "port": 8291 },
    "telnet": { "disabled": true, "address": "<captured exact value>", "port": 23 },
    "ftp": { "disabled": true, "address": "<captured exact value>", "port": 21 },
    "www": { "disabled": true, "address": "<captured exact value>", "port": 80 },
    "www-ssl": { "disabled": true, "address": "<captured exact value>", "port": 443 },
    "api": { "disabled": true, "address": "<captured exact value>", "port": 8728 },
    "api-ssl": { "disabled": true, "address": "<captured exact value>", "port": 8729 }
  }
}
```

`routerUser` chỉ được phép là `ihome-nc-worker`. Generator tạo ownership marker
`ihomecrm-network-center:v1:<deploymentId>` và dừng trước mutation nếu user hoặc
WireGuard cùng tên không mang marker đó. `managementServices` phải được chép từ
pre-state vừa capture; không tự điền theo giá trị mong muốn vì rollback dùng đúng
disabled/address/port này. `sshStrongCrypto` cũng phải phản ánh đúng giá trị
`/ip/ssh strong-crypto` trước bootstrap để rollback phục hồi chính xác.

### Recovery interface: chọn cái thật sự phục hồi được

Đường phục hồi phải là **L3 edge của router hướng về máy vận hành**. Trên RouterOS
`defconf` (hEX và tương đương) ether2-ether5 đều là bridge port và **không có IP
riêng** (`bridgeports=1 addrs=0`), còn LAN `192.168.88.1/24` nằm trên `bridge`.
Vì vậy `bridge` chính là đường phục hồi thật, và bootstrap chấp nhận nó.

Bootstrap dừng **trước mọi mutation** nếu recovery interface: không tồn tại duy
nhất, trùng WAN, đang disabled, không phải `ether`/`bridge`, là `ether` nhưng
`default-name` không thuộc `ether2`-`ether99`, là `ether` nhưng vẫn là bridge
member, hoặc **không mang đúng `recoveryInterfaceAddress` ở dạng tĩnh và enabled**.
Địa chỉ do DHCP cấp (dynamic) bị từ chối: đường phục hồi mà hết hạn theo lease thì
không phải đường phục hồi. Generator còn bắt buộc `recoveryCidr` nằm trong subnet
của `recoveryInterfaceAddress` và không đè lên `managementCidr`.

Hệ quả có thật, không phải trang trí: worker đọc `in-interface` của rule
`:lan-recovery` và đánh dấu interface đó `protected`, nên `CYCLE_ACCESS_PORT`
không bao giờ cycle được đường phục hồi; và dead-man switch của port cycle **từ
chối chạy** nếu không tìm thấy rule marker này trong chain `input`.

Nếu tòa nhà có sẵn một port out-of-band chuyên dụng (đã tách khỏi bridge và có IP
riêng) thì vẫn dùng được, chỉ cần khai đúng `recoveryInterface` +
`recoveryInterfaceAddress`.

Chạy generator không dùng CLI arguments và chọn output ngoài repo:

```bash
export NETWORK_BOOTSTRAP_INPUT_FILE=/secure/tmp/demo-input.json
export NETWORK_BOOTSTRAP_OUTPUT_DIR=/secure/tmp/demo-output
node scripts/generate-router-bootstrap.mjs
```

Generator không in nội dung ra stdout. Output gồm:

- `router-bootstrap.rsc`: stage 1, vẫn cho SSH từ LAN recovery;
- `router-lockdown.rsc`: stage 2, chỉ apply sau xác minh;
- `router-rollback.rsc`: chỉ gỡ resource đúng ownership marker và phục hồi chính
  xác disabled/address/port của tám management service cùng `strong-crypto`;
- `worker-ssh-key.pub`;
- `wg0.conf`: cấu hình VPS chứa private key, phải giữ mode `0600`.

## 3. Apply stage 1 qua LAN

1. Giữ nguyên phiên Winbox/SSH LAN đang hoạt động.
2. Upload `worker-ssh-key.pub`, `router-bootstrap.rsc` vào Files của router.
3. Chạy dry-run trước. Demo phải dùng RouterOS 7.16 trở lên; nếu router không hỗ
   trợ `dry-run` thì dừng để nâng cấp/review, không import mù:

   ```routeros
   /import file-name=router-bootstrap.rsc verbose=yes dry-run
   ```

4. Chỉ khi dry-run báo 0 lỗi mới import thật và đọc toàn bộ output trước khi đóng
   phiên. Output phải là
   `NETWORK_CENTER_STAGE1_PENDING_RECOVERY_PROOF`; marker này cố ý không phải
   `READY` vì đường phục hồi thực tế chưa được chứng minh:

   ```routeros
   /import file-name=router-bootstrap.rsc verbose=yes
   ```

5. Dù import thành công hay thất bại, xóa ngay script chứa WireGuard private key
   và password khỏi Files. Public key đã import cũng không cần giữ lại:

   ```routeros
   /file/remove [find where name="router-bootstrap.rsc"]
   /file/remove [find where name="worker-ssh-key.pub"]
   ```

6. Giữ nguyên phiên LAN cũ, mở một phiên SSH LAN recovery mới từ đúng
   máy/nguồn trong `recoveryCidr`, và xác minh đăng nhập thành công sau
   import. Đây là recovery proof bắt buộc; không đóng phiên cũ trước
   khi phiên mới đã đọc được identity và `/ip/firewall/filter/print`
   cho rule có marker `:lan-recovery`.
7. Xác minh interface `wg-ihome-mgmt`, IP, peer, user/group, SSH key và ba rule
   firewall có marker ownership. Không disable admin cũ, không thay default
   route/NAT/DHCP và chưa import lockdown.

Nếu import lỗi giữa chừng, chạy rollback từ phiên LAN còn mở rồi so sánh trạng
thái với evidence bước 1.

## 4. Bring up WireGuard trên VPS

Đặt `wg0.conf` ở vị trí root-owned/owner-only, mở đúng UDP port trên firewall VPS,
rồi bring interface up. Không đưa private key vào `docker-compose.yml`.

Gates bắt buộc:

```bash
wg show wg0
ping -c 3 <router-management-IP>
```

Phải thấy handshake mới và byte counter tăng hai chiều. Container worker dùng
host networking nên chỉ cần host VPS route được management IP; không cấp
`NET_ADMIN` cho container.

## 5. Pin SSH host key đúng cách

Lấy fingerprint SHA256 qua kết nối LAN vật lý đang tin cậy và qua IP WireGuard;
hai fingerprint phải giống nhau. Không tin fingerprint chỉ lấy từ một lần
`ssh-keyscan` trên mạng chưa xác minh.

Sau khi khớp:

- lưu đúng dạng `SHA256:<base64>` trong connection record;
- `credential_ref` chỉ là tên opaque trỏ tới file secrets trên VPS;
- private key và backup password không nằm trong Supabase;
- thử SSH key auth qua WireGuard, không dùng password.

## 6. Polling read-only trước

Deploy worker với `NETWORK_CENTER_EMERGENCY_STOP=true`. Gate read-only:

- heartbeat `PAUSED`/fresh;
- router current state, interfaces, clients và Aruba discovery cập nhật;
- Aruba được chunk 256/batch nhưng không có quota tổng;
- Aruba có `write_capability=false`, không credential, không action;
- inventory ổn định được cache, ingest nhiều tòa được gộp;
- snapshot trình duyệt chỉ có export đã redact và SHA-256;
- không có worker secret/private key/password trong log, Realtime hoặc RPC đọc.

Chỉ khi các gate trên xanh mới đổi emergency stop sang `false` và restart riêng
container Network Center.

## 7. Apply lockdown riêng biệt

Import `router-lockdown.rsc` qua phiên WireGuard đã xác minh. Ngay sau import:

- mở phiên SSH mới qua WireGuard trước khi đóng phiên cũ;
- xác minh SSH chỉ nhận từ VPS peer `/32`;
- Winbox bị disable trong lockdown; quản trị tự động chỉ đi qua SSH/WireGuard từ
  VPS peer `/32`;
- telnet/FTP service/web/API bị disable (SFTP trong SSH vẫn hoạt động);
- LAN không còn là đường quản trị bình thường; giữ cáp và rollback file cho tình
  huống khẩn cấp vật lý.

## 8. Thử bốn action đóng

Thử tuần tự và kiểm audit/stage ở mỗi bước:

1. `FLUSH_DNS_CACHE`: backup -> execute -> DNS post-check.
2. `RENEW_DHCP_LEASE`: nếu WAN dùng DHCP, renew và post-check; nếu PPPoE/không có
   DHCP bound, kết quả phải là `NO_BOUND_DHCP_CLIENT`, không coi là lỗi.
3. `CYCLE_ACCESS_PORT`: chỉ chọn port ACCESS trống (ví dụ ether5 sau khi kiểm
   tra). Không chọn ether1, ether2, SFP/uplink, bridge hay WireGuard.
4. `REBOOT_ROUTER`: làm cuối cùng; xác minh `UNCERTAIN`/reconciliation nếu SSH
   rớt sau khi lệnh đã gửi, và không tự reboot lần hai.

Mỗi action phải có lease renewal, pre-backup AES-SHA256, redacted snapshot,
event stages, post-check và audit. User có `network_center.execute` chạy ngay;
không có approval workflow.

## 9. Rollback

Nếu WireGuard/SSH worker không ổn định:

1. dùng phiên LAN recovery còn mở;
2. import `router-rollback.rsc`;
3. xác minh cả tám management service và `strong-crypto` trở về đúng pre-state;
4. giữ binary backup/export để điều tra nhưng không commit;
5. xóa/rotate key và worker secret bị nghi lộ;
6. chỉ khôi phục binary backup khi rollback script không đủ và đã xác nhận đúng
   router/model/RouterOS version.

Evidence được phép commit chỉ gồm test, runbook, hash và kết luận đã redact; không
commit IP thật, host key, WireGuard key, SSH key, password, raw export hoặc binary
backup.
