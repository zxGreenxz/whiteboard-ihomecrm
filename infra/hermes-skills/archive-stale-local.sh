#!/usr/bin/env bash
# Cất (archive) skill CRM tự học cũ của các hồ sơ Hermes chỉ định, đúng cách Hermes lưu trữ skill: `hermes curator archive <tên>`
# (tools/skill_usage.archive_skill: chuyển thư mục skill vào profiles/<p>/skills/.archive/<tên>, ghi state archived vào .usage.json
# và sổ .curator_ledger.jsonl; khôi phục bằng `hermes curator restore <tên>`). Chạy trên HOST bằng root.
# MẶC ĐỊNH CHẠY KHÔ (chỉ in kế hoạch); --apply mới làm. --restore để khôi phục theo manifest của các lần cất.
#
#   bash infra/hermes-skills/archive-stale-local.sh --profiles "owner tkt tkh tkj"            # khô: xem sẽ cất gì
#   bash infra/hermes-skills/archive-stale-local.sh --profiles "owner" --apply                 # cất thật
#   bash infra/hermes-skills/archive-stale-local.sh --profiles "owner" --restore --apply       # khôi phục (mọi manifest đã ghi)
#
# Sao lưu trước khi cất (vào --backup-dir/archive-<stamp>-<pid>/<hồ sơ>/): tar thư mục skill, .usage.json, .curator_ledger.jsonl;
# manifest.tsv ghi (hồ sơ, skill, đường dẫn cũ, pinned) và được nối vào --backup-dir/archive-manifests.list ngay dòng đầu, để --restore
# trả skill về ĐÚNG thư mục cũ (Hermes restore đặt phẳng skills/<tên>) và ghim lại nếu từng ghim. Skill đang ghim (pinned) thì Hermes
# từ chối archive ⇒ script bỏ ghim trước; archive lỗi thì ghim lại ngay rồi dừng.
# KHÔNG cần khởi động lại gateway / container: phiên đang chạy nhận "No longer available: …" qua ghi chú skills changed ở lượt sau.
# Cất skill cũ chỉ sau khi deploy.sh đã đưa skill chuẩn vào hồ sơ và SOUL đã trỏ sang tên ihome-crm-* (SOUL cũ gọi đích danh
# crm-task-management / crm-room-communications).
set -euo pipefail
umask 077

ROOT=/var/lib/ihome-hermes-profiles/owner/.hermes
CONTAINER=hermes-owner
CONTAINER_USER=10003:10003
BACKUP_DIR=/root/ihome-hermes-skills-backups
SKILLS='crm-task-management crm-room-communications'
PROFILES=''
CLI=''
MANIFEST=''
APPLY=0
RESTORE=0

die() { echo "LỖI: $*" >&2; exit 1; }
usage() { sed -n '2,10p' "$0"; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --profiles) PROFILES="${2:?}"; shift 2 ;;
    --skills) SKILLS="${2:?}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --restore) RESTORE=1; shift ;;
    --manifest) MANIFEST="${2:?}"; shift 2 ;;
    --root) ROOT="${2:?}"; shift 2 ;;
    --container) CONTAINER="${2:?}"; shift 2 ;;
    --container-user) CONTAINER_USER="${2:?}"; shift 2 ;;
    --backup-dir) BACKUP_DIR="${2:?}"; shift 2 ;;
    # Lệnh Hermes thay cho `docker exec -u <user> <container> hermes` (vd khi Hermes chạy chỗ khác, hoặc test).
    --cli) CLI="${2:?}"; shift 2 ;;
    -h|--help) usage ;;
    *) die "tham số lạ: $1" ;;
  esac
done
uniq_words() { local out=() w; for w in $1; do case " ${out[*]} " in *" $w "*) ;; *) out+=("$w") ;; esac; done; echo "${out[*]}"; }
PROFILES="$(uniq_words "$PROFILES")"; SKILLS="$(uniq_words "$SKILLS")"
[ -n "$PROFILES" ] || die "thiếu --profiles (vd --profiles \"owner\")"
for p in $PROFILES; do
  [[ "$p" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || die "tên hồ sơ không hợp lệ: $p"
  [ -d "$ROOT/profiles/$p/skills" ] || die "không thấy $ROOT/profiles/$p/skills"
done
for s in $SKILLS; do [[ "$s" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || die "tên skill không hợp lệ: $s"; done
[ -n "$CLI" ] || CLI="docker exec -u $CONTAINER_USER $CONTAINER hermes"
read -r -a CLI_ARGV <<< "$CLI"
hermes_cli() { # hermes_cli <hồ sơ> <đối số curator…>
  local p="$1"; shift
  echo "  \$ ${CLI_ARGV[*]} --profile $p curator $*"
  [ "$APPLY" = 1 ] || return 0
  "${CLI_ARGV[@]}" --profile "$p" curator "$@"
}
mode="$( [ "$APPLY" = 1 ] && echo 'LÀM THẬT' || echo 'CHẠY KHÔ (thêm --apply để làm)')"

# Thư mục (tương đối skills/) của skill có frontmatter name = $2 trong hồ sơ $1, bỏ .archive và thư mục ẩn; rỗng nếu không có.
find_skill() {
  local base="$ROOT/profiles/$1/skills" file
  while IFS= read -r -d '' file; do
    if [ "$(awk 'NR == 1 { next } /^---[[:space:]]*$/ { exit } /^name:[[:space:]]*/ { sub(/^name:[[:space:]]*/, ""); gsub(/["\047\r]/, ""); print; exit }' "$file")" = "$2" ]; then
      dirname -- "${file#"$base"/}"; return 0
    fi
  done < <(find "$base" -path "$base/.*" -prune -o -name SKILL.md -type f -print0)
}
pinned_of() { # in 1 nếu .usage.json ghi skill $2 của hồ sơ $1 đang ghim, 0 nếu không, ? nếu không đọc được
  local usage="$ROOT/profiles/$1/skills/.usage.json"
  [ -f "$usage" ] || { echo 0; return 0; }
  python3 -I - "$usage" "$2" 2>/dev/null <<'PY' || echo '?'
import json, sys
with open(sys.argv[1], encoding='utf-8') as fh:
    record = json.load(fh).get(sys.argv[2]) or {}
print(1 if record.get('pinned') is True else 0)
PY
}

if [ "$RESTORE" = 0 ]; then
  echo "Cất skill cũ [$SKILLS] của hồ sơ [$PROFILES] — $mode"
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  OUT="$BACKUP_DIR/archive-$STAMP-$$"   # kèm PID: hai lượt cùng giây không dùng chung manifest
  done_any=0
  for p in $PROFILES; do
    for s in $SKILLS; do
      rel="$(find_skill "$p" "$s")"
      if [ -z "$rel" ]; then
        if [ -d "$ROOT/profiles/$p/skills/.archive/$s" ]; then echo "$p/$s: đã cất trước đó — bỏ qua."; else echo "$p/$s: không có — bỏ qua."; fi
        continue
      fi
      pinned="$(pinned_of "$p" "$s")"
      echo "$p/$s: ở skills/$rel$( [ "$pinned" = 1 ] && echo ', đang ghim'; [ "$pinned" = '?' ] && echo ', chưa đọc được trạng thái ghim') ⇒ cất vào skills/.archive/$s"
      if [ "$APPLY" = 1 ]; then
        [ "$pinned" != '?' ] || die "$p/$s: không đọc được .usage.json (cần python3) — dừng trước khi cất"
        mkdir -p -- "$OUT/$p"
        [ -f "$OUT/$p/usage.json" ] || cp -p -- "$ROOT/profiles/$p/skills/.usage.json" "$OUT/$p/usage.json" 2>/dev/null || true
        [ -f "$OUT/$p/curator_ledger.jsonl" ] || cp -p -- "$ROOT/profiles/$p/skills/.curator_ledger.jsonl" "$OUT/$p/curator_ledger.jsonl" 2>/dev/null || true
        tar -C "$ROOT/profiles/$p/skills" -czf "$OUT/$p/skill-$s.tgz" "$rel"
        printf '%s\t%s\t%s\t%s\n' "$p" "$s" "$rel" "$pinned" >> "$OUT/manifest.tsv"
        # Sổ manifest ghi NGAY dòng đầu (không chờ cuối): lỗi giữa chừng vẫn khôi phục được phần đã làm; --restore đọc mọi manifest.
        grep -qxF -- "$OUT/manifest.tsv" "$BACKUP_DIR/archive-manifests.list" 2>/dev/null || printf '%s\n' "$OUT/manifest.tsv" >> "$BACKUP_DIR/archive-manifests.list"
      fi
      [ "$pinned" = 1 ] && hermes_cli "$p" unpin "$s"
      archived=1
      hermes_cli "$p" archive "$s" || archived=0
      if [ "$APPLY" = 1 ]; then
        [ -n "$(find_skill "$p" "$s")" ] && archived=0
        if [ "$archived" = 0 ]; then
          # Hermes không cất được: skill vẫn ở chỗ cũ ⇒ trả lại ghim (nếu vừa bỏ) trước khi dừng, lần chạy sau thấy đúng trạng thái.
          if [ "$pinned" = 1 ]; then hermes_cli "$p" pin "$s" || true; fi
          die "$p/$s chưa được cất — xem lỗi của Hermes ở trên; sao lưu ở $OUT/$p"
        fi
        compgen -G "$ROOT/profiles/$p/skills/.archive/$s*" >/dev/null || die "$p/$s không thấy trong skills/.archive/ sau khi archive"
        done_any=1
      fi
    done
  done
  if [ "$APPLY" = 1 ] && [ "$done_any" = 1 ]; then
    echo "Xong. Sao lưu + manifest: $OUT (khôi phục: --restore --apply)."
  elif [ "$APPLY" = 1 ]; then echo "KHÔNG ĐỔI GÌ (không còn skill nào cần cất)."
  else echo "CHẠY KHÔ xong — không ghi gì."; fi
  exit 0
fi

# ---- Khôi phục theo manifest (mặc định: mọi manifest trong sổ). Mỗi (hồ sơ, skill) lấy dòng của manifest MỚI NHẤT có nó (đường dẫn
#      cũ + trạng thái ghim lúc cất gần nhất), làm theo thứ tự xuất hiện đầu tiên; mỗi skill làm lặp lại được.
if [ -n "$MANIFEST" ]; then MANIFESTS=("$MANIFEST"); else
  MANIFESTS=()
  if [ -f "$BACKUP_DIR/archive-manifests.list" ]; then mapfile -t MANIFESTS < "$BACKUP_DIR/archive-manifests.list"; fi
fi
[ "${#MANIFESTS[@]}" -gt 0 ] || die "không thấy manifest để khôi phục (truyền --manifest <đường dẫn manifest.tsv>)"
declare -A NEWEST=()
ORDER=()
for m in "${MANIFESTS[@]}"; do
  [ -f "$m" ] || die "manifest không còn: $m"
  while IFS=$'\t' read -r p s rel pinned; do
    [ -n "${NEWEST[$p/$s]+x}" ] || ORDER+=("$p/$s")
    NEWEST[$p/$s]="$p"$'\t'"$s"$'\t'"$rel"$'\t'"$pinned"
  done < "$m"
done
echo "Khôi phục theo ${MANIFESTS[*]} cho hồ sơ [$PROFILES], skill [$SKILLS] — $mode"
for key in "${ORDER[@]}"; do
  IFS=$'\t' read -r p s rel pinned <<< "${NEWEST[$key]}"
  case " $PROFILES " in *" $p "*) ;; *) continue ;; esac
  case " $SKILLS " in *" $s "*) ;; *) continue ;; esac
  [[ "$rel" =~ ^[A-Za-z0-9._/-]+$ && "$rel" != *..* ]] || die "đường dẫn lạ trong manifest: $rel"
  if [ -n "$(find_skill "$p" "$s")" ]; then
    # Đang có (vd lần cất trước lỗi sau khi bỏ ghim): chỉ ghim lại nếu manifest ghi từng ghim (ghim lại là việc lặp được).
    if [ "$pinned" = 1 ]; then echo "$p/$s: đang có — ghim lại."; hermes_cli "$p" pin "$s"; else echo "$p/$s: đang có — bỏ qua."; fi
    continue
  fi
  echo "$p/$s: khôi phục về skills/$rel$( [ "$pinned" = 1 ] && echo ' và ghim lại')"
  hermes_cli "$p" restore "$s"
  flat="$ROOT/profiles/$p/skills/$s"
  if [ "$rel" != "$s" ]; then
    echo "  chuyển skills/$s → skills/$rel"
    if [ "$APPLY" = 1 ]; then
      [ -d "$flat" ] || die "$p/$s: Hermes không đặt skill ở skills/$s sau restore"
      [ ! -e "$ROOT/profiles/$p/skills/$rel" ] || die "$p/$s: skills/$rel đã có — dừng, xem tay"
      # Thư mục cha (vd productivity/) mất thì dựng lại TỪNG tầng cùng chủ với skills/ của hồ sơ, 0755 (không theo umask 077).
      missing=(); d="$(dirname -- "$ROOT/profiles/$p/skills/$rel")"
      while [ ! -d "$d" ]; do missing=("$d" "${missing[@]}"); d="$(dirname -- "$d")"; done
      for d in "${missing[@]}"; do
        install -d -m 0755 -o "$(stat -c %u "$ROOT/profiles/$p/skills")" -g "$(stat -c %g "$ROOT/profiles/$p/skills")" "$d"
      done
      mv -T -- "$flat" "$ROOT/profiles/$p/skills/$rel"
    fi
  fi
  [ "$pinned" = 1 ] && hermes_cli "$p" pin "$s"
  if [ "$APPLY" = 1 ] && [ -z "$(find_skill "$p" "$s")" ]; then die "$p/$s chưa trở lại sau restore"; fi
done
[ "$APPLY" = 1 ] && echo "Khôi phục xong." || echo "CHẠY KHÔ xong — không ghi gì."
