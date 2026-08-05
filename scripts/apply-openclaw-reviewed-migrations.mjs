/**
 * Áp 12 migration OpenClaw ĐÃ ĐƯỢC DUYỆT lên project production — và không làm
 * gì khác.
 *
 * Công cụ này cố ý KHÔNG "thông minh". Nó không tự sắp lại thứ tự, không tự bỏ
 * qua file lạ, không tự quay lui, không ghi một dòng dữ liệu nào. Mọi đường tắt
 * ở đây đều là cách biến một sự cố nhỏ thành một schema mà sau đó không ai còn
 * mô tả được — và schema production thì không có nút hoàn tác.
 *
 * Khi có gì đó sai, nó DỪNG và nói ra, chứ không sửa: sửa sai phải bằng một
 * migration TIẾN TỚI đã qua duyệt, không bằng một lệnh quay lui chạy lúc 2 giờ
 * sáng.
 *
 * Mọi phụ thuộc (git, database) đều được TIÊM VÀO, để bộ test hợp đồng chạy được
 * mà không chạm git thật lẫn production.
 *
 * LƯU Ý VỀ TRẠNG THÁI HIỆN TẠI (05/08/2026): 12/12 migration này ĐÃ nằm trên
 * production và đã ghi sổ. Nên hôm nay công cụ chủ yếu đóng vai kiểm toán —
 * planApply() sẽ trả về danh sách rỗng. Nó vẫn cần tồn tại cho lần dựng lại
 * project, và để chứng minh cái đã áp đúng là cái đã duyệt.
 */
import { createHash } from "node:crypto";

/**
 * Số file đã duyệt. Đây là hằng số DUY NHẤT về danh sách; TÊN file thì dẫn xuất
 * từ chính cây đã duyệt chứ không chép lại ở đây.
 *
 * Vì sao không chép tên: lần đầu viết file này tôi chép tay 12 tên từ trí nhớ và
 * SAI BA CÁI — bịa ra `rls_policies`, `media_retention`, `rollout_state` trong
 * khi thật ra là `inbound_automation`, `access_policies`, `realtime_allowlist`.
 * Số lượng vẫn đúng 12 nên không có gì đỏ; chỉ khi đối chiếu với
 * scripts/test-openclaw-migrations.mjs mới lộ. Một danh sách chép tay là một
 * nguồn sự thật thứ hai, và nguồn thứ hai luôn trôi khỏi nguồn thứ nhất.
 */
export const OPENCLAW_REVIEWED_COUNT = 12;

/** Khuôn tên file migration OpenClaw. Dùng chung cho mọi phép lọc dưới đây. */
export const OPENCLAW_MIGRATION_PATTERN = /^20260727\d{6}_openclaw_[a-z0-9_]+\.sql$/u;

/**
 * Đọc danh sách đã duyệt TỪ CHÍNH cây đã duyệt, sắp theo timestamp.
 *
 * Thứ tự là thứ tự tên file tăng dần, và điều đó có ý nghĩa: timestamp trong tên
 * chính là thứ tự áp, nên "sắp xếp" ở đây không phải tiện tay mà là hợp đồng.
 */
export function readReviewedManifest({ git, reviewedSha }) {
  if (!SHA1.test(reviewedSha)) {
    throw new Error(`SHA đã duyệt phải là 40 hex; nhận được ${JSON.stringify(reviewedSha)}.`);
  }
  const names = git.listMigrations(reviewedSha)
    .filter((name) => OPENCLAW_MIGRATION_PATTERN.test(name))
    .sort();
  if (names.length !== OPENCLAW_REVIEWED_COUNT) {
    throw new Error(
      `Cây ${reviewedSha} có ${names.length} file OpenClaw, phải đúng ${OPENCLAW_REVIEWED_COUNT}. ` +
      `Thừa nghĩa là có migration chưa ai đọc qua; thiếu nghĩa là đang áp một bộ khác bộ đã duyệt.`,
    );
  }
  return Object.freeze(names);
}

const PRODUCTION_PROJECT_REF = "tryymsxyyckgbrmmvozx";
const PRODUCTION_ORG = "aaaa0000-0000-4000-8000-000000000001";
const DEMO_ORG = "dddd0000-0000-4000-8000-000000000001";
const SHA1 = /^[0-9a-f]{40}$/u;

/**
 * Câu lệnh phá huỷ. Quét trên SQL đã bỏ chú thích — một dòng ghi chú tiếng Việt
 * có chữ "drop" không phải lý do để chặn cả migration, và chặn nhầm sẽ dạy người
 * ta tắt cổng.
 */
const DESTRUCTIVE = [
  /\bdrop\s+(table|function|view|policy|trigger|schema|type|index|column|constraint)\b/iu,
  /\bdrop\s+column\b/iu,
  /\btruncate\b/iu,
  /\brollback\b/iu,
];

const stripSqlComments = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/--[^\n]*/gu, " ");

/** Ném nếu SQL chứa lệnh phá huỷ. */
export function assertNoDestructiveSql(file, sql) {
  const bare = stripSqlComments(sql);
  for (const pattern of DESTRUCTIVE) {
    const hit = bare.match(pattern);
    if (hit) {
      throw new Error(
        `${file} chứa lệnh phá huỷ "${hit[0].trim()}". Công cụ này chỉ áp thêm; ` +
        `sửa sai phải bằng một migration TIẾN TỚI đã được duyệt.`,
      );
    }
  }
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Băm từng file cộng một băm tổng.
 *
 * Băm tổng ràng CẢ THỨ TỰ: nó băm chuỗi "tên:băm" nối theo đúng trình tự áp,
 * nên đảo chỗ hai file cho ra kết quả khác. Một phép băm chỉ cộng dồn nội dung
 * sẽ không phân biệt được, trong khi thứ tự chính là thứ quyết định migration
 * nào nhìn thấy schema ở trạng thái nào.
 */
export function buildManifest({ git, reviewedSha, order }) {
  if (!SHA1.test(reviewedSha)) {
    throw new Error(`SHA đã duyệt phải là 40 hex; nhận được ${JSON.stringify(reviewedSha)}.`);
  }
  order = order ?? readReviewedManifest({ git, reviewedSha });
  const files = {};
  const parts = [];
  for (const name of order) {
    const body = git.show(reviewedSha, `supabase/migrations/${name}`);
    const hash = sha256(body);
    files[name] = hash;
    parts.push(`${name}:${hash}`);
  }
  return { reviewedSha, files, aggregate: sha256(parts.join("\n")) };
}

/**
 * Cây đã duyệt phải chứa ĐÚNG 12 file openclaw — không thiếu, không thừa.
 *
 * Ca "thừa" nguy hiểm và dễ bỏ sót nhất: schema vẫn chạy được, chỉ là có một
 * migration không ai đọc qua.
 */
export function verifyReviewedTree({ git, reviewedSha, expected }) {
  const present = readReviewedManifest({ git, reviewedSha });
  if (!expected) return { reviewedSha, files: present };

  // Khi người gọi có một danh sách chờ đợi (vd lấy từ lần duyệt trước), đối
  // chiếu tên chứ không chỉ đếm số: cùng 12 file vẫn có thể là 12 file KHÁC.
  // Đây đúng là cách tôi suýt để lọt một bộ sai — số lượng khớp, tên thì không.
  const missing = expected.filter((n) => !present.includes(n));
  const extra = present.filter((n) => !expected.includes(n));
  if (missing.length || extra.length) {
    throw new Error(
      `Cây ${reviewedSha} không khớp danh sách đã duyệt.` +
      (missing.length ? ` Thiếu: ${missing.join(", ")}.` : "") +
      (extra.length ? ` Thừa (chưa duyệt): ${extra.join(", ")}.` : ""),
    );
  }
  return { reviewedSha, files: present };
}

/**
 * Dựng kế hoạch áp. KHÔNG chạy gì — chỉ trả về thứ sẽ chạy, để người vận hành
 * đọc trước khi đồng ý.
 */
export function planApply({
  reviewedSha,
  projectRef,
  confirmProdOrg,
  confirmDemoOrg,
  cleanWorktree,
  appliedRemote = [],
  manifest,
} = {}) {
  if (!Array.isArray(manifest) || manifest.length !== OPENCLAW_REVIEWED_COUNT) {
    throw new Error(
      `Cần truyền manifest ${OPENCLAW_REVIEWED_COUNT} file đọc từ cây đã duyệt ` +
      `(readReviewedManifest); không có danh sách chép tay nào ở đây.`,
    );
  }
  if (!SHA1.test(reviewedSha)) {
    throw new Error(`SHA đã duyệt phải là 40 hex; nhận được ${JSON.stringify(reviewedSha)}.`);
  }
  if (projectRef !== PRODUCTION_PROJECT_REF) {
    throw new Error(
      `project ref phải đúng ${PRODUCTION_PROJECT_REF}; nhận được ${JSON.stringify(projectRef)}.`,
    );
  }
  // Bắt gõ CẢ HAI id tổ chức: nó buộc người chạy phải nhìn thấy mình đang đứng ở
  // project nào, thay vì bấm enter qua một dòng nhắc.
  if (confirmProdOrg !== PRODUCTION_ORG || confirmDemoOrg !== DEMO_ORG) {
    throw new Error("Phải xác nhận đúng cả hai id tổ chức (production và DEMO) trước khi áp.");
  }
  if (cleanWorktree !== true) {
    throw new Error(
      "Cây làm việc phải sạch: áp từ một cây có sửa đổi nghĩa là thứ chạy không phải thứ đã duyệt.",
    );
  }

  // Sổ ở xa có file openclaw lạ ⇒ schema đã đi trước theo cách không ai mô tả
  // được. Dừng, không đoán: áp tiếp lên một schema lạ là cách hỏng dữ liệu êm
  // nhất — không lỗi, chỉ sai.
  const unknown = appliedRemote.filter((n) => !manifest.includes(n));
  if (unknown.length) {
    throw new Error(
      `Sổ migration ở xa có file không nằm trong danh sách đã duyệt: ${unknown.join(", ")}. ` +
      `Schema đã đi trước theo cách chưa được mô tả — dừng lại và điều tra.`,
    );
  }

  const steps = manifest
    .filter((name) => !appliedRemote.includes(name))
    .map((name, index) => ({ order: index + 1, file: name }));

  return {
    reviewedSha,
    projectRef,
    steps,
    // Tuần tự, dừng ở lỗi đầu tiên, không ghi dữ liệu — ba điều này là toàn bộ
    // lý do công cụ tồn tại thay vì một vòng lặp psql.
    parallel: false,
    stopOnFirstFailure: true,
    fixtureWrites: [],
  };
}
