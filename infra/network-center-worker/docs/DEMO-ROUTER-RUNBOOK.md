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

Chụp **một text export đã redact** làm snapshot tiền-action:

```routeros
/export terse hide-sensitive
```

Ghi lại SHA-256 của artifact; raw artifact nằm ngoài repo.

> **KHÔNG còn binary backup.** `/system/backup/save` đã bị bỏ khỏi đường đi của
> worker (đo 2026-08-03: nó đòi `policy`+`test`, và tải `.backup` về qua SFTP đòi
> `sensitive` — không bộ policy nào vừa chạy được backup vừa cấm worker đọc
> private key). Chi tiết ở mục 9.

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
  "recoveryCidr": "<một dải RFC1918 /28..32; chọn /32 hay /28 theo mục 2.1>",
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

### 2.1 `recoveryCidr`: `/32` chỉ khi địa chỉ máy vận hành là TĨNH

Runbook trước đây mặc định khuyên lấy `/32` của máy vận hành. Điều đó chỉ đúng
khi địa chỉ đó thật sự cố định. Trên router demo (đo 2026-08-03) thì không:
`192.168.88.254` là **lease DHCP động** (`D ... status=bound expires-after=23m`).

Hệ quả nếu dùng `/32` cho một lease: khi lease đổi (renew, reboot, đổi cổng, hết
pool), cả rule firewall `:lan-recovery` **và** allowlist `address=` của
`/ip/service ssh` đều ngừng khớp cùng lúc — và sau stage 2 lockdown thì LAN là
đường quản trị khẩn cấp duy nhất còn lại. Đường phục hồi không được phép hết hạn
theo lease; đó cũng đúng nguyên tắc mà preflight đã áp cho
`recoveryInterfaceAddress` (từ chối địa chỉ `dynamic`).

Vậy chọn như sau:

- địa chỉ máy vận hành **đặt tĩnh trên chính máy đó** → dùng `/32`, hẹp nhất;
- địa chỉ đến từ DHCP → dùng **`/28` nhỏ nhất chứa vùng máy vận hành rơi vào**
  (demo: `192.168.88.240/28`, phủ đỉnh pool). Đánh đổi: stage 1 mở SSH cho 16 địa
  chỉ LAN thay vì 1, chỉ trong thời gian stage 1;
- đặt **static DHCP lease** trên router cũng khắc phục được, nhưng nó thêm một
  object **không mang ownership marker**, nên `router-rollback.rsc` (chỉ gỡ theo
  marker) sẽ không dọn — vi phạm tiêu chí "export diff chỉ chứa managed object".
  Nếu vẫn làm thì phải gỡ tay trong bước rollback và ghi vào evidence.

Generator ép sẵn: `/28`..`/32`, phải là địa chỉ mạng, RFC1918, nằm trong subnet
của `recoveryInterfaceAddress`, và không đè `managementCidr`.

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

### 3.0 Hai cổng bắt buộc trước khi import — không bỏ cổng nào

Hai cổng bắt lỗi ở hai lớp khác nhau và **không cái nào thay được cái nào**. Đây
là bài học trả bằng máu ngày 2026-08-03: simulator kiểm được ngữ nghĩa nhưng
không có parser (22 lỗi cú pháp lọt qua), còn dry-run kiểm được cú pháp nhưng
không bao giờ đánh giá `find where` (một selector chưa quote khớp 0 dòng vẫn báo
"No syntax errors").

**Cổng 1 — offline, nằm sẵn trong vòng lặp test:**

```bash
npm --prefix infra/network-center-worker test
```

`generateBootstrap` chạy `routerOsScriptDiagnostics` trên cả ba `.rsc` và **ném
lỗi thay vì trả file** nếu còn bất kỳ chẩn đoán nào, nên một script hỏng không
sinh ra được. Cổng này bắt: điều kiện `:if (...)` xuống dòng, `!~`, `$` chưa
escape trước dấu nháy đóng, và giá trị chưa quote trong `find where`.

**Cổng 2 — dry-run trên chính router.** `/import ... dry-run` chỉ **parse**,
không thực thi, không đổi gì (đã đo: `/export` 132 dòng trước và sau, diff rỗng).
Chi phí: 4 lần upload + 3 lệnh, khoảng 10 giây, chạy ngay trong phiên LAN đang mở.
Upload cả bốn file rồi:

```bash
ROUTER=192.168.88.1
scp "$NETWORK_BOOTSTRAP_OUTPUT_DIR"/{router-bootstrap.rsc,router-lockdown.rsc,router-rollback.rsc,worker-ssh-key.pub} "admin@$ROUTER:"
ssh "admin@$ROUTER" "/import file-name=router-bootstrap.rsc verbose=yes dry-run"
ssh "admin@$ROUTER" "/import file-name=router-lockdown.rsc verbose=yes dry-run"
ssh "admin@$ROUTER" "/import file-name=router-rollback.rsc verbose=yes dry-run"
```

Cả ba phải in đúng `No syntax errors found in the import file`. Bất kỳ dòng
`found N error(s)` nào ⇒ **dừng, không import**. Demo phải dùng RouterOS 7.16 trở
lên; router không hỗ trợ `dry-run` thì dừng để nâng cấp/review, không import mù.

GOTCHA đã đo: RouterOS in `failure: ...` ra **stdout với exit code 0**, nên không
được kết luận theo exit status — phải đọc chữ.

**Cổng 2 vẫn KHÔNG đủ để kết luận preflight sẽ qua**, vì dry-run không đánh giá
`find where`. Chạy thêm probe read-only đúng selector mà preflight phụ thuộc, với
chính giá trị đã khai trong input JSON:

```bash
ssh "admin@$ROUTER" ':put [:len [/ip/address find where interface="bridge" and address="192.168.88.1/24" and disabled=no and !dynamic]]'
```

Phải in `1`. In `0` nghĩa là selector không khớp dòng nào — đúng defect đã đo
2026-08-03, khi giá trị được nội suy **không có nháy**: `address=192.168.88.1/24`
khớp 0 dòng, `address="192.168.88.1/24"` khớp 1. Đọc state qua exec **bắt buộc
bọc `:put [...]`**; `/ip/address get [find ...]` trần trả về rỗng và sẽ "chứng
minh" sai.

### 3.0.1 `verbose=yes` CHỈ dùng cho dry-run. Import thật PHẢI `verbose=no`

Đây là kết quả **đo trên chính router demo** (hEX, RouterOS 7.20.8, 2026-08-03),
không phải suy đoán. Dưới `/import … verbose=yes`, một biến `:local` đọc ra
**RỖNG khi nằm trong ĐIỀU KIỆN của `:if`**, trong khi chính biến đó vẫn `:put` ra
đúng giá trị. Repro nhỏ nhất, cùng file cùng state, chỉ khác mỗi cờ:

```routeros
:local a [/interface find where name="bridge"]
:local b [/interface find where name="ether1"]
:put ("LEN_A=" . [:len $a] . " LEN_B=" . [:len $b])
:if ([:len $a] != 1 || [:len $b] != 1) do={ :put "FIRED_UNEXPECTEDLY" }
:if ([:len $a] != 1) do={ :put "FIRED_SINGLELINE" }
:put "END"
```

| cờ | output đo được |
|---|---|
| `verbose=no` | `LEN_A=1 LEN_B=1` … `END` — không `:if` nào nổ (ĐÚNG) |
| `verbose=yes` | `LEN_A=1 LEN_B=1` … **`FIRED_UNEXPECTEDLY`** … **`FIRED_SINGLELINE`** … `END` |

Và trên chính `router-bootstrap.rsc`, cùng bytes cùng state:

```text
--- verbose=no  ---  preflight chạy hết, không guard nào nổ
--- verbose=yes ---  Script Error: NETWORK_CENTER_RECOVERY_INTERFACE_INVALID/...
```

trong khi điều kiện đó **là false** trên máy này (đo bằng cách tự soi 42 dòng đầu
của script: `R_LEN=1 W_LEN=1 R_VAL=*7 W_VAL=*2`). Thay toàn bộ 34 `:error` bằng
marker riêng thì script chạy tới `PREFLIGHT_REACHED_END`, không marker nào in ra.

Hai điều bị loại trừ, và nó quan trọng: **không phải lỗi xuống dòng** (bản `:if`
một dòng cũng nổ) và **không phải lỗi scope** (`:put` cùng script vẫn in đúng).

**Vì sao đây là chuyện chết người chứ không phải phiền toái:** MỌI guard trong
`router-bootstrap.rsc` đều có hình dạng `:if ([:len $ncX] …)`, kể cả các guard
đứng trước mutation:

```routeros
:if ([:len $ncWgs] = 0) do={ /interface/wireguard add name=$ncWgName … }
```

Dưới `verbose=yes`, `[:len $ncWgs]` đọc thành 0 nên nhánh `add` chạy dù interface
đã tồn tại. Lần chạy 2026-08-03 chỉ không hỏng gì vì preflight fail-closed **trước
mutation đầu tiên** (`/export` 132 dòng trước và sau, `strong-crypto=false`).

`verbose=yes` **an toàn cho `dry-run`**: dry-run chỉ parse, không đánh giá điều
kiện, và cả ba artifact đều parse sạch dưới cờ đó. Nên mục 3.0 giữ `verbose=yes`,
còn mục 3.1 bước 4 dùng `verbose=no`.

> Nếu sau này có ai "sửa lại cho nhất quán" thành `verbose=yes` ở bước import
> thật: test `routerBootstrapImport.test.ts` đọc chính dòng lệnh trong runbook
> này, chạy simulator với đúng cờ đó, và đỏ ngay — vì simulator có mô hình hóa
> hành vi đo được ở trên.

### 3.1 Import

1. Giữ nguyên phiên Winbox/SSH LAN đang hoạt động.
2. Upload `worker-ssh-key.pub`, `router-bootstrap.rsc` vào Files của router (đã
   làm ở 3.0 nếu chạy cổng 2 ở đó).
3. Cổng 1 và cổng 2 ở mục 3.0 phải xanh hết. Không import khi còn một cổng đỏ.
4. Chỉ khi dry-run báo 0 lỗi mới import thật và đọc toàn bộ output trước khi đóng
   phiên. **Bắt buộc `verbose=no`** — lý do đo được ở mục 3.0.1. Output phải kết
   thúc bằng `NETWORK_CENTER_STAGE1_PENDING_RECOVERY_PROOF`; marker này cố ý
   không phải `READY` vì đường phục hồi thực tế chưa được chứng minh:

   ```routeros
   /import file-name=router-bootstrap.rsc verbose=no
   ```

   Vì không còn echo từng dòng, script tự in dấu vết. Output thành công đầy đủ:

   ```text
   NC_STEP:01:wireguard-interface
   NC_STEP:02:management-address
   NC_STEP:03:wireguard-peer
   NC_STEP:04:worker-group
   NC_STEP:05:worker-user
   NC_STEP:06:worker-ssh-key-clear
   NC_STEP:07:worker-ssh-key-import
   NC_STEP:08:ssh-strong-crypto
   NC_STEP:09:ssh-service-allowlist
   NC_STEP:10:firewall-lan-recovery
   NC_STEP:11:firewall-wg-handshake
   NC_STEP:12:firewall-wg-management
   NETWORK_CENTER_STAGE1_PENDING_RECOVERY_PROOF
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

### 3.2 Đọc một lần chạy hỏng giữa chừng

`/import` **dừng ở statement lỗi đầu tiên và KHÔNG undo** những gì đã chạy. Với
`verbose=no`, output chỉ có hai thứ, và cả hai đều đủ để định vị:

**a) `Script Error: NETWORK_CENTER_<CLASS>/<slug>` — preflight từ chối, CHƯA có
mutation nào.** `<slug>` là duy nhất trong toàn bộ ba script, nên:

```bash
grep -rn "<slug>" infra/network-center-worker/templates/
```

ra đúng MỘT dòng — chính cái so sánh đã từ chối router. Không cần re-instrument.
Ví dụ `…/recovery-rule-dst-port` = "đã có rule `:lan-recovery` mang marker của
deployment này nhưng `dst-port` không phải 22". Router chưa bị đụng gì:
`/export` phải giống hệt evidence bước 1.

**b) Có ít nhất một dòng `NC_STEP:` — đã vào phần mutation.** Dòng `NC_STEP` CUỐI
CÙNG in ra là block đã **thất bại**; mọi step trước đó đã **hoàn tất**. Sau nó là
thông báo lỗi của chính RouterOS (`failure: …`), không phải `:error` của script.

| step | ghi gì lên router | `router-rollback.rsc` dọn được? |
|---|---|---|
| 01 `wireguard-interface` | interface `wg-ihome-mgmt` (marker `:wireguard`) | có (step 15) |
| 02 `management-address` | `/ip/address` trên wg (marker `:address`) | có (step 14) |
| 03 `wireguard-peer` | peer VPS (marker `:peer`) | có (step 13) |
| 04 `worker-group` | `/user/group network-center-worker`, policy `ssh,reboot,read,write` (KHÔNG `sensitive`/`policy`/`ftp`/`test` — xem 3.3) | **KHÔNG** — group không mang marker nên rollback bỏ qua; gỡ tay: `/user/group remove [find where name="network-center-worker"]` |
| 05 `worker-user` | user `ihome-nc-worker` (comment = marker) | có (step 16) |
| 06 `worker-ssh-key-clear` | xóa ssh-key cũ của user đó | không cần |
| 07 `worker-ssh-key-import` | nạp `worker-ssh-key.pub` | có (step 16, xóa cùng user) |
| 08 `ssh-strong-crypto` | `/ip/ssh strong-crypto=yes` | có (step 09, trả về giá trị đã capture) |
| 09 `ssh-service-allowlist` | `/ip/service ssh` thu về `recoveryCidr` + VPS peer | có (step 01, trả về `managementServices.ssh` đã capture) |
| 10 `firewall-lan-recovery` | rule accept 22/tcp từ `recoveryCidr` | có (step 10) |
| 11 `firewall-wg-handshake` | rule accept UDP WG trên WAN | có (step 12) |
| 12 `firewall-wg-management` | rule accept từ VPS peer qua wg | có (step 11) |

**Trạng thái dở dang NGUY HIỂM NHẤT là dừng ngay sau `NC_STEP:09`**: allowlist của
`/ip/service ssh` đã thu hẹp về `recoveryCidr` nhưng rule firewall `:lan-recovery`
(step 10) chưa được tạo. Nếu địa chỉ máy vận hành **không nằm trong
`recoveryCidr`** thì phiên SSH mới sẽ bị từ chối. Đây chính là lý do mục 2.1 bắt
chọn `recoveryCidr` phủ được địa chỉ thật của máy vận hành. **Đừng đóng phiên LAN
đang mở** — chạy rollback ngay từ phiên đó.

**Việc phải làm khi lỡ dở dang:**

1. từ phiên LAN CÒN MỞ, import `router-rollback.rsc` (cũng `verbose=no`); nó in
   `NC_STEP:01..16` rồi `NETWORK_CENTER_ROLLBACK_APPLIED`;
2. nếu đã tới step 04 trở lên, gỡ tay `/user/group network-center-worker` theo
   bảng trên;
3. so `/export` với evidence bước 1 — phải trở về giống hệt;
4. sửa nguyên nhân (slug ở mục a chỉ thẳng vào nó), sinh lại artifact, chạy lại
   cả hai cổng ở mục 3.0 rồi import lại.

Rollback chạy được trên trạng thái dở dang vì mọi lệnh remove của nó đều chọn
theo marker và selector rỗng là no-op; các `/ip/service set` thì idempotent.

### 3.3 Quyền của `network-center-worker`: KHÔNG có `sensitive`

`router-bootstrap.rsc` tạo group với đúng bốn policy — và vì là `add`, mọi
policy KHÔNG kể tên (gồm `sensitive`, `policy`, `ftp`, `test`) bị từ chối luôn:

```routeros
/user/group add name=network-center-worker policy=ssh,reboot,read,write
```

**Vì sao bỏ `sensitive`** (đo trên hEX demo, RouterOS 7.20.8, 2026-08-03, phiên
chỉ-đọc, KHÔNG đổi gì trên router):

| lệnh | kết quả đo |
|---|---|
| `/interface/wireguard/print detail` | `private-key="<44 ký tự>"` — lộ **plaintext** |
| `/interface/wireguard/export terse` | 543 B, **0** lần xuất hiện `private-key` |
| `/interface/wireguard/export terse show-sensitive` | 602 B, **1** `private-key` dài 44 |
| `/interface/print detail terse` (lệnh poll THẬT) | 1338 B, **0** trường nhạy cảm |
| 7 lệnh đọc còn lại của worker | **0** trường nhạy cảm |

Nghĩa là private key của tunnel chỉ với tới được qua submenu
`/interface/wireguard` — thứ worker **không bao giờ gọi**. Bỏ `sensitive` đóng
hẳn đường đọc plaintext mà không mất một lệnh nào.

> Dòng thứ hai của bảng là bài học riêng: `export terse` mặc định ĐÃ ẩn key
> (`/export terse` và `/export hide-sensitive terse` cho ra output **byte y hệt
> nhau**), nhưng flag anh em `show-sensitive` thì **in trọn key**. Đừng bao giờ
> "sửa" một lệnh export bằng cách bỏ bớt chữ.

**Bộ policy tối thiểu, suy lại ngày 2026-08-03** sau khi binary backup rời khỏi
đường đi của worker — đo trên 6 identity tạm:

| lệnh worker thật sự gửi | `ssh,read` | `ssh,read,write` | `+ftp` |
|---|---|---|---|
| `:put [/interface/print as-value stats]` | OK | OK | OK |
| mọi `/…/print` còn lại trong poll | OK | OK | OK |
| `/export terse hide-sensitive` (stdout) | OK | OK | OK |
| `:execute script={…}` (arm dead-man) | OK | OK | OK |
| `/system/script/job/remove` (disarm) | **DENIED** | OK | OK |
| `/export … file=` (ĐÃ BỎ) | DENIED | DENIED | OK |
| SFTP subsystem (ĐÃ BỎ) | DENIED | DENIED | OK |

- **`test` KHÔNG cần nữa.** `:execute` chạy được với identity `ssh,read` trần.
  Thứ duy nhất đổi giữa cột 1 và cột 2 là `write` (`/system/script/job/remove`).
  `test` trước đây chỉ phục vụ `/system/backup/save`, mà lệnh đó đã bị bỏ.
- **`ftp` KHÔNG cần nữa.** Nó chỉ gác `/export … file=` và SFTP subsystem
  (`Unable to start subsystem: sftp`); export giờ đọc thẳng từ stdout.

⇒ bộ tối thiểu: **`ssh,reboot,read,write`**.

`policy` bị chặn: có nó, worker tự sửa được group của chính mình để cấp lại
`sensitive` (đã đo, không phải suy đoán). `ftp` và `test` **cũng** bị chặn — giữ
một policy được cấp mà không lệnh nào dùng chỉ là capability nằm chờ.

**`reboot` là policy DUY NHẤT chưa đo được**: chứng minh nó đòi hỏi bắn
`/system/reboot` vào chính gateway Internet đang sống của operator. Nó được giữ
theo tài liệu RouterOS, và ghi rõ là *chưa đo* thay vì trưng ra như bằng chứng.

**Rủi ro backup: ĐÃ ĐÓNG bằng cách bỏ hẳn binary backup** (đo 2026-08-03, mỗi
dòng là một identity tạm tạo mới, có `:put "CHANNEL_OK"` làm control cùng phiên):

- `/system/backup/save` đòi `policy` **và** `test` — không phải `write`, không
  phải `ftp`, không phải `sensitive`. Group worker đang chạy production **thiếu
  `policy`**, nên nó trả `Failed to save system configuration backup`, `file=0`.
  Lặp lại 3 lần: pre-action backup **vốn đã hỏng sẵn** trước mọi việc siết.
- tải `.backup` về qua SFTP đòi `sensitive` — tương quan tuyệt đối trên 7
  identity, trong khi `.rsc` tải được ở cả 7 (đó là control chứng minh kênh SFTP
  vẫn sống).
- user có `policy` mà `!sensitive` **tự sửa group của chính nó** để thêm
  `sensitive`, rồi đọc trọn private key ở lần login kế tiếp (`:len` 5 trong
  phiên, 44 sau khi reconnect).

⇒ Bộ policy nhỏ nhất chạy được binary backup **rộng hơn** bộ đang deploy và cấp
lại đúng hai thứ mà việc siết sinh ra để bỏ. Không có điểm cân bằng nào ở giữa,
nên **binary backup bị loại khỏi worker**, thay bằng text export (mục 9).

### 3.4 Router ĐÃ provision: chuỗi lệnh siết group

Áp dụng cho router đã bootstrap bằng bộ policy CŨ. Trạng thái trước khi siết:

```text
policy = ssh;ftp;reboot;read;write;test;sensitive;!local;!telnet;!policy;
         !winbox;!password;!web;!sniff;!api;!romon;!rest-api
```

nên preflight **cố ý** từ chối cả hai stage với
`NETWORK_CENTER_GROUP_CONFLICT/group-policy-grants-sensitive` (và bản
`lockdown-…` tương ứng) cho tới khi group được siết.

> **ĐÃ CHẠY XONG TRÊN ROUTER DEMO** (2026-08-03): group hiện là
> `ssh;reboot;read;write` + 13 mục `!…`, worker đọc `private-key` ra `:len` 5
> (admin vẫn 44), và 4 lần thử tự nâng quyền đều bị `not enough permissions (9)`.
> Mục này còn ở đây cho **14 toà nhà còn lại**.
>
> Router demo là gateway Internet đang sống của máy vận hành. Chạy khi operator
> quyết định, từ phiên LAN còn mở, và **không** đóng phiên cũ trước khi bước 4
> xanh.

> **`set policy=` CỘNG DỒN — phải kể tên đủ 13 policy bị TỪ CHỐI.**
> Đo trên hEX demo (RouterOS 7.20.8, 2026-08-03), lặp lại được trên group nháp:
>
> ```text
> add policy=ssh,read   -> ssh;read;!ftp;!reboot;!write;!policy;…   (add TỪ CHỐI cái không kể tên)
> set policy=write      -> ssh;read;write;…                        (chỉ CẤP write, không đụng cái khác)
> set policy=!ssh       -> read;write;!ssh;…                       (chỉ TỪ CHỐI ssh, không đụng cái khác)
> ```
>
> `set policy=<danh sách>` chỉ áp dụng đúng những mục **được kể tên** và giữ
> nguyên mọi policy không kể tên. Chỉ `add` mới từ chối-bằng-cách-bỏ-sót. Nên
> bản cũ của mục này (`set policy=ssh,ftp,reboot,read,write,test`) là **no-op
> âm thầm** trên router đã provision: stdout rỗng, exit 0, và **`sensitive` vẫn
> còn nguyên** — đúng thứ duy nhất việc siết này sinh ra để gỡ. Lệnh dưới đây
> kể tên cả 4 policy được cấp lẫn 13 policy bị từ chối, nên kết quả **giống hệt
> byte** với `add policy=ssh,reboot,read,write` trên router mới bootstrap.

```routeros
# 1. Ảnh chụp trước (dán vào evidence)
:put [:tostr [/user/group get [find where name="network-center-worker"] policy]]

# 2. Siết group — KHÔNG remove/add lại, vì user đang trỏ vào group này.
#    Để NGUYÊN MỘT DÒNG: nối dòng bằng `\` khi dán vào phiên SSH hay bị nuốt.
/user/group set [find where name="network-center-worker"] policy=ssh,reboot,read,write,!local,!telnet,!ftp,!policy,!test,!winbox,!password,!web,!sniff,!sensitive,!api,!romon,!rest-api

# 3. Đọc lại: phải KHÔNG còn `sensitive`, `ftp`, `test`, `policy` ở dạng cấp
:put [:tostr [/user/group get [find where name="network-center-worker"] policy]]
```

Kỳ vọng sau bước 3:

```text
ssh;reboot;read;write;!local;!telnet;!ftp;!policy;!test;!winbox;!password;!web;
!sniff;!sensitive;!api;!romon;!rest-api
```

> **Đừng tin stdout rỗng của `set`.** `set` không in gì kể cả khi nó không làm
> gì. Bước 3 không phải thủ tục cho đẹp: nó là thứ DUY NHẤT chứng minh lệnh có
> tác dụng. Và phải khẳng định **theo từng policy** (`~ "(^|;)sensitive(;|$)"`),
> không so cả chuỗi — `:tostr` nối bằng `;` chứ không phải `,`, nên mọi so sánh
> với chuỗi `,` đều không bao giờ khớp.

**4. Cổng kiểm bắt buộc — chạy bằng credential CỦA WORKER, không phải admin.**
Đây là chỗ trả lời câu hỏi chưa đo được ở 3.3:

```routeros
# 4a. private key phải KHÔNG còn đọc được (kỳ vọng: 5, KHÔNG phải 44)
:put [:len [:tostr [/interface/wireguard get [find where name="wg-ihome-mgmt"] private-key]]]

# 4b. snapshot tiền-action phải chạy được — đây là TOÀN BỘ những gì worker cần.
#     Không có file nào được tạo trên router, nên không có gì phải dọn.
/export terse hide-sensitive

# 4c. dead-man switch của port cycle phải arm + disarm được
:local j [:execute script={:delay 1s}]; :put ("JOB:" . [:tostr $j]); /system/script/job/remove [/system/script/job/find where .id=$j]; :put ("LEFT:" . [:len [/system/script/job/find where .id=$j]])

# 4d. những thứ PHẢI bị từ chối (nếu chạy được ⇒ group còn rộng hơn tối thiểu)
/export terse hide-sensitive file=nc-policy-probe
```

- 4a trả về `44` ⇒ việc siết **không** có tác dụng, dừng lại và điều tra.
  (`5` là placeholder RouterOS trả khi giấu giá trị — đã đo cả hai đầu.)
- 4a phải đọc ở **phiên đăng nhập MỚI**: đổi policy chỉ có hiệu lực sau khi
  reconnect. Một lần đo trước đây thấy `5` trong phiên và `44` sau khi kết nối
  lại — probe nào bỏ bước reconnect sẽ kết luận sai.
- 4b bị từ chối ⇒ dừng, group thiếu `read`.
- 4c phải in `JOB:*…` rồi `LEFT:0`. Chỉ in `JOB:` rồi
  `not enough permissions (9)` ⇒ group thiếu `write`.
- 4d **phải** trả `not enough permissions (9) (:export; line 1)`. Nếu nó ghi được
  file ⇒ group vẫn còn `ftp`, chưa đạt tối thiểu.

(RouterOS trả `failure: …` / `not enough permissions` ra **stdout với exit code
0** — phải đọc chữ, đừng tin mỗi exit status.)

**5.** Sau khi 4a/4b/4c xanh: chạy lại một poll cycle đầy đủ rồi mới tới mục 7.
Không cần re-import `router-bootstrap.rsc`; nếu có import lại thì preflight mới
sẽ pass vì group đã đúng.

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

Deploy worker với `NETWORK_CENTER_EMERGENCY_STOP=true`.

> **`EMERGENCY_STOP` = đóng băng GHI, KHÔNG phải dừng hẳn.** Nó chặn command
> claim và mọi thao tác ghi lên router; **poll loop read-only vẫn chạy và vẫn
> SSH vào router**. Đó chính là lý do bước gate này hoạt động được — không có
> polling thì không có bằng chứng poll để promote. Trong sự cố mà thủ phạm là
> chính con worker, `EMERGENCY_STOP` **không đủ**: phải
> `systemctl stop network-center-worker` (hoặc `docker compose stop`). Bảng hợp
> đồng đầy đủ nằm ở README mục "Kill switch và vận hành".

Gate read-only:

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

Import `router-lockdown.rsc` qua phiên WireGuard đã xác minh — **cũng `verbose=no`**,
cùng lý do ở mục 3.0.1 (file này cũng toàn `:if ([:len $ncX] …)`):

```routeros
/import file-name=router-lockdown.rsc verbose=no
```

Output đúng là `NC_STEP:01..09` rồi `NETWORK_CENTER_LOCKDOWN_APPLIED`. Step 09 —
gỡ rule `:lan-recovery` — cố ý đứng CUỐI, nên mọi lỗi sớm hơn vẫn để nguyên đường
phục hồi LAN. Ngay sau import:

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

Mỗi action phải có lease renewal, snapshot text đã redact (`/export terse
hide-sensitive`), event stages, post-check và audit.

> `backupPasswordFile` trong config worker giờ **không còn được dùng** — không
> lệnh nào trên router tiêu thụ nó nữa. Nó vẫn nằm trong schema config và deploy
> asset để không phá hợp đồng deploy đang chạy; hãy gỡ nó trong lần chỉnh
> deploy-asset kế tiếp, và tới lúc đó thì secret đó có thể xoá khỏi host. User có `network_center.execute` chạy ngay;
không có approval workflow.

## 9. Rollback

Nếu WireGuard/SSH worker không ổn định:

1. dùng phiên LAN recovery còn mở;
2. import `router-rollback.rsc` — **`verbose=no`**, cùng lý do mục 3.0.1:

   ```routeros
   /import file-name=router-rollback.rsc verbose=no
   ```

   Output đúng là `NC_STEP:01..16` rồi `NETWORK_CENTER_ROLLBACK_APPLIED`. Nếu
   dừng giữa chừng, `NC_STEP` cuối cùng là bước chưa hoàn tất — đọc theo bảng ở
   mục 3.2;
3. xác minh cả tám management service và `strong-crypto` trở về đúng pre-state;
4. giữ text export tiền-action để điều tra nhưng không commit;
5. xóa/rotate key và worker secret bị nghi lộ.

### 9.1 KHÔNG CÒN BINARY BACKUP — đánh đổi phải đọc trước khi có sự cố

Snapshot tiền-action giờ là **text** `/export terse hide-sensitive`, không phải
ảnh `.backup`. Lý do đầy đủ ở mục 3.3; hệ quả vận hành:

- **Bốn action đóng không cần binary restore.** `FLUSH_DNS_CACHE` và
  `RENEW_DHCP_LEASE` không đổi một dòng config nào; `REBOOT_ROUTER` cũng vậy;
  `CYCLE_ACCESS_PORT` chỉ lật cờ `disabled` của đúng một interface, đằng sau
  dead-man switch chạy trên router tự bật lại kể cả khi worker chết. Không có
  action nào chạm tới state chỉ ảnh nhị phân mới khôi phục được.
- **Đường rollback chính không đổi**: phiên LAN recovery + `/import
  router-rollback.rsc`. Binary backup trước đây cũng chỉ là bước 6 "khi script
  rollback không đủ".
- **ĐÁNH ĐỔI, nói thẳng:** text export **không** khôi phục được state nhị phân mà
  ảnh `.backup` khôi phục được — certificate và private key của nó, SSH host
  key, WireGuard private key, hash mật khẩu user. Với `hide-sensitive` thì những
  thứ đó vắng mặt **theo thiết kế**. Nghĩa là: một router dựng lại **chỉ** từ
  artifact này sẽ **mất danh tính tunnel quản trị** và phải bootstrap lại từ
  đầu (mục 2–4). Đây không phải sự cố, nhưng phải biết trước, không phải phát
  hiện lúc 3 giờ sáng.
- Muốn có ảnh nhị phân đầy đủ thì **operator tự chạy bằng credential admin**,
  ngoài worker — vì chính worker không được phép, và đó là điều mong muốn:

  ```routeros
  /system/backup/save name=<tên> password=<mật khẩu> encryption=aes-sha256
  ```

  Lưu ý ảnh này **chứa WireGuard private key ở dạng base64** (đã đo: có mặt ở
  cùng offset kể cả khi user tạo backup không đọc được key qua CLI), nên nó là
  vật liệu nhạy cảm ngang private key — cất và luân chuyển tương ứng.

### 9.2 Artifact tiền-action nằm ở đâu, và nó KHÔNG được mã hoá

`backupStore` lưu artifact dưới dạng `*.rsc`, mode `0600` trong thư mục `0700`,
nhãn `ROUTEROS_EXPORT_PLAINTEXT` — **plaintext, đúng như tên gọi**. Nhãn cũ
`ROUTEROS_AES_SHA256` đã bị bỏ vì nó khẳng định một lớp mã hoá không còn tồn tại.

Đổi lại, artifact này **an toàn hơn thứ nó thay thế khi nằm im**: `.backup` cũ
chứa private key và được mã hoá bằng `backupPassword` mà **chính worker giữ**
(khoá nằm cạnh ổ khoá); export mới không chứa key ngay từ đầu — đo được **0** lần
xuất hiện `private-key=` trong 8133 B.

Evidence được phép commit chỉ gồm test, runbook, hash và kết luận đã redact; không
commit IP thật, host key, WireGuard key, SSH key, password, raw export hoặc binary
backup.
