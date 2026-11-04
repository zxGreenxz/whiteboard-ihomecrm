#!/usr/bin/env bash
# Giữ log dịch vụ Hermes lâu hơn journald RAM của VPS (chỉ còn ~1,5–2 giờ): mỗi lượt xuất phần journal MỚI của từng unit (con trỏ
# --cursor-file của journalctl) ra $LOG_DIR/<unit>/<ngày UTC>.log, nén file của ngày cũ, xoá file nén quá RETENTION_DAYS ngày, giữ
# tổng dung lượng file NÉN dưới MAX_TOTAL_MB (xoá file nén cũ nhất trước). Che token hc_…, "Bearer …" và JWT phòng khi lọt vào log.
# Chỉ đọc journal và ghi thư mục riêng; không đổi cấu hình journald của hệ thống. Cài theo README.md cùng thư mục.
# Mã thoát: 0 = mọi unit xuất được; 1 = có unit lỗi (đọc journal hoặc ghi đĩa) — con trỏ unit đó KHÔNG tiến, lượt sau xuất lại.
set -euo pipefail
umask 027
UNITS="${UNITS:-hermes-connector.service hermes-connector-test.service ihome-hermes-learning-audit.service ihome-hermes-learning-ingest.service hermes-owner-netwatch.service}"
LOG_DIR="${LOG_DIR:-/var/log/ihome-hermes}"
STATE_DIR="${STATE_DIR:-/var/lib/ihome-hermes-log-keeper}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
MAX_TOTAL_MB="${MAX_TOTAL_MB:-300}"
JOURNALCTL="${JOURNALCTL:-journalctl}"
TODAY="${TODAY:-$(date -u +%F)}"
FAIL_RESET="${FAIL_RESET:-3}"   # lỗi liên tiếp của một unit ⇒ bỏ con trỏ (lượt sau xuất lại từ đầu journal: có thể lặp, không mất)
[[ "$TODAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "TODAY sai khuôn: $TODAY" >&2; exit 2; }
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ && "$MAX_TOTAL_MB" =~ ^[0-9]+$ && "$FAIL_RESET" =~ ^[1-9][0-9]*$ ]] \
  || { echo "RETENTION_DAYS / MAX_TOTAL_MB / FAIL_RESET phải là số" >&2; exit 2; }
mkdir -p "$LOG_DIR" "$STATE_DIR"
# DynamicUser: systemd để /var/log/ihome-hermes là SYMLINK tới private/ihome-hermes; find/du không đi vào symlink ở điểm bắt đầu
# ⇒ phải giải ra thư mục thật, nếu không phần xoá theo tuổi / trần dung lượng không chạy (review #388).
LOG_DIR="$(readlink -f -- "$LOG_DIR")"; STATE_DIR="$(readlink -f -- "$STATE_DIR")"

# Dò một lần: journal hệ thống luôn có dòng. Không ra dòng nào ⇒ không có quyền đọc / không có file journal (journalctl -q nuốt cả
# "No journal files were found" và thoát 1 im lặng) ⇒ dừng mã 1, KHÔNG để các unit bên dưới bị coi là "không có gì mới" mãi.
probe="$("$JOURNALCTL" -q -n 1 -o cat --no-pager 2>/dev/null || true)"
[ -n "$probe" ] || { echo "không đọc được journal (dò không ra dòng nào)" >&2; exit 1; }

mask() {
  sed -E 's/hc_[A-Za-z0-9_-]{16,}/hc_***/g; s/(bearer[[:space:]]+)[A-Za-z0-9._~+\/=-]{8,}/\1***/gI;
          s/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/eyJ***/g'
}

exported=0; failed=0; failed_units=""
for unit in $UNITS; do
  # Ký tự đầu là chữ/số/@/_/-, không có "..": chặn "../x.service", "...service" (thư mục đích sẽ là $LOG_DIR/..).
  if ! [[ "$unit" =~ ^[A-Za-z0-9@_-][A-Za-z0-9@._-]*\.(service|timer)$ ]] || [[ "$unit" == *..* ]]; then
    echo "bỏ qua tên unit lạ: $unit" >&2; continue
  fi
  dir="$LOG_DIR/${unit%.*}"
  mkdir -p "$dir"
  out="$dir/$TODAY.log"
  cur="$STATE_DIR/$unit.cursor"; tmp="$cur.tmp"; fails="$STATE_DIR/$unit.fails"
  rm -f -- "$tmp"; [ -f "$cur" ] && cp -p -- "$cur" "$tmp"
  before=0; [ -f "$out" ] && before=$(wc -c < "$out")
  # Lần đầu (chưa có con trỏ) xuất mọi thứ journal còn giữ; các lần sau chỉ phần mới. journalctl ghi con trỏ vào file TẠM; chỉ khi
  # cả journalctl lẫn bước ghi đĩa thành công mới thay con trỏ thật (ghi đĩa lỗi giữa chừng ⇒ lượt sau xuất lại, không mất dòng).
  # journalctl v249 với --cursor-file mà KHÔNG hiện dòng nào (không có dòng mới; unit chưa có trên máy) trả mã 1 và không in gì ra
  # stderr (không lấy được con trỏ) — đo trên VPS 05/11. Lỗi thật (quyền đọc journal, con trỏ hỏng…) luôn có dòng "Failed …" ở stderr.
  # ⇒ mã ≠ 0 + stderr rỗng + không có dòng mới = "không có gì mới", không phải lỗi (giữ con trỏ cũ).
  errf="$STATE_DIR/$unit.err"
  set +e
  "$JOURNALCTL" -u "$unit" --cursor-file="$tmp" -o short-iso-precise --no-pager -q 2>"$errf" | mask >> "$out"
  st=("${PIPESTATUS[@]}")
  set -e
  mid=0; [ -f "$out" ] && mid=$(wc -c < "$out")
  # Chỉ mã ĐÚNG 1 (chết vì tín hiệu 137/143… vẫn là lỗi) và file stderr PHẢI có mà rỗng (chuyển hướng 2> hỏng thì không che được).
  if [ "${st[0]}" = 1 ] && [ "${st[1]}" = 0 ] && [ -f "$errf" ] && [ ! -s "$errf" ] && [ "$mid" = "$before" ]; then st[0]=0; fi
  [ -s "$errf" ] && sed 's/^/journalctl: /' "$errf" >&2
  rm -f -- "$errf"
  if [ "${st[0]}" = 0 ] && [ "${st[1]}" = 0 ]; then
    [ -f "$tmp" ] && mv -f -- "$tmp" "$cur"
    rm -f -- "$fails"
  else
    rm -f -- "$tmp"; failed=$((failed + 1)); failed_units="$failed_units $unit"
    n=$(( $(cat "$fails" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$fails"
    echo "lỗi xuất $unit (journalctl=${st[0]}, ghi=${st[1]}, lần $n liên tiếp)" >&2
    if [ "$n" -ge "$FAIL_RESET" ]; then rm -f -- "$cur" "$fails"; echo "bỏ con trỏ $unit sau $n lần lỗi" >&2; fi
  fi
  after=0; [ -f "$out" ] && after=$(wc -c < "$out")
  if [ -f "$out" ] && [ "$after" = 0 ]; then rm -f -- "$out"; fi
  exported=$((exported + after - before))
  # Ngày cũ (file .log khác hôm nay) ⇒ nén. Đã có .gz của ngày đó (đồng hồ lùi qua nửa đêm, chạy tay với TODAY khác) ⇒ NỐI thêm một
  # member gzip (zcat đọc đủ), không ghi đè. gzip giữ mtime của file gốc nên phép xoá theo tuổi vẫn đúng.
  while IFS= read -r -d '' f; do
    if [ -e "$f.gz" ]; then gzip -c -- "$f" >> "$f.gz" && rm -f -- "$f"; else gzip -- "$f"; fi
  done < <(find "$dir" -maxdepth 1 -type f -name '*.log' ! -name "$TODAY.log" -print0)
done

find "$LOG_DIR" -type f -name '*.log.gz' -mtime +"$RETENTION_DAYS" -delete
removed=0
# Trần chỉ tính và chỉ xoá file NÉN (file hôm nay đang ghi không bị xoá giữa ngày — README nêu giới hạn này).
gz_kb() { find "$LOG_DIR" -type f -name '*.log.gz' -printf '%k\n' | awk '{s+=$1} END {print s+0}'; }
while [ "$(gz_kb)" -gt $((MAX_TOTAL_MB * 1024)) ]; do
  oldest="$(find "$LOG_DIR" -type f -name '*.log.gz' -printf '%T@ %p\n' | sort -n | head -1 | cut -d' ' -f2-)"
  [ -n "$oldest" ] || break
  rm -f -- "$oldest"; removed=$((removed + 1))
done
echo "{\"exportedBytes\":$exported,\"removedOverCap\":$removed,\"failedUnits\":$failed,\"day\":\"$TODAY\"}"
[ "$failed" = 0 ] || { echo "unit lỗi:$failed_units" >&2; exit 1; }
