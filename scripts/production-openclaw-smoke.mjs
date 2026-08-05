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
  // "token" TRẦN thì quá rộng: `fencing_token` là bộ đếm đơn điệu dùng để loại
  // writer cũ, schema lưu ở dạng thường, và chặn nó sẽ khiến chuỗi dựng cell
  // không ghi nổi bằng chứng nào. Chỉ chặn tên mang hình dạng CHỨNG CHỈ.
  // Bắt được nhờ viết một bài dùng thật thay vì chỉ bài chặn.
  {
    pattern: /(access|refresh|id|api|auth|bearer|session)_?token|^tokens?$|jwt|bearer|secret|password|apikey|api_key/iu,
    label: "token hoặc bí mật",
  },
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

/**
 * Scope hợp lệ của credential runtime.
 *
 * Đây là bản sao danh sách trong CHECK constraint của
 * `public.openclaw_runtime_credentials`. Chặn ở đây để thông điệp lỗi nói được
 * VÌ SAO — tầng DB chỉ trả một lỗi check constraint không gợi ý giá trị nào hợp
 * lệ. Tôi từng gõ "runtime.read" cho có và mất một vòng vì thế.
 *
 * Danh sách phải ĐÚNG BẰNG schema, không hẹp hơn: hẹp hơn nghĩa là công cụ tự
 * cấm thứ hệ thống cho phép, và người ta sẽ đi vòng qua công cụ.
 */
export const RUNTIME_CREDENTIAL_SCOPES = Object.freeze([
  "heartbeat", "qr.publish", "qr.result", "inbound.commit",
  "outbox.claim", "outbox.preflight", "outbox.authorize-send", "outbox.requeue",
  "outbox.complete", "work.claim", "work.context", "work.complete",
  "media.issue", "lease.acquire", "cell.rebind", "generation.ack",
  "credential.exchange", "runtime.sweep",
]);

/**
 * Chuỗi dựng cell đầu tiên cho một tổ chức.
 *
 * THỨ TỰ LÀ HỢP ĐỒNG, không phải sở thích. Đo trên PostgreSQL 17.6 nạp schema
 * production: guard kích hoạt chỉ coi là "kích hoạt" khi cell ở `state='READY'`,
 * nên phải dựng đủ account → cell PROVISIONING → credential → lease rồi MỚI lật
 * READY. Chèn thẳng cell READY sẽ trúng
 * `current artifact cell credential lease fence matrix is incomplete`, và thông
 * điệp đó không hề gợi ý rằng nguyên nhân là thứ tự.
 *
 * Một phân tích tĩnh dài từng kết luận đây là bế tắc không gỡ được. Phép đo bác
 * nó — chuỗi này chạy thông, không cần tắt trigger.
 *
 * Trả về danh sách bước, KHÔNG chạy. Người vận hành đọc trước khi đồng ý.
 */
export function buildCellBootstrap({
  organizationId,
  accountId,
  cellId,
  reviewedCommitSha,
  cellImageDigest,
  cellConfigDigest,
  credentialHash,
  allowedScopes,
  leaseExpiresAt,
} = {}) {
  for (const [name, value] of Object.entries({ organizationId, accountId, cellId })) {
    if (typeof value !== "string" || !value) throw new Error(`Thiếu ${name}.`);
  }
  if (!HEX40.test(reviewedCommitSha ?? "")) {
    throw new Error(`reviewed sha phải là 40 hex; nhận ${JSON.stringify(reviewedCommitSha)}.`);
  }
  if (!IMAGE_DIGEST.test(cellImageDigest ?? "")) {
    throw new Error(`cell image digest phải theo khuôn sha256:<64 hex>.`);
  }
  if (!HEX64.test(cellConfigDigest ?? "")) {
    throw new Error(`cell config digest phải là 64 hex KHÔNG có tiền tố.`);
  }
  if (!HEX64.test(credentialHash ?? "")) {
    throw new Error(`credential hash phải là 64 hex.`);
  }
  if (!Array.isArray(allowedScopes) || allowedScopes.length === 0) {
    throw new Error("Cần ít nhất một scope cho credential.");
  }
  const unknownScopes = allowedScopes.filter((s) => !RUNTIME_CREDENTIAL_SCOPES.includes(s));
  if (unknownScopes.length) {
    throw new Error(
      `scope không hợp lệ: ${unknownScopes.join(", ")}. ` +
      `Hợp lệ: ${RUNTIME_CREDENTIAL_SCOPES.join(", ")}.`,
    );
  }
  if (typeof leaseExpiresAt !== "string" || Number.isNaN(Date.parse(leaseExpiresAt))) {
    throw new Error(`leaseExpiresAt phải là mốc thời gian ISO; nhận ${JSON.stringify(leaseExpiresAt)}.`);
  }

  return [
    {
      operation: "insert",
      table: "public.openclaw_accounts",
      values: { id: accountId, organization_id: organizationId },
    },
    {
      // PROVISIONING, không phải READY. Xem chú thích đầu hàm.
      operation: "insert",
      table: "public.openclaw_runtime_cells",
      values: {
        id: cellId,
        organization_id: organizationId,
        account_id: accountId,
        cell_generation: 1,
        state: "PROVISIONING",
        is_current: true,
        reviewed_commit_sha: reviewedCommitSha,
        image_digest: cellImageDigest,
        config_digest: cellConfigDigest,
      },
    },
    {
      operation: "insert",
      table: "public.openclaw_runtime_credentials",
      values: {
        organization_id: organizationId,
        account_id: accountId,
        cell_id: cellId,
        credential_generation: 1,
        credential_hash: credentialHash,
        allowed_scopes: allowedScopes,
      },
    },
    {
      operation: "insert",
      table: "public.openclaw_runtime_leases",
      values: {
        organization_id: organizationId,
        account_id: accountId,
        cell_id: cellId,
        lease_generation: 1,
        fencing_token: 1,
        expires_at: leaseExpiresAt,
      },
    },
    {
      // Bước CUỐI. Ràng theo cả id lẫn organization_id: một UPDATE thiếu WHERE ở
      // bảng này sẽ lật MỌI cell của MỌI tổ chức sang READY cùng lúc.
      operation: "update",
      table: "public.openclaw_runtime_cells",
      where: { id: cellId, organization_id: organizationId },
      values: { state: "READY" },
    },
  ];
}

/**
 * 11 giai đoạn rollout, ĐÚNG thứ tự của CHECK constraint trên cột `stage`.
 *
 * Lệch một chỗ là công cụ cho phép một bước mà DB chặn, hoặc chặn một bước mà DB
 * cho phép — cả hai đều làm người vận hành mất niềm tin vào công cụ đúng lúc họ
 * cần nó nhất.
 */
export const ROLLOUT_STAGES = Object.freeze([
  "FOUNDATION", "INFRASTRUCTURE", "WAITING_OWNER_QR", "CONNECTION", "SHADOW",
  "WAITING_OWNER_INBOUND", "LIMITED_OBSERVING", "LIMITED_VERIFIED",
  "PROACTIVE", "SALES_GROUPS", "COMPLETE",
]);

/**
 * Dựng bước tiến một giai đoạn, có CAS.
 *
 * Luật ĐO trên PostgreSQL 17.6 nạp schema production (không đọc mã rồi đoán):
 *   tiến đúng MỘT bước + stage_version đúng +1 -> qua
 *   lùi / nhảy cóc / version sai               -> "invalid rollout stage transition"
 *   đứng yên chỉ tăng version                  -> "stage_version cannot change
 *                                                 without a stage transition"
 *
 * CAS gồm CẢ version cũ LẪN status: thiếu version thì hai tiến trình cùng tiến
 * một bước và không ai biết; thiếu status thì tiến được cả một run đã PAUSED,
 * tức đi tiếp một cuộc rollout mà ai đó vừa cố ý dừng.
 */
export function buildStageAdvance({ runId, from, to, expectedVersion } = {}) {
  if (typeof runId !== "string" || !UUID.test(runId)) {
    throw new Error(`runId phải là UUID; nhận ${JSON.stringify(runId)}.`);
  }
  const fromIndex = ROLLOUT_STAGES.indexOf(from);
  const toIndex = ROLLOUT_STAGES.indexOf(to);
  if (fromIndex < 0) throw new Error(`giai đoạn nguồn không có thật: ${JSON.stringify(from)}.`);
  if (toIndex < 0) throw new Error(`giai đoạn đích không có thật: ${JSON.stringify(to)}.`);
  if (toIndex !== fromIndex + 1) {
    throw new Error(
      `chỉ tiến được sang giai đoạn LIỀN SAU: ${from} -> ${ROLLOUT_STAGES[fromIndex + 1] ?? "(hết)"}, ` +
      `không phải ${to}. Lùi hay nhảy cóc đều bị DB chặn.`,
    );
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error(`expectedVersion phải là số nguyên dương; nhận ${JSON.stringify(expectedVersion)}.`);
  }

  return {
    operation: "update",
    table: "public.openclaw_rollout_runs",
    where: { id: runId, stage: from, stage_version: expectedVersion, status: "RUNNING" },
    values: { stage: to, stage_version: expectedVersion + 1 },
  };
}

/**
 * `SOURCE_DATE_EPOCH` mà kế hoạch ghim cho ảnh cell.
 * Giá trị khác nghĩa là ảnh dựng bằng một mốc thời gian khác, và mọi so sánh
 * byte-với-byte về sau đều vô nghĩa.
 */
const PINNED_SOURCE_DATE_EPOCH = 1785062400;

/**
 * Đọc `build-evidence.json` của cell và rút ra đúng những gì rollout cần.
 *
 * VÌ SAO CẦN HÀM RIÊNG: bằng chứng mang HAI sha rất dễ dùng nhầm —
 *   `supply_chain.git_binding.expected_m` = checkpoint M, một TỔ TIÊN
 *   `supply_chain.git_binding.reviewed_r` = R, chính cây mà ảnh được dựng từ đó
 *
 * Tôi đã điền nhầm `expected_m` vào `reviewed_commit_sha` trong một phép thử và
 * guard VẪN QUA — vì guard chỉ kiểm `artifact_digests.cellReviewedCommitSha`
 * khớp `reviewed_commit_sha`, tức khớp NHAU, chứ không kiểm cái nào đúng. Dòng
 * ghi ra sẽ khai sai nguồn gốc ảnh và không gì báo. Đây là loại sai tệ nhất:
 * mọi cổng đều xanh, chỉ có sự thật là sai.
 */
export function readCellBuildEvidence(evidence) {
  const binding = evidence?.supply_chain?.git_binding;
  const oci = evidence?.oci;
  if (!binding || !oci) {
    throw new Error("Bằng chứng thiếu supply_chain.git_binding hoặc oci.");
  }
  if (!HEX40.test(binding.reviewed_r ?? "")) {
    throw new Error(`reviewed_r phải là 40 hex; nhận ${JSON.stringify(binding.reviewed_r)}.`);
  }
  if (!HEX40.test(binding.expected_m ?? "")) {
    throw new Error(`expected_m phải là 40 hex; nhận ${JSON.stringify(binding.expected_m)}.`);
  }
  if (binding.m_ancestor_of_r !== true) {
    throw new Error(
      "M phải là tổ tiên của R. Không phải vậy nghĩa là chuỗi duyệt bị đứt ở đâu đó.",
    );
  }
  if (!IMAGE_DIGEST.test(evidence.image_digest ?? "")) {
    throw new Error(`image digest phải theo khuôn sha256:<64 hex>.`);
  }
  // File thật lưu giá trị này dưới dạng CHUỖI ("1785062400"), không phải số.
  // Bản đầu tiên của hàm so bằng `!==` với số và từ chối chính bằng chứng thật —
  // tôi bịa hình dạng dữ liệu trong mock thay vì đọc file. Nhận cả hai dạng,
  // nhưng so theo GIÁ TRỊ SỐ và chỉ chấp nhận string/number, để "1785062400abc"
  // hay `true` không lọt qua một phép ép kiểu lỏng.
  const epochRaw = evidence.source_date_epoch;
  const epochOk = (typeof epochRaw === "number" || typeof epochRaw === "string")
    && Number(epochRaw) === PINNED_SOURCE_DATE_EPOCH
    && String(epochRaw).trim() !== "";
  if (!epochOk) {
    throw new Error(
      `source_date_epoch phải đúng ${PINNED_SOURCE_DATE_EPOCH}; nhận ` +
      `${JSON.stringify(epochRaw)}. Mốc khác thì mọi so sánh byte-với-byte về ` +
      `sau đều vô nghĩa.`,
    );
  }

  // Toàn bộ giá trị của "build tái lập được" nằm ở chỗ hai lần dựng ĐỘC LẬP ra
  // cùng một byte. Mất điều đó thì digest chỉ còn là dấu vân tay của một lần
  // dựng may mắn.
  if (oci.archive_a_sha256 !== oci.archive_b_sha256 || oci.byte_identical !== true) {
    throw new Error(
      "Hai lần dựng không cho ra byte giống nhau — build không tái lập được, " +
      "digest chỉ là dấu vân tay của một lần dựng.",
    );
  }
  const promotedSource = oci.promoted_archive_role === "B"
    ? oci.archive_b_sha256
    : oci.archive_a_sha256;
  if (oci.promoted_archive_sha256 !== promotedSource) {
    throw new Error(
      `hash archive được thăng cấp không khớp vai trò ${JSON.stringify(oci.promoted_archive_role)} ` +
      `— bundle sẽ mang bytes của một archive khác cái đã kiểm.`,
    );
  }

  return {
    reviewedCommitSha: binding.reviewed_r,
    checkpointMSha: binding.expected_m,
    imageDigest: evidence.image_digest,
    promotedArchiveSha256: oci.promoted_archive_sha256,
    sourceDateEpoch: evidence.source_date_epoch,
  };
}

const TAR_BLOCK = 512;

/**
 * Chặn đường dẫn nguy hiểm trong tar.
 *
 * Bundle này được GIẢI NÉN BẰNG QUYỀN PROVISIONING trên VPS. Một entry
 * `../../etc/passwd` là lỗ hổng giải nén cổ điển, và ở đây nó ghi được vào chỗ
 * mà người vận hành không hề nhìn tới.
 */
function assertSafeTarPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 100) {
    throw new Error(`đường dẫn trong bundle không hợp lệ: ${JSON.stringify(path)}.`);
  }
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.includes("\\")) {
    throw new Error(`đường dẫn trong bundle phải TƯƠNG ĐỐI: ${JSON.stringify(path)}.`);
  }
  if (path.split("/").includes("..")) {
    throw new Error(`đường dẫn trong bundle không được đi ngược lên: ${JSON.stringify(path)}.`);
  }
}

const octal = (value, width) => value.toString(8).padStart(width - 1, "0") + "\0";

/**
 * Ghi tar ustar TẤT ĐỊNH.
 *
 * Cùng đầu vào phải ra cùng byte, trên mọi máy, mọi thời điểm. Nếu không thì
 * "so digest với bản đã duyệt" mất hết ý nghĩa: mỗi lần dựng ra một file khác,
 * và không ai phân biệt được "khác vì tôi vừa sửa" với "khác vì ai đó chèn thứ
 * gì vào".
 *
 * Vì thế: entry được SẮP theo đường dẫn (thứ tự đầu vào không lọt vào output),
 * mtime ghim ở SOURCE_DATE_EPOCH, uid/gid = 0 và uname/gname rỗng (bundle không
 * mang danh tính người dựng — vừa không tái lập được trên máy khác, vừa là một
 * rò rỉ nhỏ không cần thiết).
 */
export function writeDeterministicTar(entries) {
  if (!Array.isArray(entries)) throw new Error("entries phải là mảng.");
  const seen = new Set();
  for (const entry of entries) {
    assertSafeTarPath(entry?.path);
    if (seen.has(entry.path)) {
      throw new Error(
        `đường dẫn trùng trong bundle: ${entry.path}. Cái sau sẽ đè cái trước lúc ` +
        `giải nén, và bản kê không còn mô tả đúng thứ nằm trên đĩa.`,
      );
    }
    seen.add(entry.path);
  }

  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const blocks = [];
  for (const { path, bytes } of sorted) {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "");
    const header = Buffer.alloc(TAR_BLOCK, 0);
    header.write(path, 0, 100, "utf8");
    header.write(octal(0o644, 8), 100, 8, "ascii");   // mode
    header.write(octal(0, 8), 108, 8, "ascii");       // uid
    header.write(octal(0, 8), 116, 8, "ascii");       // gid
    header.write(octal(data.length, 12), 124, 12, "ascii");
    header.write(octal(PINNED_SOURCE_DATE_EPOCH, 12), 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii");        // checksum: khoảng trắng khi tính
    header.write("0", 156, 1, "ascii");               // typeflag: file thường
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    // uname/gname để RỖNG có chủ ý — xem chú thích đầu hàm.
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(octal(sum, 8).slice(0, 7) + "\0", 148, 8, "ascii");

    blocks.push(header, data);
    const pad = (TAR_BLOCK - (data.length % TAR_BLOCK)) % TAR_BLOCK;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  // Hai block rỗng kết thúc, theo chuẩn.
  blocks.push(Buffer.alloc(TAR_BLOCK * 2, 0));
  return Buffer.concat(blocks);
}

/** Đọc lại tar do writeDeterministicTar ghi. Dùng để KIỂM chính file đã dựng. */
export function readTar(buffer) {
  const out = [];
  let offset = 0;
  while (offset + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK);
    if (header.every((b) => b === 0)) break;
    const str = (start, len) =>
      header.subarray(start, start + len).toString("utf8").replace(/\0.*$/u, "").trim();
    const oct = (start, len) => parseInt(str(start, len) || "0", 8);
    const path = str(0, 100);
    const size = oct(124, 12);
    const dataStart = offset + TAR_BLOCK;
    out.push({
      path,
      bytes: buffer.subarray(dataStart, dataStart + size),
      mtime: oct(136, 12),
      uid: oct(108, 8),
      gid: oct(116, 8),
      uname: str(265, 32),
      gname: str(297, 32),
    });
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return out;
}

/**
 * Bản kê chuyển giao, nhúng TRONG bundle.
 *
 * KHÔNG chứa `bundle_sha256`: đó là băm của chính file chứa bản kê này. Nhét vào
 * trong thì nội dung đổi, băm đổi theo, và không bao giờ hội tụ. `bundle_sha256`
 * phải sống NGOÀI tar, cạnh nó.
 */
export function buildTransferManifest({ evidence, files }) {
  if (!evidence?.reviewedCommitSha || !evidence?.imageDigest) {
    throw new Error("Bản kê cần bằng chứng đã đọc qua readCellBuildEvidence().");
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Bản kê cần ít nhất một file.");
  }
  return {
    version: 1,
    // reviewed_r, KHÔNG phải checkpoint M — xem readCellBuildEvidence().
    reviewedCommitSha: evidence.reviewedCommitSha,
    imageDigest: evidence.imageDigest,
    promotedArchiveSha256: evidence.promotedArchiveSha256,
    sourceDateEpoch: PINNED_SOURCE_DATE_EPOCH,
    files: [...files]
      .map(({ path, bytes }) => ({
        path,
        sha256: createHash("sha256").update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "")).digest("hex"),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

/**
 * Phân tích tham số dòng lệnh.
 *
 * CLI là chỗ người vận hành gõ tay lúc 2 giờ sáng, nên hàm này cố ý KHÔNG đoán
 * ý: tham số trần bị từ chối (thay vì đoán nó là tên lệnh), và cờ lặp lại bị từ
 * chối (thay vì lặng lẽ lấy cái cuối — người gõ nhầm hai lần `--confirm` sẽ tin
 * rằng cái đầu đã có hiệu lực).
 */
export function parseCliArgs(argv) {
  const out = {};
  const camel = (k) => k.replace(/-([a-z])/gu, (_, c) => c.toUpperCase());
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(
        `tham số trần không được chấp nhận: ${JSON.stringify(token)}. ` +
        `Mọi thứ phải đi kèm tên cờ, vd --command begin-rollout.`,
      );
    }
    const eq = token.indexOf("=");
    const rawKey = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    const key = camel(rawKey);
    if (Object.hasOwn(out, key)) {
      throw new Error(`cờ --${rawKey} bị lặp. Gõ hai lần thì lần nào có hiệu lực?`);
    }
    if (eq >= 0) {
      out[key] = token.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[key] = argv[i + 1];
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/**
 * Điều phối một lệnh: phân tích cờ, qua rào an toàn, dựng kế hoạch — và DỪNG.
 *
 * LẰN RANH CỦA CÔNG CỤ NÀY: nó DỰNG và KIỂM, người vận hành mới là người bấm.
 * `executed` luôn là false. Một công cụ tự chạy lệnh ghi lên production khi được
 * gọi đúng cờ là một công cụ chỉ cần gõ nhầm một lần — và production không có
 * nút hoàn tác.
 *
 * Mọi phụ thuộc đọc file / DB đều TIÊM VÀO qua `deps`.
 */
export function runCommand({ argv = [], deps = {} } = {}) {
  const args = parseCliArgs(argv);
  if (typeof args.command !== "string") {
    throw new Error("thiếu --command. Xem docs/openclaw-zalo/runbooks/rollout-engine.md.");
  }

  const resolved = resolveCommand({
    command: args.command,
    confirm: args.confirm,
    runId: args.runId,
  });

  let plan;
  if (args.command === "begin-rollout") {
    // Đọc bằng chứng để lấy reviewed_r — KHÔNG nhận sha từ dòng lệnh. Người gõ
    // tay chính là chỗ nhầm checkpoint M với R, và guard không bắt được cái nhầm
    // đó vì nó chỉ kiểm hai trường khớp nhau.
    const evidence = readCellBuildEvidence(deps.readEvidence?.());
    plan = {
      reviewedCommitSha: evidence.reviewedCommitSha,
      imageDigest: evidence.imageDigest,
      note: "Chưa ghi gì. Xem kế hoạch rồi chạy bước ghi thủ công.",
    };
  }

  // deps.extraPlan tồn tại ĐỂ ĐO: nó cho bộ test bơm một giá trị hình-dạng-bí-mật
  // qua đúng đường mà kế hoạch thật đi qua, nhờ đó bài test chứng minh được bộ
  // lọc ĐANG được gọi ở đây — chứ không phải chỉ chứng minh bộ lọc tồn tại.
  return redactEvidence({
    ...(deps.extraPlan ? { extra: deps.extraPlan } : {}),
    command: resolved.command,
    kind: resolved.kind,
    runId: resolved.runId ?? null,
    executed: false,
    ...(plan ? { plan } : {}),
  });
}
