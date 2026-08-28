// Phạm vi git cho gate chạy trên working tree CHUNG nhiều phiên agent.
//
// Vấn đề (đo 28/08/2026, tái hiện tại chỗ): working tree này thường mang file
// WIP untracked của các phiên làm việc song song. Gate nào quét đĩa hoặc dùng
// `git ls-files --others` sẽ thấy cả chúng — phiên A tạo file dở là gate của
// phiên B đỏ oan, và `--fix` ghi con số phản ánh WIP của người khác. Ba commit
// fix(ci) cùng ngày (75c22b77, 91784e62, c9f3937f) đều chữa tay đúng lớp lỗi
// này; file này mã hoá cách chữa để nó không tái diễn.
//
// Nguyên tắc: phạm vi sự thật của gate local là INDEX ∪ tracked — đúng thứ CI
// sẽ nhìn thấy sau commit. File untracked chưa thuộc trách nhiệm của commit sắp
// push, nên vi phạm trên nó hạ xuống CẢNH BÁO ở local; ngay khi file được
// `git add` (Contract §3 bắt stage tên cụ thể trước commit) thì vi phạm trở lại
// thành lỗi CỨNG, và trên CI mọi thứ luôn CỨNG — tính "bắt trước khi push"
// không mất, chỉ dời từ lúc-còn-untracked sang lúc-đã-stage.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const goiGit = (args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const raDanhSach = (out) =>
  out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/"));

/**
 * File trong INDEX (đã tracked hoặc vừa `git add`) khớp các pattern.
 * `--cached` là chìa khoá: file MỚI đã stage vẫn được thấy — đó là điểm giữ
 * cho gate vẫn bắt được thay đổi của CHÍNH phiên mình trước khi commit.
 */
export function lietKeTracked(patterns = []) {
  return raDanhSach(goiGit(["ls-files", "--cached", "--", ...patterns]));
}

/** File untracked (chưa add, không bị .gitignore) khớp các pattern. */
export function lietKeUntracked(patterns = []) {
  return raDanhSach(goiGit(["ls-files", "--others", "--exclude-standard", "--", ...patterns]));
}

/**
 * Nội dung một file đúng như trong INDEX (`git show :0:<path>`) — bản mà CI sẽ
 * đọc sau commit, không phải bản trên đĩa có thể đang bẩn dở. Trả `null` nếu
 * đường dẫn không có trong index. Nội dung về theo LF như git lưu, nên so sánh
 * không dính bẫy CRLF của Windows.
 */
export function docTuIndex(relPath) {
  try {
    // stderr nuốt riêng ở đây: "path does not exist in the index" là kết quả
    // hợp lệ (trả null), không phải lỗi cần in ra màn hình người dùng.
    return execFileSync("git", ["show", `:0:${relPath.replace(/\\/g, "/")}`], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** GitHub Actions (và mọi CI phổ biến) luôn set CI=true. */
export function laCI() {
  return Boolean(process.env.CI);
}

/**
 * Tách vi phạm thành {cung, mem} theo luật untracked-mềm-local.
 *
 * @param {Array} viPhams  danh sách vi phạm, mỗi cái mang đường dẫn file
 * @param {Set<string>} tapUntracked  đường dẫn (dấu /) đang untracked
 * @param {boolean} ci  true ⇒ mọi vi phạm đều cứng
 * @param {(v) => string} layFile  cách lấy đường dẫn từ một vi phạm
 */
export function phanCap(viPhams, tapUntracked, ci, layFile = (v) => v.file) {
  if (ci) return { cung: [...viPhams], mem: [] };
  const cung = [];
  const mem = [];
  for (const v of viPhams) {
    (tapUntracked.has(layFile(v)) ? mem : cung).push(v);
  }
  return { cung, mem };
}
