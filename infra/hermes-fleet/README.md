# Mỗi người một trợ lý Hermes (`infra/hermes-fleet`)

Công cụ cho quản trị thêm một người dùng CRM thành **một trợ lý Hermes riêng** bằng một lệnh chạy trên máy chủ, kèm lệnh gỡ, liệt kê, tạo lại sidecar và dọn kho mã kết nối. Mỗi người có:

- container riêng `hermes-<tên>`, UID riêng, home riêng `/var/lib/ihome-hermes-profiles/<tên>/` (0700). Container chỉ bind đúng home của người đó nên không đọc được khoá CRM, bộ nhớ hay bài học của người khác;
- kênh Zalo riêng trên cùng nick bot của công ty (cầu trong worker định tuyến theo nick đã ghép);
- mã CRM của chính người đó: trợ lý chỉ có quyền CRM của người dùng ấy (giao với quyền Hermes của công ty);
- SOUL, plugin, kỹ năng chuẩn và cấu hình model dùng chung một khuôn; bộ nhớ, phiên và bài học riêng.

Công cụ **không** tự chạy từ web, không tạo kết nối hay liên kết Zalo hộ người dùng, không thu hồi kết nối CRM, không chuyển máy chủ. Trên production chưa thêm ai bằng công cụ này; xem [Đã kiểm và chưa kiểm](#đã-kiểm-và-chưa-kiểm).

## Cách chạy

Chạy bằng **root**, từ bản phát hành connector đã ghim (bản đủ cây, xem [HOST_SERVICE.md](../hermes-runtime/HOST_SERVICE.md#release-package)):

```sh
FLEET="/opt/ihome-hermes/node/bin/node /opt/ihome-hermes/current/infra/hermes-fleet/fleet.mjs"
$FLEET liet-ke --config /etc/ihome-hermes-fleet/fleet.json
```

Mọi lệnh mặc định **chỉ in kế hoạch** (JSON) và một mã `expectedRevision`. Ghi thật: chạy lại đúng lệnh đó kèm `--apply --expect <expectedRevision>`. Máy chủ đổi giữa lúc xem và lúc ghi (worker khác, kênh khác, container khác) thì mã lệch và lệnh dừng trước khi ghi. Hai lệnh ghi không chạy song song (khoá `/run/ihome-hermes-fleet.lock`; khoá còn lại sau một lần chết giữa chừng không tự phá, xem xét rồi `rmdir` tay).

Đầu ra không bao giờ có mã kết nối (`hc_…`), token kênh (`hzn_…`) hay khoá nhà cung cấp model. Mã thoát: `0` xong, `3` kế hoạch bị chặn (có `blocksText` giải thích), `4` đã dựng nhưng chưa có bằng chứng trợ lý gọi được CRM, `1` lỗi khác.

| Lệnh | Việc |
| --- | --- |
| `them-nguoi` | Kiểm trước, dựng home + hồ sơ, tạo kênh Zalo, chuyển mã kết nối, khởi động lại worker, tạo lại mọi sidecar, dựng container, kiểm bằng chứng |
| `go-nguoi --ten <tên>` | Dừng container (giữ lại, đổi tên), thu hồi kênh, bỏ đăng ký kiểm học tập, **cất** home (không xoá) |
| `tao-lai-sidecar [--chi <container>]…` | Tạo lại sidecar theo ID worker hiện tại; mặc định mọi sidecar |
| `liet-ke` | Mỗi trợ lý một dòng: container, RAM, kênh, gateway, lần gọi CRM cuối |
| `don-handoff --connector <khoá> --connection-id <uuid>…` | Cất bản ghi mã của kết nối đã thu hồi khỏi kho handoff |

## Ai làm bước nào

Root chỉ điều phối. Bước nào chạm file riêng tư của một UID thì chạy bằng đúng UID đó qua `setpriv --reuid … --regid … --clear-groups --no-new-privs` (mô hình helper theo từng UID của [HOST_SERVICE.md](../hermes-runtime/HOST_SERVICE.md#operator-handoff-when-connector-worker-and-profile-have-different-uids)); quyền 0700/0600 của từng bên giữ nguyên.

| Bước của `them-nguoi` | Chạy bằng | Bằng gì |
| --- | --- | --- |
| Đọc liên kết Zalo, danh sách mã, hỏi connector mã còn sống | user connector | `helper-connector.mjs binding / list / check` |
| Tạo home 0700 | root | — |
| Tạo khung hồ sơ | UID trợ lý, container một lần không mạng | `hermes profile create <tên> --no-alias --no-skills` |
| Tạo kênh Zalo | UID worker | `operator.mjs create` (xem rồi ghi) |
| Ghi `config.yaml`, `.env`, SOUL, plugin | UID trợ lý | `helper-home.mjs seed` (đầu vào qua stdin) |
| Cài kỹ năng CRM chuẩn (thuộc root, trợ lý chỉ đọc) | root | `infra/hermes-skills/deploy.sh --root <home>/.hermes`, trước khi `config.yaml` có mã CRM |
| Chuyển mã kết nối | user connector → UID trợ lý | `helper-connector.mjs export` → stdin của `profile-provisioning-cli.mjs` |
| Đăng ký kiểm học tập | root | drop-in + `/etc/ihome-hermes-fleet/learning-audit.json` |
| Khởi động lại worker có drain | root | `worker/deploy/zalo-worker.sh run <image> --native` |
| Tạo lại sidecar, dựng container, kiểm | root | `docker` |

Bí mật chỉ đi từ stdout của helper này vào stdin của helper kia qua bộ nhớ tiến trình root: không qua đối số, biến môi trường, file tạm, log hay màn hình. Hai helper xuất bí mật từ chối chạy khi stdout là terminal.

Hồ sơ mới nhận: `config.yaml` từ khuôn [`khuon/config.yaml`](khuon/config.yaml) (không có bí mật); `SOUL.md` chép từ hồ sơ khuôn **đang cài trên máy chủ** (SOUL không nằm trong repo); trong `.env` chỉ có khoá dùng chung nêu ở `template.sharedEnvKeys` (khoá nhà cung cấp model) và năm biến kênh của chính người đó. Mã CRM và token kênh của hồ sơ khuôn không bao giờ được chép sang.

## Chuẩn bị một lần trên máy chủ

1. Bản phát hành connector chứa `infra/hermes-fleet` đã chuyển `current` (theo runbook phát hành hiện có).
2. Tạo `/etc/ihome-hermes-fleet/fleet.json` từ [`fleet-config.example.json`](fleet-config.example.json), chủ `root:root`, quyền `0600`, thư mục `0755`. Thay `image` bằng đúng digest của image Hermes đang chạy (`docker inspect hermes-owner --format '{{.Image}}'`); các giá trị còn lại trong file mẫu là giả. `ram.expectedMb` là RAM một trợ lý ăn khi chạy, `ram.keepFreeMb` là phần phải còn trống sau khi thêm; thiếu thì `them-nguoi` từ chối, không có cờ bỏ qua.
3. Bộ canh mạng cho mọi sidecar (thay `hermes-owner-netwatch`, vốn chỉ biết một container):

   ```sh
   install -D -m 0755 infra/hermes-fleet/netwatch/fleet-netwatch.sh /usr/local/libexec/ihome-hermes/fleet-netwatch.sh
   install -m 0644 infra/hermes-fleet/netwatch/ihome-hermes-fleet-netwatch.{service,timer} /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now ihome-hermes-fleet-netwatch.timer
   systemctl disable --now hermes-owner-netwatch.timer   # sau khi bộ mới đã chạy một lượt sạch
   ```

   Bộ canh `docker restart` một sidecar khi host gọi được nhà cung cấp model mà trong container không gọi được ở hai lần đo. Sidecar bám worker đã bị **thay** (ID khác) thì restart không cứu được: bộ canh ghi một dòng mức `err` (`journalctl -p err -t ihome-hermes-fleet-netwatch`) và chờ quản trị chạy `tao-lai-sidecar`.
4. Job kiểm học tập: cài bản unit mới của [hermes-learning-audit](../hermes-learning-audit/README.md) (đọc `--config-optional /etc/ihome-hermes-fleet/learning-audit.json`).

## Thêm một quản lý thật

Người dùng làm trước, trên web, bằng tài khoản của chính họ:

1. `/settings/hermes` → tạo kết nối → liên kết nick Zalo với nick bot (gửi mã `/hermes-link`) → bấm "Dùng kết nối này cho trợ lý".

Quản trị:

2. Tra bốn ID bằng truy vấn **chỉ đọc** (`npm run db:query`): ID trợ lý, ID người dùng, ID công ty và ID liên kết Zalo đang hoạt động của người đó. Không chép các ID này vào repo, ticket công khai hay log.
3. Xem kế hoạch:

   ```sh
   $FLEET them-nguoi --config /etc/ihome-hermes-fleet/fleet.json --ten <tên> --connector prod \
     --assistant-id <uuid> --user-id <uuid> --organization-id <uuid> --binding-id <uuid> [--ram-mb 700]
   ```

   Đọc `blocksText` nếu bị chặn. Các lý do thường gặp: từ network namespace của worker không mở được cổng của connector (cửa nội bộ Docker của connector đó chưa bật); liên kết Zalo chưa hoạt động; connector không giữ mã của kết nối đang chọn (người dùng tạo kết nối mới rồi bấm lại "Dùng kết nối này"); connector từ chối mã (hết hạn/thu hồi); nick Zalo đã có kênh ở hồ sơ khác; RAM không đủ.
4. Chọn lúc vắng rồi chạy lại kèm `--apply --expect <mã>`. Bước khởi động lại worker **ngắt tạm mọi trợ lý và mọi nick Zalo của worker**; launcher chờ worker drain xong mới thay, có thể lâu, không được ngắt giữa chừng. Sau đó mọi sidecar được tạo lại theo worker mới (bản cũ còn dưới tên `<container>-old-<giờ>`).
5. Đọc kết quả: `runtimeStatus: "verified"` nghĩa là container chạy, gateway `running`, Zalo `connected`, **và** nhật ký connector có lời gọi thành công của đúng kết nối đó sau lúc container khởi động (`crmEvidence`). `unverified` (mã thoát 4) thì chưa coi là xong: xem `docker logs hermes-<tên>` và chạy lại lệnh xem kế hoạch.
6. Kỹ năng chuẩn đã được `them-nguoi` cài vào home mới từ chính bản phát hành đang chạy công cụ. Sau mỗi bản phát hành kỹ năng về sau, chạy lại cho **từng** home (`liet-ke` cho biết các home đang có):

   ```sh
   bash infra/hermes-skills/deploy.sh --root /var/lib/ihome-hermes-profiles/<tên>/.hermes --profiles "<tên>"
   ```

7. Thêm ánh xạ hồ sơ `<tên>` → công ty + người dùng vào `learning-audit.json` của job nạp ([hermes-learning-audit](../hermes-learning-audit/README.md)); thiếu thì bài học của người đó không lên trang duyệt. Duyệt bài học và tin 21:00 vẫn chỉ về chủ.
8. Người dùng nhắn bot một câu hỏi CRM; `liet-ke` phải cho thấy `lastCrmCall.tool` của người đó.

Hỏng giữa chừng: **không xoá gì để thử lại**. Chạy lại lệnh xem kế hoạch: bước đã xong hiện `done` và được bỏ qua; UID lấy theo home đã có. Riêng `native_operator_commit_unknown` / `native_profile_commit_unknown` từ các bộ ghi có sẵn thì đọc hướng dẫn của chính chúng trước ([kênh](../hermes-zalo-native/README.md), [hồ sơ](../hermes-runtime/HOST_SERVICE.md)).

## Người thử trên connector TEST

`--thu-khong-kenh --connection-id <uuid>` chỉ dùng được với connector có `trial: true` (TEST). Nó dựng đủ home, hồ sơ, mã CRM và container, nhưng **không** tạo kênh Zalo, không khởi động lại worker, không đụng sidecar khác, không đăng ký kiểm học tập. Hồ sơ nhận một kênh giả trỏ vào `trialBridgePort`, một cổng không ai nghe trong network namespace của worker (công cụ từ chối nếu cổng đó trùng cổng cầu thật), nên gateway đứng ở trạng thái thử lại kết nối Zalo (`gateway_state: degraded`) và không chạm cầu thật; bước kiểm của người thử chấp nhận trạng thái đó, của người thật thì không. Gọi thử CRM bằng:

```sh
docker exec hermes-<tên> hermes --profile <tên> chat -q "<câu hỏi>" --oneshot -Q --max-turns 4 --source fleet-thu
```

Dùng để đo RAM khi hai container cùng chạy, kiểm cách ly (`docker exec hermes-<tên> ls /var/lib/ihome-hermes-profiles` phải lỗi; `docker inspect` chỉ có một bind là home của chính nó) và thử `tao-lai-sidecar --chi hermes-<tên>` mà không đụng `hermes-owner`. Gỡ bằng `go-nguoi`.

## Gỡ, tạo lại, dọn

- **`go-nguoi`** chỉ gỡ thứ do công cụ dựng (container mang nhãn `com.ihomecrm.fleet.name`, hoặc home có dấu `.ihome-fleet-seeded`); `hermes-owner` dựng tay bị từ chối. Container được dừng, tắt tự khởi động và đổi tên `hermes-<tên>-da-go-<giờ>`; home chuyển sang `archiveRoot/<tên>-<giờ>` (vẫn chứa mã CRM của người đó: giữ quyền 0700 và nhắc người dùng thu hồi kết nối ở `/settings/hermes`). Token kênh cũ hết hiệu lực ở lần khởi động lại worker kế tiếp; công cụ không khởi động lại worker khi gỡ. Tên đã gỡ không dùng lại được cho kênh mới (kênh đã thu hồi không tạo lại): chọn tên khác.
- **`tao-lai-sidecar`** dựng lại đúng cấu hình đang chạy của từng sidecar, chỉ đổi `--network` (thay cho script `w3-recreate-sidecar.py` ngoài repo, vốn chỉ biết `hermes-owner`). Chạy ngay sau mọi lần **thay** container worker. Sidecar lệch bộ cờ khoá (không read-only, thêm capability, mở cổng, bind ngoài home…) bị từ chối và nêu rõ chỗ lệch, không nhân bản cấu hình lỏng.
- **`don-handoff`**: kho handoff có trần 64 bản ghi, connector không tự xoá; đầy thì tạo kết nối mới hỏng với `handoff_capacity`. Quản trị tra SQL (chỉ đọc) lấy ID các kết nối **đã thu hồi**, xem trước lúc connector đang chạy (công cụ hỏi connector từng mã; mã còn được nhận thì từ chối), rồi dừng sạch connector, chạy `--apply --expect <mã>`, và khởi động lại. Bản ghi được chuyển sang `<stateRoot>/handoff-archive/`, không xoá. Ghi lúc connector đang chạy bị từ chối: mỗi thư mục handoff chỉ một tiến trình ghi.
- Container `-old-<giờ>` / `-da-go-<giờ>` và home đã cất do quản trị tự dọn khi không cần lùi nữa; công cụ không xoá.

## Giới hạn đã biết

- Thêm một kênh buộc khởi động lại worker (worker đọc cấu hình kênh một lần): mọi trợ lý ngắt tạm và phải tạo lại mọi sidecar. Nạp nóng cấu hình kênh nằm ngoài đợt này.
- Mọi trợ lý dùng chung một khoá và hạn mức nhà cung cấp model; chung giới hạn của cầu Zalo (8 lệnh gửi, 64 MiB ảnh).
- Một nick Zalo chỉ ghép được một tài khoản CRM trên một nick bot.
- Không có lệnh SQL liệt kê "ai đang chờ kích hoạt": quản trị tự tra ID.
- Kỹ năng chuẩn cài theo từng home; quên chạy `deploy.sh` cho một home thì home đó giữ bộ kỹ năng cũ.
- Máy 2 GB chỉ đủ thêm một trợ lý; cửa RAM từ chối người kế tiếp.

## Đã kiểm và chưa kiểm

Test (`node --test infra/hermes-fleet/*.test.mjs`): lõi kế hoạch thuần (cờ khoá, cửa RAM, mọi lý do từ chối, chạy tiếp sau khi hỏng, mã ghi đổi khi máy chủ đổi); helper theo UID trên file thật (gồm ca hồ sơ vừa gieo đi qua bộ ghi mã có sẵn, và ping connector qua HTTP thật); điều phối trọn lượt trên máy chủ giả (thứ tự bước, UID từng bước, bí mật chỉ ở stdin). `netwatch.test.mjs` cần bash nên chỉ chạy ở CI Linux.

Test không chứng minh được và phải kiểm trên máy thật: quyền Linux 0700/0600 và `setpriv`; `hermes profile create` trong container một lần; gateway thật với kênh giả; nhiều gateway chung network namespace; RAM thật khi hai trợ lý cùng trả lời; khởi động lại worker và tạo lại sidecar thật; tin Zalo thật của người thứ hai. Kết quả các lần thử trên máy chủ ghi ở PR đưa công cụ này vào, không chép số đo vào repo.
