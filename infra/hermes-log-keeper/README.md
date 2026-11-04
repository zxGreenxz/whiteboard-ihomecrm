# Giữ log dịch vụ Hermes (VPS)

journald trên VPS chạy trong RAM, chỉ còn khoảng 1,5–2 giờ. Ngày 31/10 và 02/11, token kết nối chết đúng lúc không còn dòng
journal nào để tra. Bộ này xuất journal của các dịch vụ Hermes ra đĩa mỗi 15 phút, không đổi cấu hình journald của hệ thống.

| Tệp | Việc |
|---|---|
| `log-keeper.sh` | Xuất phần journal MỚI của từng unit (con trỏ `--cursor-file`) ra `/var/log/ihome-hermes/<unit>/<ngày UTC>.log`; nén ngày cũ; xoá file nén quá 14 ngày; giữ tổng ≤ 300 MB (xoá file nén cũ nhất trước); che `hc_…` và `Bearer …`. In một dòng JSON đếm số. |
| `systemd/ihome-hermes-log-keeper.service` | Chạy script bằng user động thuộc nhóm `systemd-journal` (chỉ đọc journal), không mạng, chỉ ghi thư mục log + con trỏ. |
| `systemd/ihome-hermes-log-keeper.timer` | 3 phút sau khởi động, rồi mỗi 15 phút. |

Unit được giữ log (đổi bằng biến `UNITS` trong unit): `hermes-connector`, `hermes-connector-test`, `ihome-hermes-learning-audit`,
`ihome-hermes-learning-ingest`, `hermes-owner-netwatch`. Unit chưa có trên máy thì bỏ qua. Log container `hermes-owner` do Docker giữ
riêng, không thuộc bộ này.

Dòng xuất sau nửa đêm UTC vào file của ngày mới, kể cả khi nó thuộc mấy phút cuối ngày cũ: file theo NGÀY XUẤT, mỗi dòng vẫn có giờ
đầy đủ (`short-iso-precise`).

## Cài (root, trên VPS, sau khi `/opt/ihome-hermes/current` có thư mục này)

```bash
install -m 0644 /opt/ihome-hermes/current/infra/hermes-log-keeper/systemd/ihome-hermes-log-keeper.service \
  /opt/ihome-hermes/current/infra/hermes-log-keeper/systemd/ihome-hermes-log-keeper.timer /etc/systemd/system/
systemctl daemon-reload
systemctl start ihome-hermes-log-keeper.service      # chạy ngay một lượt, xem kết quả bằng journalctl -u … -n 3
systemctl enable --now ihome-hermes-log-keeper.timer
ls -la /var/log/ihome-hermes/                        # DynamicUser: thư mục thật ở /var/log/private/ihome-hermes
```

## Đọc

```bash
grep -h '"event":"connector_' /var/log/ihome-hermes/hermes-connector/*.log
zcat /var/log/ihome-hermes/hermes-connector/2026-11-05.log.gz | grep authenticate | tail
```

## Gỡ

`systemctl disable --now ihome-hermes-log-keeper.timer`, xoá hai unit trong `/etc/systemd/system`, `systemctl daemon-reload`. Log đã
giữ nằm lại trong `/var/log/private/ihome-hermes` cho tới khi xoá tay.
