#!/usr/bin/env node
/**
 * Bộ máy rollout production cho OpenClaw Zalo — LÁT CẮT 1: các rào an toàn.
 *
 * File này hiện CHƯA có lệnh nghiệp vụ nào (`--begin-rollout`, `--bind-owner-qr`
 * …). Nó cố ý chỉ chứa phần mà sai thì nguy hiểm nhất, và các lệnh nghiệp vụ ở
 * lát sau sẽ dùng lại đúng những rào này:
 *
 *   - phân loại lệnh đọc / ghi, không lệnh nào ở cả hai nhóm;
 *   - lệnh ghi bắt buộc xác nhận PROD khớp tuyệt đối;
 *   - id lần chạy phải được cấp TRƯỚC, không sinh giữa chừng;
 *   - mọi bằng chứng bị soi trước khi ghi, chặn QR / token / cookie / IMEI /
 *     khoá riêng / nội dung tin nhắn;
 *   - lý do máy đọc dựng từ danh sách cho phép, không từ văn bản thô.
 *
 * Vì sao rào đi trước nghiệp vụ: một lệnh sai còn chạy lại được; một bí mật đã
 * ghi vào file bằng chứng thì không rút lại, và một lệnh mang tiếng "chỉ đọc"
 * mà thật ra ghi sẽ phá đúng thứ nó được gọi để kiểm.
 *
 * KHÔNG tự mở kết nối mạng hay database: mọi client phải được tiêm vào, để bộ
 * test hợp đồng chạy được mà không chạm production.
 */

import { createHash } from "node:crypto";

/** Lệnh thay đổi trạng thái. Mỗi cái đòi xác nhận PROD và id lần chạy cấp trước. */
export const MUTATING_COMMANDS = new Set([
  "create-reviewed-deploy-bundle",
  "begin-rollout",
  "resume-rollout",
  "record-observation",
  "advance-stage",
  "bind-owner-qr",
  "bind-owner-inbound",
  "exercise-stop-switch",
  "manual-send",
  "limited-auto-reply",
  "proactive-schedule",
  "sales-group-schedule",
  "crm-event-to-group",
  "disconnect",
  "pause-and-cleanup",
  "release-stop",
]);

/**
 * Lệnh chỉ đọc. Kế hoạch nói thẳng gate / readiness / lookup không được có tác
 * dụng phụ — một cổng tự thay đổi thứ nó đang đo thì không còn là cổng.
 */
export const READ_ONLY_COMMANDS = new Set([
  "verify-reviewed-deploy-bundle",
  "verify-final-image-reproduction",
  "check-gates",
  "verify-stage-evidence",
  "lookup-canonical-cell",
  "verify-run",
]);

/** Chuỗi xác nhận. So sánh KHỚP TUYỆT ĐỐI ở nơi dùng, không lowercase, không trim. */
const PROD_CONFIRMATION = "PROD";

/** Chế độ hợp lệ của lý do máy đọc. Danh sách cho phép, không phải mẫu tự do. */
const MACHINE_REASON_MODES = new Set([
  "CREATE_BUNDLE", "BEGIN_ROLLOUT", "RESUME_ROLLOUT", "RECORD_OBSERVATION",
  "ADVANCE_STAGE", "BIND_OWNER_QR", "BIND_OWNER_INBOUND", "EXERCISE_STOP_SWITCH",
  "MANUAL_SEND", "LIMITED_AUTO_REPLY", "PROACTIVE_SCHEDULE", "SALES_GROUP_SCHEDULE",
  "CRM_EVENT_TO_GROUP", "DISCONNECT", "PAUSE_AND_CLEANUP", "RELEASE_STOP",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Khoá bị cấm xuất hiện trong bằng chứng, soi theo TÊN KHOÁ chứ không theo giá
 * trị. Lý do: `stage: "WAITING_OWNER_QR"` là giá trị hợp lệ và phải qua được,
 * trong khi `qrPayload` thì không — một phép soi theo giá trị sẽ chặn nhầm cái
 * đầu và bỏ sót cái sau khi payload được mã hoá base64.
 */
const FORBIDDEN_KEYS = [
  { pattern: /qr/iu, label: "dữ liệu QR" },
  { pattern: /token|jwt|bearer|secret|password|apikey|api_key/iu, label: "token hoặc bí mật" },
  { pattern: /cookie/iu, label: "cookie" },
  { pattern: /imei/iu, label: "IMEI" },
  { pattern: /^(message|msg)?_?(body|text|content|caption)$/iu, label: "nội dung tin nhắn" },
  { pattern: /messagebody|messagetext|messagecontent/iu, label: "nội dung tin nhắn" },
];

/** Giá trị mang hình dạng bí mật, kể cả khi tên khoá vô hại. */
const FORBIDDEN_VALUES = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u, label: "khoá riêng" },
  { pattern: /\bsbp_[A-Za-z0-9]{20,}\b/u, label: "PAT Supabase" },
  { pattern: /\bsk-[A-Za-z0-9-]{20,}\b/u, label: "API key" },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u, label: "JWT" },
  { pattern: /^\d{15}$/u, label: "IMEI" },
];

/** Trả về "mutating" | "read-only"; ném nếu lệnh không có trong danh sách. */
export function classifyCommand(command) {
  if (MUTATING_COMMANDS.has(command)) return "mutating";
  if (READ_ONLY_COMMANDS.has(command)) return "read-only";
  throw new Error(`Lệnh "${command}" không nằm trong danh sách lệnh được phép.`);
}

/**
 * Kiểm mọi điều kiện tiên quyết của một lệnh trước khi nó chạm bất cứ thứ gì.
 * Ném ngay lỗi đầu tiên — kế hoạch cấm chạy tiếp sau một cổng hỏng.
 */
export function resolveCommand({ command, confirm, runId } = {}) {
  const kind = classifyCommand(command);
  if (kind === "read-only") return { command, kind };

  // Khớp tuyệt đối: "prod", "PROD ", "PRODUCTION" đều là thứ người ta gõ nhầm
  // rồi vẫn chạy nếu kiểm bằng contains hoặc lowercase.
  if (confirm !== PROD_CONFIRMATION) {
    throw new Error(
      `Lệnh "${command}" thay đổi production nên bắt buộc xác nhận PROD khớp tuyệt đối.`,
    );
  }
  if (typeof runId !== "string" || !UUID.test(runId)) {
    throw new Error(
      `Lệnh "${command}" cần runId là UUID được cấp TRƯỚC; nhận được ${JSON.stringify(runId)}.`,
    );
  }
  return { command, kind, runId };
}

/**
 * Soi bằng chứng trước khi ghi. Trả lại chính đối tượng nếu sạch, ném nếu không.
 *
 * Trả lại nguyên vẹn thay vì bản đã che: một bản che đi đồng nghĩa với "đã có bí
 * mật ở đây và tôi tự xử lý", còn ném thì buộc người viết lệnh sửa chỗ họ thu
 * thập dữ liệu. Bí mật không nên đi xa tới mức cần che.
 */
export function redactEvidence(evidence) {
  const walk = (node, path) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        for (const { pattern, label } of FORBIDDEN_KEYS) {
          if (pattern.test(key)) {
            throw new Error(`Bằng chứng chứa ${label} tại ${path}${path ? "." : ""}${key}.`);
          }
        }
        walk(value, `${path}${path ? "." : ""}${key}`);
      }
      return;
    }
    const text = String(node);
    for (const { pattern, label } of FORBIDDEN_VALUES) {
      if (pattern.test(text)) throw new Error(`Bằng chứng chứa ${label} tại ${path}.`);
    }
  };
  walk(evidence, "");
  return evidence;
}

/**
 * Lý do máy đọc, dựng từ danh sách cho phép.
 *
 * Kế hoạch cấm để văn bản thô của caller hay của provider trở thành bằng chứng.
 * Chặn ở đây chứ không lọc về sau, vì lọc về sau nghĩa là đã ghi rồi mới xoá.
 */
export function buildMachineReason(mode, runId) {
  if (!MACHINE_REASON_MODES.has(mode)) {
    throw new Error(`Chế độ "${mode}" không nằm trong danh sách lý do được phép.`);
  }
  if (typeof runId !== "string" || !UUID.test(runId)) {
    throw new Error(`Lý do máy đọc cần runId là UUID; nhận được ${JSON.stringify(runId)}.`);
  }
  return `production-smoke:${mode}:${runId}`;
}

/**
 * Bản song sinh JS của `app_private.openclaw_rollout_manifest_hash_v1`.
 *
 * VÌ SAO PHẢI CÓ: --begin-rollout tính hash phía client rồi ghi vào cột
 * `migration_manifest_sha256`, mà guard kích hoạt sẽ tính LẠI bằng hàm DB và so.
 * Lệch một byte thì dòng vừa ghi bị chính guard từ chối, và người vận hành nhận
 * một lỗi 42501 không nói được vì sao. Tính trước phía client để biết TRƯỚC KHI
 * ghi, thay vì phát hiện lúc đã có một dòng hỏng nằm trong bảng.
 *
 * Thuật toán đọc thẳng từ thân hàm DB (đo trên harness schema production):
 *   sha256( "ihome-openclaw-migration-manifest-v1" ‖ 0x00 ‖ Σ "tên:digest\n" )
 * theo ĐÚNG thứ tự 12 file, và CHỈ 12 file đó — các khoá khác trong
 * artifact_digests (cellImageDigest, cellConfigDigest, cellReviewedCommitSha)
 * không vào tiền ảnh.
 */
export function computeMigrationManifestHash(artifactDigests, order) {
  if (!Array.isArray(order) || order.length === 0) {
    throw new Error("Cần truyền thứ tự 12 file migration đã duyệt.");
  }
  let preimage = "";
  for (const name of order) {
    const digest = artifactDigests?.[name];
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
      throw new Error(
        `artifact_digests thiếu hoặc sai khuôn digest cho ${name}: ${JSON.stringify(digest)}.`,
      );
    }
    preimage += `${name}:${digest}\n`;
  }
  return createHash("sha256")
    .update(Buffer.concat([
      Buffer.from("ihome-openclaw-migration-manifest-v1", "utf8"),
      Buffer.from([0x00]),
      Buffer.from(preimage, "utf8"),
    ]))
    .digest("hex");
}

const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/**
 * Dựng dòng `public.openclaw_rollout_runs` — và kiểm mọi thứ TRƯỚC khi ghi.
 *
 * Dòng này là lời khẳng định "có một cell đang chạy đúng ảnh đã duyệt". Guard
 * kích hoạt đọc nó để quyết định có cho bật OpenClaw hay không. Một dòng sai nằm
 * trong bảng là một lời nói dối mà hệ thống sẽ tin — và không có nút hoàn tác.
 *
 * KHÔNG nhận `migration_manifest_sha256` từ người gọi: hàm tự tính. Nhận từ tham
 * số nghĩa là tin người gọi đã tính đúng, mà người gọi chính là chỗ dễ sai nhất.
 *
 * Trả về dòng, KHÔNG ghi. Việc ghi để tầng gọi làm, sau khi người vận hành đã
 * đọc dòng này.
 */
export function buildRolloutRunRow({
  organizationId,
  reviewedCommitSha,
  migrationOrder,
  migrationDigests,
  cellImageDigest,
  cellConfigDigest,
  upstreamSri,
  upstreamGitHead,
  patchSeriesSha256,
  builtTgzSha256,
} = {}) {
  if (typeof organizationId !== "string" || !organizationId) {
    throw new Error("Thiếu organizationId.");
  }
  if (!HEX40.test(reviewedCommitSha ?? "")) {
    throw new Error(`reviewed sha phải là 40 hex; nhận ${JSON.stringify(reviewedCommitSha)}.`);
  }
  // Khuôn digest ảnh và digest cấu hình KHÁC NHAU, và guard kiểm riêng từng cái
  // (`^sha256:[0-9a-f]{64}$` vs `^[0-9a-f]{64}$`). Nhầm chỗ là dòng ghi ra bị
  // guard từ chối ở lần kích hoạt đầu tiên, tức lúc muộn nhất có thể.
  if (!IMAGE_DIGEST.test(cellImageDigest ?? "")) {
    throw new Error(
      `cell image digest phải theo khuôn sha256:<64 hex>; nhận ${JSON.stringify(cellImageDigest)}.`,
    );
  }
  if (!HEX64.test(cellConfigDigest ?? "")) {
    throw new Error(
      `cell config digest phải là 64 hex KHÔNG có tiền tố; nhận ${JSON.stringify(cellConfigDigest)}.`,
    );
  }
  if (!HEX40.test(upstreamGitHead ?? "")) {
    throw new Error(`upstream git head phải là 40 hex; nhận ${JSON.stringify(upstreamGitHead)}.`);
  }
  if (!HEX64.test(patchSeriesSha256 ?? "")) {
    throw new Error(`patch series sha256 phải là 64 hex; nhận ${JSON.stringify(patchSeriesSha256)}.`);
  }
  if (!HEX64.test(builtTgzSha256 ?? "")) {
    throw new Error(`built tgz sha256 phải là 64 hex; nhận ${JSON.stringify(builtTgzSha256)}.`);
  }
  if (typeof upstreamSri !== "string" || !upstreamSri.startsWith("sha512-")) {
    throw new Error(`upstream SRI phải bắt đầu bằng "sha512-"; nhận ${JSON.stringify(upstreamSri)}.`);
  }

  // cellReviewedCommitSha PHẢI trùng reviewed_commit_sha — guard kiểm đúng điều
  // này. Lệch nhau nghĩa là dòng mô tả một ảnh dựng từ commit khác commit đã
  // duyệt, và không ai đọc được sự lệch đó bằng mắt.
  const artifactDigests = {
    ...migrationDigests,
    cellReviewedCommitSha: reviewedCommitSha,
    cellImageDigest,
    cellConfigDigest,
  };

  return {
    organization_id: organizationId,
    reviewed_commit_sha: reviewedCommitSha,
    migration_manifest_sha256: computeMigrationManifestHash(migrationDigests, migrationOrder),
    upstream_sri: upstreamSri,
    upstream_git_head: upstreamGitHead,
    patch_series_sha256: patchSeriesSha256,
    built_tgz_sha256: builtTgzSha256,
    artifact_digests: artifactDigests,
    // Bắt đầu ở FOUNDATION chứ không nhảy thẳng: mỗi bước tiến là một lần người
    // vận hành phải nhìn vào cổng, và bỏ bước đầu là bỏ luôn thói quen đó.
    stage: "FOUNDATION",
    stage_version: 1,
    status: "RUNNING",
    completed_at: null,
  };
}
