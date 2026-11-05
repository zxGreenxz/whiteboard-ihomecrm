# Giữ log dịch vụ Hermes (VPS)

journald trên VPS chạy trong RAM, chỉ còn khoảng 1,5–2 giờ. Ngày 31/10 và 02/11, token kết nối chết đúng lúc không còn dòng
journal nào để tra. Bộ này xuất journal của các dịch vụ Hermes ra đĩa mỗi 15 phút, không đổi cấu hình journald của hệ thống.

| Tệp | Việc |
|---|---|
| `log-keeper.sh` | Xuất phần journal MỚI của từng unit (con trỏ `--cursor-file`) ra `/var/log/ihome-hermes/<unit>/<ngày UTC>.log`; nén ngày cũ; xoá file nén quá 14 ngày; giữ tổng file NÉN ≤ 300 MB (xoá file nén cũ nhất trước); che `hc_…`, `Bearer …` (mọi kiểu chữ) và JWT. In một dòng JSON đếm số; có unit lỗi thì thoát mã 1. |
| `systemd/ihome-hermes-log-keeper.service` | Chạy script bằng user động thuộc nhóm `systemd-journal` (chỉ đọc journal), không mạng, chỉ ghi thư mục log + con trỏ. |
| `systemd/ihome-hermes-log-keeper.timer` | 3 phút sau khởi động, rồi mỗi 15 phút. |

Unit được giữ log (đổi bằng biến `UNITS` trong unit): `hermes-connector`, `hermes-connector-test`, `ihome-hermes-learning-audit`,
`ihome-hermes-learning-ingest`, `hermes-owner-netwatch`. Unit chưa có trên máy thì bỏ qua. Log container `hermes-owner` do Docker giữ
riêng, không thuộc bộ này.

Hành vi cần biết:

- File theo NGÀY XUẤT (UTC): dòng xuất sau nửa đêm vào file của ngày mới dù thuộc mấy phút cuối ngày cũ; mỗi dòng vẫn có giờ đầy đủ
  (`short-iso-precise`). File `.log` của một ngày đã nén mà xuất hiện lại thì được NỐI vào `.gz` cũ (thêm member gzip), không ghi đè.
- Con trỏ chỉ tiến khi cả `journalctl` lẫn bước ghi đĩa thành công; lỗi ⇒ lượt sau xuất lại (có thể lặp dòng, không mất). Một unit lỗi
  3 lượt liền ⇒ bỏ con trỏ, lượt sau xuất lại từ đầu phần journal còn giữ. Có unit lỗi ⇒ service ở trạng thái failed (xem
  `journalctl -u ihome-hermes-log-keeper`).
- Trần dung lượng chỉ tính và chỉ xoá file NÉN; file `.log` của hôm nay không bị giới hạn trong ngày (log connector bình thường vài
  chục KB mỗi lượt). `DynamicUser` làm `/var/log/ihome-hermes` thành symlink tới `/var/log/private/ihome-hermes`; script tự giải
  symlink trước khi tìm / đo.

## Cài (root, trên VPS, từ một bản phát hành có thư mục này)

```bash
R=/opt/ihome-hermes/current/infra/hermes-log-keeper
install -d -m 0755 /usr/local/libexec/ihome-hermes                                   # tường minh 0755: umask 077 của root làm user động không vào được
install -m 0755 "$R/log-keeper.sh" /usr/local/libexec/ihome-hermes/log-keeper.sh     # đường cố định: lùi bản connector không làm hỏng unit
install -m 0644 "$R/systemd/ihome-hermes-log-keeper.service" "$R/systemd/ihome-hermes-log-keeper.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl start ihome-hermes-log-keeper.service          # chạy ngay một lượt
journalctl -u ihome-hermes-log-keeper.service -n 3 --no-pager   # dòng JSON: exportedBytes > 0, failedUnits 0
ls -la /var/log/ihome-hermes/hermes-connector/           # phải có <ngày UTC>.log mới
systemctl enable --now ihome-hermes-log-keeper.timer
```

Cập nhật script về sau: chạy lại dòng `install -D` từ bản phát hành mới (unit không đổi thì không cần `daemon-reload`).

## Đọc

```bash
grep -h '"event":"connector_' /var/log/ihome-hermes/hermes-connector/*.log
zcat /var/log/ihome-hermes/hermes-connector/2026-11-05.log.gz | grep authenticate | tail
```

## Gỡ

```bash
systemctl disable --now ihome-hermes-log-keeper.timer
systemctl clean --what=logs --what=state ihome-hermes-log-keeper.service   # xoá log + con trỏ đã giữ (bỏ dòng này nếu muốn giữ log)
rm /etc/systemd/system/ihome-hermes-log-keeper.service /etc/systemd/system/ihome-hermes-log-keeper.timer /usr/local/libexec/ihome-hermes/log-keeper.sh
systemctl daemon-reload
```
