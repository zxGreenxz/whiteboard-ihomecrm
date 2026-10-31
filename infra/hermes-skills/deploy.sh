#!/usr/bin/env bash
# Triển khai skill CRM chuẩn (infra/hermes-skills) từ MỘT bản phát hành connector vào hồ sơ Hermes trên VPS. Chạy trên HOST bằng
# root, không chạy trong container. Mặc định ghi thật; --dry-run chỉ in kế hoạch, không ghi gì. Chạy lại cùng bản phát hành ⇒
# không đổi gì.
#
#   bash infra/hermes-skills/deploy.sh --profiles "owner" [--release /opt/ihome-hermes/current] [--dry-run]
#
# Kiểm HẾT trước (bản phát hành, cây sha đã có, symlink, config từng hồ sơ, YAML ứng viên — cả khi chạy khô), có lỗi thì dừng khi
# chưa đổi gì; rồi:
#  1. Chép <release>/infra/hermes-skills/{DESCRIPTION.md,ihome-crm-*/SKILL.md} vào <root>/ihome-official-skills/<sha>/ihome-crm/
#     (chủ --owner, mặc định root:root; thư mục 0755, file 0644). <sha> lấy từ <release>/RELEASE_SHA (thiếu thì tên thư mục). Đã
#     có <sha> giống hệt ⇒ giữ nguyên; có mà khác ⇒ DỪNG (một sha chỉ có một nội dung).
#  2. Đổi symlink <root>/ihome-official-skills/<link> → <sha> nguyên tử (symlink tạm + mv -T). Đích TƯƠNG ĐỐI để đọc được cả trên
#     host lẫn trong container (host <root> = container <container-root>). Symlink có trước khi config trỏ tới nó.
#  3. Mỗi hồ sơ chỉ định: bảo đảm profiles/<p>/config.yaml có skills.external_dirs chứa <container-root>/ihome-official-skills/<link>.
#     Chưa có khối skills ⇒ nối thêm khối (sao lưu vào --backup-dir, giữ chủ + quyền, thay nguyên tử, kiểm YAML nếu host có
#     python3 + PyYAML). Đã có khối skills mà thiếu đường dẫn ⇒ DỪNG, sửa tay (không đoán YAML).
#  4. Chưa chạm config cho <sha> này (dấu <root>/ihome-official-skills/.<link>.touched khác <sha>: symlink vừa đổi, hoặc lần trước
#     chết trước bước này) ⇒ chạm (touch) config.yaml của mọi hồ sơ đang trỏ tới <link>, rồi ghi dấu = <sha>. Hermes nhớ đường dẫn
#     external_dirs ĐÃ RESOLVE theo chữ ký file config (agent/skill_utils.get_external_skills_dirs); chạm file thì gateway đang
#     chạy đọc bản mới ở lượt sau.
#
# KHÔNG cần khởi động lại gateway hay container hermes-owner (khởi động lại làm gián đoạn Zalo): đổi config / chạm config làm Hermes
# quét lại skill ở lượt sau, và phiên đang chạy nhận danh sách skill mới qua ghi chú "skills changed" (agent/skills_index_delta.py).
# SOUL.md thì khác: phiên đang chạy giữ nguyên system prompt đã lưu; SOUL mới chỉ vào phiên mới hoặc khi phiên được nén.
set -euo pipefail
umask 022

RELEASE=/opt/ihome-hermes/current
ROOT=/var/lib/ihome-hermes-profiles/owner/.hermes
CROOT=/home/hermes/.hermes
LINK_NAME=current
OWNER=0:0
BACKUP_DIR=/root/ihome-hermes-skills-backups
PROFILES=''
DRY=0

die() { echo "LỖI: $*" >&2; exit 1; }
usage() { sed -n '2,6p' "$0"; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE="${2:?}"; shift 2 ;;
    --profiles) PROFILES="${2:?}"; shift 2 ;;
    --link) LINK_NAME="${2:?}"; shift 2 ;;
    --root) ROOT="${2:?}"; shift 2 ;;
    --container-root) CROOT="${2:?}"; shift 2 ;;
    --owner) OWNER="${2:?}"; shift 2 ;;
    --backup-dir) BACKUP_DIR="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage ;;
    *) die "tham số lạ: $1" ;;
  esac
done

[[ "$LINK_NAME" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "--link phải là chữ thường/số/-/_ (vd current)"
[[ "$OWNER" =~ ^[0-9]+:[0-9]+$ ]] || die "--owner phải dạng UID:GID số"
OWNER_UID="${OWNER%%:*}"; OWNER_GID="${OWNER##*:}"
if [ "$DRY" = 0 ] && [ "$OWNER_UID" = 0 ] && [ "$(id -u)" != 0 ]; then die "ghi thật với chủ root:root phải chạy bằng root"; fi
PROFILE_LIST=()
for p in $PROFILES; do
  [[ "$p" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || die "tên hồ sơ không hợp lệ: $p"
  [ -f "$ROOT/profiles/$p/config.yaml" ] || die "không thấy $ROOT/profiles/$p/config.yaml"
  case " ${PROFILE_LIST[*]} " in *" $p "*) ;; *) PROFILE_LIST+=("$p") ;; esac
done
[ "${#PROFILE_LIST[@]}" -gt 0 ] || die "thiếu --profiles (vd --profiles \"owner\")"

REL="$(readlink -f -- "$RELEASE")" || die "không đọc được bản phát hành $RELEASE"
[ -d "$REL" ] || die "bản phát hành không phải thư mục: $REL"
SRC="$REL/infra/hermes-skills"
[ -f "$SRC/DESCRIPTION.md" ] || die "bản phát hành thiếu infra/hermes-skills/DESCRIPTION.md: $SRC (dựng release từ cả cây git)"
if [ -f "$REL/RELEASE_SHA" ]; then SHA="$(tr -d '[:space:]' < "$REL/RELEASE_SHA")"; else SHA="$(basename -- "$REL")"; fi
[[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || die "sha bản phát hành không hợp lệ: $SHA"

# Danh sách skill của bản phát hành; kiểm sơ bộ frontmatter (CI kiểm đầy đủ ở infra/hermes-broker/official-skills.test.mjs).
SKILLS=()
for dir in "$SRC"/ihome-crm-*/; do
  [ -d "$dir" ] || continue
  name="$(basename -- "$dir")"
  file="$dir/SKILL.md"
  [ -f "$file" ] || die "$name thiếu SKILL.md"
  [ "$(head -n 1 "$file" | tr -d '\r')" = "---" ] || die "$name/SKILL.md không mở đầu bằng frontmatter ---"
  fm_name="$(awk 'NR == 1 { next } /^---[[:space:]]*$/ { exit } /^name:[[:space:]]*/ { sub(/^name:[[:space:]]*/, ""); gsub(/["\047\r]/, ""); print; exit }' "$file")"
  [ "$fm_name" = "$name" ] || die "$name/SKILL.md có name '$fm_name' khác tên thư mục"
  grep -q '^description:' "$file" || die "$name/SKILL.md thiếu description"
  SKILLS+=("$name")
done
[ "${#SKILLS[@]}" -gt 0 ] || die "bản phát hành không có skill ihome-crm-* nào ở $SRC"

BASE="$ROOT/ihome-official-skills"
DEST="$BASE/$SHA"
LINK="$BASE/$LINK_NAME"
WANT="$CROOT/ihome-official-skills/$LINK_NAME"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"   # kèm PID: hai lượt cùng giây không dùng chung thư mục sao lưu
CHANGES=()
echo "Bản phát hành: $REL (sha $SHA), ${#SKILLS[@]} skill: ${SKILLS[*]}"
echo "Đích: $DEST; symlink $LINK; external_dirs: $WANT; hồ sơ: ${PROFILE_LIST[*]}$( [ "$DRY" = 1 ] && echo ' — CHẠY KHÔ, không ghi gì')"

# Cây của một sha: ihome-crm/DESCRIPTION.md + ihome-crm/<skill>/SKILL.md (chỉ các file này).
expected_files() {
  echo "ihome-crm/DESCRIPTION.md"
  for name in "${SKILLS[@]}"; do echo "ihome-crm/$name/SKILL.md"; done
}
source_of() { case "$1" in ihome-crm/DESCRIPTION.md) echo "$SRC/DESCRIPTION.md" ;; ihome-crm/*) echo "$SRC/${1#ihome-crm/}" ;; esac; }
skills_block() { awk '/^skills:/ { on = 1; print; next } on && /^[^[:space:]#]/ { exit } on { print }' "$1"; }
refers_link() { grep -qF -- "$WANT" <<< "$(skills_block "$1")"; }
MARK="$BASE/.$LINK_NAME.touched"
TOUCHED_SHA="$( [ -f "$MARK" ] && tr -d '[:space:]' < "$MARK" || true)"
yaml_check() { # yaml_check <cũ> <mới> <đường dẫn>: mới = cũ + đúng khối skills.external_dirs [đường dẫn]
  if ! command -v python3 >/dev/null 2>&1 || ! python3 -I -c 'import yaml' >/dev/null 2>&1; then
    echo "  CẢNH BÁO: host thiếu python3/PyYAML — chỉ kiểm dạng chữ, không kiểm YAML." >&2; return 0
  fi
  python3 -I - "$1" "$2" "$3" <<'PY'
import sys, yaml
old_path, new_path, want = sys.argv[1:4]
with open(old_path, encoding='utf-8') as fh: old = yaml.safe_load(fh) or {}
with open(new_path, encoding='utf-8') as fh: new = yaml.safe_load(fh) or {}
expected = dict(old); expected['skills'] = {'external_dirs': [want]}
sys.exit(0 if isinstance(old, dict) and 'skills' not in old and new == expected else 1)
PY
}

# ==== KIỂM (không đổi gì; config ứng viên dựng trong thư mục tạm riêng) ====
WORK="$(mktemp -d)"
TEMPS=("$WORK")
trap 'rm -rf -- "${TEMPS[@]}"' EXIT
DEST_PLAN=keep
if [ -d "$DEST" ]; then
  actual="$(cd "$DEST" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)"
  [ "$actual" = "$(expected_files | LC_ALL=C sort)" ] || die "$DEST đã có nhưng khác danh sách file của bản phát hành $SHA — không ghi đè"
  while read -r rel; do cmp -s "$(source_of "$rel")" "$DEST/$rel" || die "$DEST/$rel khác bản phát hành — không ghi đè"; done < <(expected_files)
  [ -z "$(find "$DEST" \( -type d ! -perm 0755 \) -o \( -type f ! -perm 0644 \) -o ! -uid "$OWNER_UID" -o ! -gid "$OWNER_GID")" ] || DEST_PLAN=fix
else DEST_PLAN=create; fi
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then die "$LINK có mà không phải symlink"; fi
CURRENT_TARGET="$( [ -L "$LINK" ] && readlink -- "$LINK" || true)"
APPEND=()
for p in "${PROFILE_LIST[@]}"; do
  CFG="$ROOT/profiles/$p/config.yaml"
  block="$(skills_block "$CFG")"
  if grep -qF -- "$WANT" <<< "$block"; then continue; fi
  [ -z "$block" ] || die "$p: config.yaml đã có khối skills: mà chưa có $WANT — thêm tay vào skills.external_dirs (không tự sửa YAML)"
  cp -- "$CFG" "$WORK/$p.orig"
  cp -- "$CFG" "$WORK/$p.new"
  if [ -s "$WORK/$p.new" ] && [ -n "$(tail -c 1 "$WORK/$p.new")" ]; then printf '\n' >> "$WORK/$p.new"; fi
  printf '%s\n' '' '# Skill CRM chuẩn phát hành cùng connector (infra/hermes-skills/deploy.sh); Hermes chỉ đọc thư mục này.' \
    'skills:' '  external_dirs:' "    - $WANT" >> "$WORK/$p.new"
  yaml_check "$WORK/$p.orig" "$WORK/$p.new" "$WANT" || die "$p: kiểm YAML sau khi nối khối skills thất bại — chưa đổi gì"
  APPEND+=("$p")
done

if [ "$DRY" = 1 ]; then
  case "$DEST_PLAN" in create) echo "  (khô) sẽ tạo $DEST ($(expected_files | wc -l | tr -d ' ') file)" ;; fix) echo "  (khô) sẽ sửa chủ/quyền trong $DEST" ;;
    *) echo "Giữ nguyên $DEST (đã có, giống hệt)." ;; esac
  if [ "$CURRENT_TARGET" = "$SHA" ]; then echo "Giữ nguyên $LINK → $SHA."; else echo "  (khô) sẽ đổi $LINK: ${CURRENT_TARGET:-(chưa có)} → $SHA"; fi
  for p in "${APPEND[@]}"; do echo "  (khô) sẽ nối khối skills.external_dirs [$WANT] vào $ROOT/profiles/$p/config.yaml (sao lưu trước; YAML ứng viên đã kiểm)"; done
  if [ "$TOUCHED_SHA" != "$SHA" ]; then
    for CFG in "$ROOT"/profiles/*/config.yaml; do
      if [ -f "$CFG" ] && refers_link "$CFG"; then echo "  (khô) sẽ chạm $CFG"; fi
    done
  fi
  echo "CHẠY KHÔ xong — không ghi gì."; exit 0
fi

# ==== LÀM ====
# Khoá chống chạy chồng (mkdir nguyên tử; bị kẹt sau khi bị giết thì xoá tay thư mục .deploy.lock). Dọn file tạm khi thoát.
if [ ! -d "$BASE" ]; then install -d -m 0755 -o "$OWNER_UID" -g "$OWNER_GID" "$BASE"; CHANGES+=("tạo $BASE"); fi
LOCK="$BASE/.deploy.lock"
mkdir "$LOCK" 2>/dev/null || die "đang có lượt triển khai khác (hoặc khoá cũ còn): $LOCK"
TEMPS+=("$BASE/.stage-$SHA-$$" "$BASE/$LINK_NAME.tmp.$$" "$MARK.tmp.$$")
trap 'rmdir "$LOCK" 2>/dev/null || true; rm -rf -- "${TEMPS[@]}"' EXIT

# Config ứng viên đặt cạnh config thật (giữ chủ + quyền bằng cp -p), nội dung đúng bản đã kiểm; config đổi giữa chừng ⇒ dừng.
for p in "${APPEND[@]}"; do
  CFG="$ROOT/profiles/$p/config.yaml"
  cmp -s -- "$CFG" "$WORK/$p.orig" || die "$p: config.yaml vừa đổi trong lúc chạy — chưa đổi gì, chạy lại"
  TMP="$(dirname -- "$CFG")/.config.yaml.ihome-skills.$$"
  TEMPS+=("$TMP")
  cp -p -- "$CFG" "$TMP"
  cat -- "$WORK/$p.new" > "$TMP"
done

# 1. Cây skill của sha.
case "$DEST_PLAN" in
  create)
    STAGE="$BASE/.stage-$SHA-$$"
    install -d -m 0755 -o "$OWNER_UID" -g "$OWNER_GID" "$STAGE" "$STAGE/ihome-crm"
    while read -r rel; do
      install -d -m 0755 -o "$OWNER_UID" -g "$OWNER_GID" "$(dirname -- "$STAGE/$rel")"
      install -m 0644 -o "$OWNER_UID" -g "$OWNER_GID" "$(source_of "$rel")" "$STAGE/$rel"
    done < <(expected_files)
    mv -T -- "$STAGE" "$DEST"
    CHANGES+=("tạo $DEST") ;;
  fix)
    chown -R "$OWNER_UID:$OWNER_GID" "$DEST"; find "$DEST" -type d -exec chmod 0755 {} +; find "$DEST" -type f -exec chmod 0644 {} +
    CHANGES+=("sửa chủ/quyền $DEST") ;;
  *) echo "Giữ nguyên $DEST (đã có, giống hệt)." ;;
esac

# 2. Symlink <link> → <sha> (tương đối), đổi nguyên tử.
if [ "$CURRENT_TARGET" = "$SHA" ]; then echo "Giữ nguyên $LINK → $SHA."
else
  ln -s -- "$SHA" "$BASE/$LINK_NAME.tmp.$$"
  chown -h "$OWNER_UID:$OWNER_GID" "$BASE/$LINK_NAME.tmp.$$" 2>/dev/null || true
  mv -T -- "$BASE/$LINK_NAME.tmp.$$" "$LINK"
  [ "$(readlink -- "$LINK")" = "$SHA" ] || die "đổi symlink thất bại: $LINK"
  CHANGES+=("đổi $LINK: ${CURRENT_TARGET:-(chưa có)} → $SHA")
fi

# 3. skills.external_dirs: sao lưu rồi thay nguyên tử bằng config ứng viên đã kiểm.
for p in "${APPEND[@]}"; do
  CFG="$ROOT/profiles/$p/config.yaml"
  (umask 077 && mkdir -p -- "$BACKUP_DIR/$STAMP/$p")
  cp -p -- "$CFG" "$BACKUP_DIR/$STAMP/$p/config.yaml"
  mv -f -- "$(dirname -- "$CFG")/.config.yaml.ihome-skills.$$" "$CFG"
  CHANGES+=("$p: thêm skills.external_dirs (sao lưu $BACKUP_DIR/$STAMP/$p/config.yaml)")
done

# 4. Chưa chạm cho <sha> này ⇒ chạm config của mọi hồ sơ trỏ tới <link>, rồi ghi dấu (ghi dấu SAU khi chạm: chết giữa chừng thì
#    lần chạy sau chạm lại).
if [ "$TOUCHED_SHA" != "$SHA" ]; then
  for CFG in "$ROOT"/profiles/*/config.yaml; do
    if [ -f "$CFG" ] && refers_link "$CFG"; then
      touch -c -- "$CFG"
      CHANGES+=("$(basename -- "$(dirname -- "$CFG")"): chạm config.yaml để nạp $SHA")
    fi
  done
  printf '%s\n' "$SHA" > "$MARK.tmp.$$"
  mv -f -- "$MARK.tmp.$$" "$MARK"
  CHANGES+=("ghi dấu $MARK = $SHA")
fi

if [ "${#CHANGES[@]}" -eq 0 ]; then echo "KHÔNG ĐỔI GÌ (đã đúng bản $SHA)."; else
  echo "ĐÃ ĐỔI:"; printf '  - %s\n' "${CHANGES[@]}"
  echo "Không cần khởi động lại hermes-owner: phiên đang chạy nhận skill mới ở lượt kế tiếp."
fi
