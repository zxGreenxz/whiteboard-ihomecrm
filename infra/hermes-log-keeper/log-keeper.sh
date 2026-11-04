#!/usr/bin/env bash
# Giữ log dịch vụ Hermes lâu hơn journald RAM của VPS (chỉ còn ~1,5–2 giờ): mỗi lượt xuất phần journal MỚI của từng unit (con trỏ
# --cursor-file của journalctl) ra $LOG_DIR/<unit>/<ngày UTC>.log, nén file của ngày cũ, xoá file nén quá RETENTION_DAYS ngày, giữ
# tổng dung lượng dưới MAX_TOTAL_MB (xoá file nén cũ nhất trước). Che token hc_… và "Bearer …" phòng khi lọt vào log.
# Chỉ đọc journal và ghi thư mục riêng; không đổi cấu hình journald của hệ thống. Cài theo README.md cùng thư mục.
set -euo pipefail
umask 027
UNITS="${UNITS:-hermes-connector.service hermes-connector-test.service ihome-hermes-learning-audit.service ihome-hermes-learning-ingest.service hermes-owner-netwatch.service}"
LOG_DIR="${LOG_DIR:-/var/log/ihome-hermes}"
STATE_DIR="${STATE_DIR:-/var/lib/ihome-hermes-log-keeper}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
MAX_TOTAL_MB="${MAX_TOTAL_MB:-300}"
JOURNALCTL="${JOURNALCTL:-journalctl}"
TODAY="${TODAY:-$(date -u +%F)}"
[[ "$TODAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "TODAY sai khuôn: $TODAY" >&2; exit 2; }
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ && "$MAX_TOTAL_MB" =~ ^[0-9]+$ ]] || { echo "RETENTION_DAYS / MAX_TOTAL_MB phải là số" >&2; exit 2; }
mkdir -p "$LOG_DIR" "$STATE_DIR"

mask() { sed -E 's/hc_[A-Za-z0-9_-]{16,}/hc_***/g; s/(Bearer[[:space:]]+)[A-Za-z0-9._~+\/=-]{8,}/\1***/g'; }

exported=0
for unit in $UNITS; do
  if ! [[ "$unit" =~ ^[A-Za-z0-9@._-]+\.(service|timer)$ ]]; then echo "bỏ qua tên unit lạ: $unit" >&2; continue; fi
  dir="$LOG_DIR/${unit%.*}"
  mkdir -p "$dir"
  out="$dir/$TODAY.log"
  # Lần đầu (chưa có con trỏ) xuất mọi thứ journal còn giữ; các lần sau chỉ phần mới. journalctl tự ghi lại con trỏ.
  # Unit chưa có trên máy / journal không đọc được ⇒ bỏ qua unit đó, các unit khác vẫn chạy.
  before=0; [ -f "$out" ] && before=$(wc -c < "$out")
  "$JOURNALCTL" -u "$unit" --cursor-file="$STATE_DIR/$unit.cursor" -o short-iso-precise --no-pager -q 2>/dev/null | mask >> "$out" || true
  after=0; [ -f "$out" ] && after=$(wc -c < "$out")
  [ "$after" -gt 0 ] || rm -f "$out"
  exported=$((exported + after - before))
  # Ngày cũ (file .log khác hôm nay) ⇒ nén; gzip giữ mtime nên phép xoá theo tuổi vẫn đúng.
  find "$dir" -maxdepth 1 -type f -name '*.log' ! -name "$TODAY.log" -exec gzip -f {} \;
done

find "$LOG_DIR" -type f -name '*.log.gz' -mtime +"$RETENTION_DAYS" -delete
removed=0
while [ "$(du -sk "$LOG_DIR" | cut -f1)" -gt $((MAX_TOTAL_MB * 1024)) ]; do
  oldest="$(find "$LOG_DIR" -type f -name '*.log.gz' -printf '%T@ %p\n' | sort -n | head -1 | cut -d' ' -f2-)"
  [ -n "$oldest" ] || break
  rm -f -- "$oldest"; removed=$((removed + 1))
done
echo "{\"exportedBytes\":$exported,\"removedOverCap\":$removed,\"day\":\"$TODAY\"}"
