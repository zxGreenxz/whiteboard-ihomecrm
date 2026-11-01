#!/usr/bin/env bash
# Triển khai skill CRM chuẩn (infra/hermes-skills) từ MỘT bản phát hành connector vào hồ sơ Hermes trên VPS. Chạy trên HOST bằng
# root, không chạy trong container. Mặc định ghi thật; --dry-run chỉ in kế hoạch, không ghi gì. Chạy lại cùng bản ⇒ không đổi gì.
#
#   bash deploy.sh --profiles "owner" [--release /opt/ihome-hermes/current] [--dry-run]                 # production: link current
#   bash deploy.sh --profiles "tkt tkh tkj" --link test --release /opt/ihome-hermes-test/current        # hồ sơ TEST: link riêng
#   bash deploy.sh --profiles "tkt" --link test --remove [--dry-run]                                    # gỡ khối skills đã nối
#
# Mỗi nhóm hồ sơ dùng một symlink riêng (--link): owner (connector production) = current, hồ sơ TEST (connector 8741) = test.
# Kiểm HẾT trước (bản phát hành, cây sha đã có, symlink, hồ sơ ngoài --profiles đang dùng link, config từng hồ sơ, YAML ứng viên — cả
# khi chạy khô), có lỗi thì dừng khi chưa đổi gì; rồi:
#  1. Chép <release>/infra/hermes-skills/{DESCRIPTION.md,ihome-crm-*/SKILL.md} vào <root>/ihome-official-skills/<sha>/ihome-crm/
#     (chủ --owner, mặc định root:root; thư mục 0755, file 0644 — tiến trình Hermes uid 10003 không ghi được, đó là lớp bảo vệ thật).
#     <sha> lấy từ <release>/RELEASE_SHA (thiếu thì tên thư mục). Đã có <sha> giống hệt ⇒ giữ nguyên; có mà khác ⇒ DỪNG.
#  2. Đổi symlink <root>/ihome-official-skills/<link> → <sha> nguyên tử (symlink tạm + mv -T), đích TƯƠNG ĐỐI (host <root> =
#     container <container-root>). Có hồ sơ NGOÀI --profiles đang trỏ tới <link> ⇒ DỪNG (đổi link sẽ đổi skill của hồ sơ đó).
#  3. Mỗi hồ sơ chỉ định: bảo đảm config.yaml có skills.external_dirs chứa mục <container-root>/ihome-official-skills/<link>. Chưa có
#     khối skills ⇒ nối thêm khối (sao lưu vào --backup-dir chỉ để đối chiếu, giữ chủ + quyền, thay nguyên tử, kiểm YAML bằng PyYAML
#     hoặc js-yaml của bản phát hành — ghi thật mà không kiểm được thì DỪNG). Đã có khối skills mà thiếu mục ⇒ DỪNG, sửa tay.
#  4. Chưa chạm config cho <sha> này (dấu .<link>.touched khác <sha>) ⇒ chạm (touch) config.yaml của các hồ sơ trỏ tới <link> rồi
#     ghi dấu. Hermes nhớ đường dẫn external_dirs ĐÃ RESOLVE theo chữ ký file config (agent/skill_utils.get_external_skills_dirs).
# --remove: gỡ khối skills cấp một khi nó đúng bằng {external_dirs: [<WANT>]} (bộ kiểm YAML xác nhận; vẫn gỡ được khi config đã bị
# Hermes / yaml.dump ghi lại, mất dòng chú thích), không đụng symlink / thư mục sha. Lùi bằng --remove, KHÔNG chép đè config.yaml từ
# sao lưu: config có header Authorization có thể đã được xoay sau đó, chép đè ⇒ MCP 401, bot mất CRM.
#
# KHÔNG cần khởi động lại gateway hay container hermes-owner (khởi động lại làm gián đoạn Zalo): đổi / chạm config làm Hermes quét
# lại skill ở lượt sau, phiên đang chạy nhận danh sách skill mới qua ghi chú "skills changed" (agent/skills_index_delta.py). SOUL.md
# thì khác: phiên đang chạy giữ system prompt đã lưu; SOUL mới chỉ vào phiên mới (/new) hoặc khi phiên được nén.
set -euo pipefail
umask 022

RELEASE=/opt/ihome-hermes/current
ROOT=/var/lib/ihome-hermes-profiles/owner/.hermes
CROOT=/home/hermes/.hermes
LINK_NAME=current
OWNER=0:0
HERMES_UID=10003
BACKUP_DIR=/root/ihome-hermes-skills-backups
PROFILES=''
DRY=0
REMOVE=0
COMMENT='# Skill CRM chuẩn phát hành cùng connector (infra/hermes-skills/deploy.sh); Hermes chỉ đọc thư mục này.'

die() { echo "LỖI: $*" >&2; exit 1; }
usage() { sed -n '2,8p' "$0"; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE="${2:?}"; shift 2 ;;
    --profiles) PROFILES="${2:?}"; shift 2 ;;
    --link) LINK_NAME="${2:?}"; shift 2 ;;
    --root) ROOT="${2:?}"; shift 2 ;;
    --container-root) CROOT="${2:?}"; shift 2 ;;
    --owner) OWNER="${2:?}"; shift 2 ;;
    --hermes-uid) HERMES_UID="${2:?}"; shift 2 ;;
    --backup-dir) BACKUP_DIR="${2:?}"; shift 2 ;;
    --remove) REMOVE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage ;;
    *) die "tham số lạ: $1" ;;
  esac
done

[[ "$LINK_NAME" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "--link phải là chữ thường/số/-/_ (vd current, test)"
[[ "$OWNER" =~ ^[0-9]+:[0-9]+$ ]] || die "--owner phải dạng UID:GID số"
[[ "$HERMES_UID" =~ ^[0-9]+$ ]] || die "--hermes-uid phải là số"
OWNER_UID="${OWNER%%:*}"; OWNER_GID="${OWNER##*:}"
if [ "$DRY" = 0 ] && [ "$OWNER_UID" = 0 ] && [ "$(id -u)" != 0 ]; then die "ghi thật với chủ root:root phải chạy bằng root"; fi
# Skill chuẩn thuộc root để tiến trình Hermes (uid $HERMES_UID) KHÔNG ghi được; chủ trùng uid Hermes thì mất lớp bảo vệ đó.
if [ "$DRY" = 0 ] && [ "$OWNER_UID" = "$HERMES_UID" ]; then die "--owner trùng uid của Hermes ($HERMES_UID): Hermes sẽ sửa được skill chuẩn"; fi
read -r -a REQUESTED <<< "$PROFILES"
PROFILE_LIST=()
in_list() { local item; for item in "${PROFILE_LIST[@]}"; do [ "$item" = "$1" ] && return 0; done; return 1; }
for p in "${REQUESTED[@]}"; do
  [[ "$p" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || die "tên hồ sơ không hợp lệ: $p"
  [ -f "$ROOT/profiles/$p/config.yaml" ] || die "không thấy $ROOT/profiles/$p/config.yaml"
  in_list "$p" || PROFILE_LIST+=("$p")
done
[ "${#PROFILE_LIST[@]}" -gt 0 ] || die "thiếu --profiles (vd --profiles \"owner\")"

REL="$(readlink -f -- "$RELEASE")" || die "không đọc được bản phát hành $RELEASE"
[ -d "$REL" ] || die "bản phát hành không phải thư mục: $REL"
BASE="$ROOT/ihome-official-skills"
LINK="$BASE/$LINK_NAME"
WANT="$CROOT/ihome-official-skills/$LINK_NAME"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"   # kèm PID: hai lượt cùng giây không dùng chung thư mục sao lưu
CHANGES=()
WORK="$(mktemp -d)"
TEMPS=("$WORK")
LOCK=''
trap 'if [ -n "$LOCK" ]; then rmdir "$LOCK" 2>/dev/null || true; fi; rm -rf -- "${TEMPS[@]}"' EXIT
# <WANT> đưa cho bộ kiểm YAML qua file, không qua đối số: Git Bash trên Windows đổi đối số "/home/..." thành "C:/.../home/...".
printf '%s' "$WANT" > "$WORK/want"

# Khối skills cấp một của config (in ra; rỗng nếu không có).
skills_block() { awk '/^skills:/ { on = 1; print; next } on && /^[^[:space:]#]/ { exit } on { print }' "$1"; }
# Config có MỤC danh sách = <WANT> dưới skills.external_dirs (bỏ qua dòng chú thích và mục của khoá khác, chấp nhận dấu nháy) ⇒ mã 0.
refers_link() {
  awk -v want="$WANT" '
    /^skills:/ { on = 1; key = ""; next }
    on && /^[^ \t#]/ { on = 0 }
    on && /^[ \t]+[A-Za-z0-9_]+:/ { key = $0; sub(/^[ \t]+/, "", key); sub(/:.*/, "", key); next }
    on && key == "external_dirs" && /^[ \t]*-[ \t]/ {
      v = $0; sub(/^[ \t]*-[ \t]+/, "", v); sub(/[ \t]+#.*$/, "", v); sub(/[ \t]+$/, "", v)
      if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v = substr(v, 2, length(v) - 2)
      if (v == want) found = 1
    }
    END { exit found ? 0 : 1 }' "$1"
}
# Bộ kiểm YAML: PyYAML (đúng bộ đọc của Hermes) nếu host có, không thì js-yaml trong node_modules của bản phát hành.
# Node: ưu tiên Node 24 của connector (node hệ điều hành có thể quá cũ cho đoạn kiểm), không có thì node trên PATH.
if [ -x /opt/ihome-hermes/node/bin/node ]; then NODE_BIN=/opt/ihome-hermes/node/bin/node; else NODE_BIN="$(command -v node || true)"; fi
if command -v python3 >/dev/null 2>&1 && python3 -I -c 'import yaml' >/dev/null 2>&1; then YAML_CHECKER=PyYAML
elif [ -n "$NODE_BIN" ] && [ -f "$REL/node_modules/js-yaml/package.json" ]; then YAML_CHECKER=js-yaml
else YAML_CHECKER=''; fi
JS_CHECK='const [oldPath, newPath, wantPath, yamlDir] = process.argv.slice(1);
const fs = require("fs"); const yaml = require(yamlDir); const want = fs.readFileSync(wantPath, "utf8");
const load = p => yaml.load(fs.readFileSync(p, "utf8")) ?? {};
const canon = v => Array.isArray(v) ? v.map(canon) : v !== null && typeof v === "object" && !(v instanceof Date)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const old = load(oldPath), next = load(newPath);
const ok = old !== null && typeof old === "object" && !Array.isArray(old) && !Object.hasOwn(old, "skills") &&
  JSON.stringify(canon(next)) === JSON.stringify(canon({ ...old, skills: { external_dirs: [want] } }));
process.exit(ok ? 0 : 1);'
# yaml_same <không có khối> <có khối> <nhãn>: mã 0 khi bản "có khối" = bản kia + đúng skills.external_dirs [<WANT>] (so cấu trúc YAML,
# không so chữ: thứ tự khoá, thụt lề, chú thích không tính). Không có bộ kiểm: chạy khô ⇒ cảnh báo, coi như đạt; ghi thật ⇒ dừng.
# KHÔNG in nội dung (config có token).
yaml_same() {
  local ok=1
  case "$YAML_CHECKER" in
    PyYAML) python3 -I - "$1" "$2" "$WORK/want" >/dev/null 2>&1 <<'PY' && ok=0
import sys, yaml
old_path, new_path, want_path = sys.argv[1:4]
with open(want_path, encoding='utf-8') as fh: want = fh.read()
with open(old_path, encoding='utf-8') as fh: old = yaml.safe_load(fh) or {}
with open(new_path, encoding='utf-8') as fh: new = yaml.safe_load(fh) or {}
expected = dict(old); expected['skills'] = {'external_dirs': [want]}
sys.exit(0 if isinstance(old, dict) and 'skills' not in old and new == expected else 1)
PY
      ;;
    js-yaml) "$NODE_BIN" -e "$JS_CHECK" "$1" "$2" "$WORK/want" "$REL/node_modules/js-yaml" >/dev/null 2>&1 && ok=0 ;;
    *)
      [ "$DRY" = 1 ] || die "$3: không có bộ kiểm YAML (python3 + PyYAML, hoặc node + js-yaml trong $REL/node_modules) — chưa đổi gì"
      echo "  CẢNH BÁO: không có bộ kiểm YAML — chạy khô chỉ kiểm dạng chữ; ghi thật sẽ dừng." >&2; return 0 ;;
  esac
  [ "$ok" = 0 ] || return 1
  echo "  Kiểm YAML ($YAML_CHECKER): đạt — $3"
}
yaml_check() { yaml_same "$@" || die "$3: kiểm YAML thất bại (không in nội dung config) — chưa đổi gì"; }
take_lock() { # khoá chống chạy chồng (mkdir nguyên tử; bị giết giữa chừng thì xoá tay thư mục .deploy.lock)
  mkdir "$BASE/.deploy.lock" 2>/dev/null || die "đang có lượt triển khai khác (hoặc khoá cũ còn): $BASE/.deploy.lock"
  LOCK="$BASE/.deploy.lock"
}
# Thay config bằng bản ứng viên đã kiểm: config vẫn đúng bản lúc kiểm ⇒ sao lưu (đối chiếu) ⇒ ghi bản tạm cạnh config (giữ chủ +
# quyền) ⇒ cmp lại ngay trước mv ⇒ mv nguyên tử.
replace_config() { # replace_config <hồ sơ> <nhãn thay đổi>
  local p="$1" cfg="$ROOT/profiles/$1/config.yaml" tmp
  cmp -s -- "$cfg" "$WORK/$p.orig" || die "$p: config.yaml vừa đổi trong lúc chạy — dừng, chạy lại"
  (umask 077 && mkdir -p -- "$BACKUP_DIR/$STAMP/$p")
  cp -p -- "$cfg" "$BACKUP_DIR/$STAMP/$p/config.yaml"
  tmp="$(dirname -- "$cfg")/.config.yaml.ihome-skills.$$"
  TEMPS+=("$tmp")
  cp -p -- "$cfg" "$tmp"
  cat -- "$WORK/$p.new" > "$tmp"
  cmp -s -- "$cfg" "$WORK/$p.orig" || die "$p: config.yaml vừa đổi trong lúc chạy — dừng, chạy lại"
  mv -f -- "$tmp" "$cfg"
  CHANGES+=("$p: $2 (sao lưu đối chiếu $BACKUP_DIR/$STAMP/$p/config.yaml)")
}
summary() {
  if [ "${#CHANGES[@]}" -eq 0 ]; then echo "KHÔNG ĐỔI GÌ$1."; else
    echo "ĐÃ ĐỔI:"; printf '  - %s\n' "${CHANGES[@]}"
    echo "Không cần khởi động lại hermes-owner: phiên đang chạy nhận danh sách skill mới ở lượt kế tiếp."
  fi
}

# ==== --remove: gỡ khối skills mà bước 3 đã nối ====
# Khối = dòng "skills:" cấp một tới trước dòng cấp một kế tiếp, kèm dòng chú thích của deploy.sh ngay trên (và một dòng trống trước nó)
# nếu còn. KHÔNG so chữ: config có thể đã được Hermes / yaml.dump ghi lại (xoay token ⇒ mất chú thích, đổi thụt lề, đổi thứ tự khoá).
# Bộ kiểm YAML xác nhận bản gỡ + {skills: {external_dirs: [<WANT>]}} đúng bằng config hiện tại; khối có thêm mục / khoá ⇒ dừng, gỡ tay.
if [ "$REMOVE" = 1 ]; then
  echo "Gỡ skills.external_dirs [$WANT] khỏi hồ sơ: ${PROFILE_LIST[*]}$( [ "$DRY" = 1 ] && echo ' — CHẠY KHÔ, không ghi gì')"
  TO_REMOVE=()
  for p in "${PROFILE_LIST[@]}"; do
    CFG="$ROOT/profiles/$p/config.yaml"
    if ! refers_link "$CFG"; then
      case "$(skills_block "$CFG")" in *"$WANT"*) die "$p: khối skills nhắc $WANT ở dạng lạ (không phải mục của external_dirs) — gỡ tay" ;; esac
      echo "Giữ nguyên $p: skills.external_dirs không có $WANT."; continue
    fi
    rc=0
    awk -v c="$COMMENT" '
      { line[NR] = $0 }
      END {
        n = 0
        for (i = 1; i <= NR; i++) if (line[i] ~ /^skills:/) { n++; start = i }
        if (n != 1) exit 4
        last = start
        while (last < NR && (line[last + 1] ~ /^[ \t]/ || line[last + 1] == "")) last++
        while (last > start && line[last] == "") last--
        from = start
        if (from > 1 && line[from - 1] == c) { from--; if (from > 1 && line[from - 1] == "") from-- }
        for (i = 1; i <= NR; i++) if (i < from || i > last) print line[i]
      }' "$CFG" > "$WORK/$p.new" || rc=$?
    [ "$rc" = 0 ] || die "$p: config.yaml có nhiều khối skills: cấp một — gỡ tay"
    cp -- "$CFG" "$WORK/$p.orig"
    yaml_same "$WORK/$p.new" "$WORK/$p.orig" "$p" || die "$p: khối skills không chỉ gồm external_dirs [$WANT] (đã thêm mục / khoá khác) — gỡ tay"
    TO_REMOVE+=("$p")
  done
  if [ "$DRY" = 1 ]; then
    for p in "${TO_REMOVE[@]}"; do echo "  (khô) sẽ gỡ khối skills.external_dirs [$WANT] khỏi $ROOT/profiles/$p/config.yaml (sao lưu trước)"; done
    echo "CHẠY KHÔ xong — không ghi gì."; exit 0
  fi
  if [ -d "$BASE" ]; then take_lock; fi
  for p in "${TO_REMOVE[@]}"; do replace_config "$p" "gỡ skills.external_dirs"; done
  summary ''
  exit 0
fi

# ==== Triển khai ====
SRC="$REL/infra/hermes-skills"
[ -f "$SRC/DESCRIPTION.md" ] || die "bản phát hành thiếu infra/hermes-skills/DESCRIPTION.md: $SRC (dựng release có infra/hermes-skills)"
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
DEST="$BASE/$SHA"
MARK="$BASE/.$LINK_NAME.touched"
TOUCHED_SHA="$( [ -f "$MARK" ] && tr -d '[:space:]' < "$MARK" || true)"
echo "Bản phát hành: $REL (sha $SHA), ${#SKILLS[@]} skill: ${SKILLS[*]}"
echo "Đích: $DEST; symlink $LINK; external_dirs: $WANT; hồ sơ: ${PROFILE_LIST[*]}$( [ "$DRY" = 1 ] && echo ' — CHẠY KHÔ, không ghi gì')"

# Cây của một sha: ihome-crm/DESCRIPTION.md + ihome-crm/<skill>/SKILL.md (chỉ các file này).
expected_files() {
  echo "ihome-crm/DESCRIPTION.md"
  for name in "${SKILLS[@]}"; do echo "ihome-crm/$name/SKILL.md"; done
}
source_of() { case "$1" in ihome-crm/DESCRIPTION.md) echo "$SRC/DESCRIPTION.md" ;; ihome-crm/*) echo "$SRC/${1#ihome-crm/}" ;; esac; }

# ---- KIỂM (không đổi gì; config ứng viên dựng trong thư mục tạm riêng) ----
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
  if refers_link "$CFG"; then continue; fi
  [ -z "$(skills_block "$CFG")" ] || die "$p: config.yaml đã có khối skills: mà chưa có mục $WANT — thêm tay vào skills.external_dirs (không tự sửa YAML)"
  cp -- "$CFG" "$WORK/$p.orig"
  cp -- "$CFG" "$WORK/$p.new"
  if [ -s "$WORK/$p.new" ] && [ -n "$(tail -c 1 "$WORK/$p.new")" ]; then printf '\n' >> "$WORK/$p.new"; fi
  printf '%s\n' '' "$COMMENT" 'skills:' '  external_dirs:' "    - $WANT" >> "$WORK/$p.new"
  yaml_check "$WORK/$p.orig" "$WORK/$p.new" "$p"
  APPEND+=("$p")
done
# Hồ sơ đang trỏ tới <link> (kể cả sắp nối). Link đổi / chưa chạm cho sha này mà có hồ sơ ngoài --profiles dùng link ⇒ dừng.
REFERRING=("${APPEND[@]}")
for CFG in "$ROOT"/profiles/*/config.yaml; do
  [ -f "$CFG" ] || continue
  p="$(basename -- "$(dirname -- "$CFG")")"
  if refers_link "$CFG"; then REFERRING+=("$p"); fi
done
OUTSIDERS=()
for p in "${REFERRING[@]}"; do in_list "$p" || OUTSIDERS+=("$p"); done
if { [ "$CURRENT_TARGET" != "$SHA" ] || [ "$TOUCHED_SHA" != "$SHA" ]; } && [ "${#OUTSIDERS[@]}" -gt 0 ]; then
  die "symlink $LINK_NAME đang được hồ sơ ngoài --profiles dùng: ${OUTSIDERS[*]} — thêm vào --profiles, hoặc dùng --link riêng cho nhóm hồ sơ này"
fi

if [ "$DRY" = 1 ]; then
  case "$DEST_PLAN" in create) echo "  (khô) sẽ tạo $DEST ($(expected_files | wc -l | tr -d ' ') file)" ;; fix) echo "  (khô) sẽ sửa chủ/quyền trong $DEST" ;;
    *) echo "Giữ nguyên $DEST (đã có, giống hệt)." ;; esac
  if [ "$CURRENT_TARGET" = "$SHA" ]; then echo "Giữ nguyên $LINK → $SHA."; else echo "  (khô) sẽ đổi $LINK: ${CURRENT_TARGET:-(chưa có)} → $SHA"; fi
  for p in "${APPEND[@]}"; do echo "  (khô) sẽ nối khối skills.external_dirs [$WANT] vào $ROOT/profiles/$p/config.yaml (sao lưu trước)"; done
  if [ "$TOUCHED_SHA" != "$SHA" ]; then for p in "${REFERRING[@]}"; do echo "  (khô) sẽ chạm $ROOT/profiles/$p/config.yaml"; done; fi
  echo "CHẠY KHÔ xong — không ghi gì."; exit 0
fi

# ---- LÀM ----
if [ ! -d "$BASE" ]; then install -d -m 0755 -o "$OWNER_UID" -g "$OWNER_GID" "$BASE"; CHANGES+=("tạo $BASE"); fi
take_lock
TEMPS+=("$BASE/.stage-$SHA-$$" "$BASE/$LINK_NAME.tmp.$$" "$MARK.tmp.$$")

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

# 2. Symlink <link> → <sha> (tương đối), đổi nguyên tử. Có trước khi config trỏ tới nó.
if [ "$CURRENT_TARGET" = "$SHA" ]; then echo "Giữ nguyên $LINK → $SHA."
else
  ln -s -- "$SHA" "$BASE/$LINK_NAME.tmp.$$"
  chown -h "$OWNER_UID:$OWNER_GID" "$BASE/$LINK_NAME.tmp.$$" 2>/dev/null || true
  mv -T -- "$BASE/$LINK_NAME.tmp.$$" "$LINK"
  [ "$(readlink -- "$LINK")" = "$SHA" ] || die "đổi symlink thất bại: $LINK"
  CHANGES+=("đổi $LINK: ${CURRENT_TARGET:-(chưa có)} → $SHA")
fi

# 3. skills.external_dirs của hồ sơ chưa có.
for p in "${APPEND[@]}"; do replace_config "$p" "thêm skills.external_dirs [$WANT]"; done

# 4. Chưa chạm cho <sha> này ⇒ chạm config của mọi hồ sơ trỏ tới <link> (đều trong --profiles), rồi ghi dấu (SAU khi chạm: chết giữa
#    chừng thì lần sau chạm lại).
if [ "$TOUCHED_SHA" != "$SHA" ]; then
  for p in "${REFERRING[@]}"; do
    touch -c -- "$ROOT/profiles/$p/config.yaml"
    CHANGES+=("$p: chạm config.yaml để nạp $SHA")
  done
  printf '%s\n' "$SHA" > "$MARK.tmp.$$"
  mv -f -- "$MARK.tmp.$$" "$MARK"
  CHANGES+=("ghi dấu $MARK = $SHA")
fi

summary " (đã đúng bản $SHA)"
