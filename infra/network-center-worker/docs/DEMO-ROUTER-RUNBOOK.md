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
| 04 `worker-group` | `/user/group network-center-worker` | **KHÔNG** — group không mang marker nên rollback bỏ qua; gỡ tay: `/user/group remove [find where name="network-center-worker"]` |
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

Mỗi action phải có lease renewal, pre-backup AES-SHA256, redacted snapshot,
event stages, post-check và audit. User có `network_center.execute` chạy ngay;
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
4. giữ binary backup/export để điều tra nhưng không commit;
5. xóa/rotate key và worker secret bị nghi lộ;
6. chỉ khôi phục binary backup khi rollback script không đủ và đã xác nhận đúng
   router/model/RouterOS version.

Evidence được phép commit chỉ gồm test, runbook, hash và kết luận đã redact; không
commit IP thật, host key, WireGuard key, SSH key, password, raw export hoặc binary
backup.
