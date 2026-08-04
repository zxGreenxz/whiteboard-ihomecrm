/**
 * Compares two dedicated-host baselines captured by `snapshot-host-baseline.sh`.
 *
 * A recovery drill is only evidence if something checks that the host came back
 * the way it went in. Reading two JSON files side by side is not that check: a
 * container that was recreated has a new Id and an identical Image, and the eye
 * slides straight past it.
 *
 * This module is pure. It performs no SSH, opens no socket, and touches no
 * service - it is handed two documents and returns findings. That is what lets it
 * be tested against a redacted fixture instead of against the live host.
 */

/** Host the OpenClaw cell must never carry credentials for. */
export const FORBIDDEN_HOST_MARKERS = Object.freeze([
  "158.247.243.79",
  "sk-9router",
  "sk-9",
]);

/** Bearer/API-key shapes that must never reach a checked-in baseline. */
const CREDENTIAL_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._\-]{8,}/u,
  /\bsk-[A-Za-z0-9._-]{8,}/u,
  /\bsbp_[0-9a-f]{20,}/u,
  /\beyJ[A-Za-z0-9._-]{20,}/u,
]);

export const FINDING = Object.freeze({
  SCHEMA: "SCHEMA_MISMATCH",
  CELL: "CELL_IDENTITY_CHANGED",
  CONTAINER_SET: "CONTAINER_SET_CHANGED",
  CONTAINER_ID: "CONTAINER_ID_CHANGED",
  IMAGE: "IMAGE_CHANGED",
  NETWORK: "NETWORK_CHANGED",
  MOUNT: "MOUNT_CHANGED",
  RESTART: "RESTART_COUNT_INCREASED",
  PORTS: "PORTS_CHANGED",
  SYSTEMD: "SYSTEMD_STATE_CHANGED",
  ROOT_DISK: "ROOT_DISK_REGRESSED",
  SLO_EVIDENCE: "MODEL_SLO_EVIDENCE_MISSING",
  CREDENTIAL: "CREDENTIAL_IN_BASELINE",
});

/** Free kibibytes on the root filesystem, from `df -Pk` text. */
export function rootFreeKib(dfText) {
  if (typeof dfText !== "string") return null;
  const lines = dfText.trim().split(/\r?\n/u);
  if (lines.length < 2) return null;
  // df -Pk guarantees a single data line per filesystem, columns:
  // Filesystem 1024-blocks Used Available Capacity Mounted-on
  const columns = lines[lines.length - 1].trim().split(/\s+/u);
  const available = Number(columns[3]);
  return Number.isFinite(available) ? available : null;
}

function containersById(baseline) {
  const map = new Map();
  for (const container of baseline?.containers ?? []) {
    // Keyed by image + mount shape rather than by Id: the Id is exactly what a
    // recreated container changes, so keying on it would file every recreation as
    // "one container vanished, another appeared" and lose the comparison.
    map.set(`${container.Image}`, container);
  }
  return map;
}

function scanForCredentials(baseline, label, findings) {
  const text = JSON.stringify(baseline ?? null);
  for (const marker of FORBIDDEN_HOST_MARKERS) {
    if (text.includes(marker)) {
      findings.push({
        kind: FINDING.CREDENTIAL,
        detail: `${label} nhắc tới host bị cấm hoặc khoá của nó: ${marker}`,
      });
    }
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    const hit = pattern.exec(text);
    if (hit !== null) {
      // The matched text is NOT echoed: a finding that quotes the secret has
      // published it into every log that reads the finding.
      findings.push({
        kind: FINDING.CREDENTIAL,
        detail: `${label} chứa chuỗi hình dạng bí mật (${pattern.source.slice(0, 12)}…) — baseline không được mang credential`,
      });
    }
  }
}

/**
 * @param {object} before baseline captured before the drill
 * @param {object} after baseline captured after the drill
 * @param {{ rootDiskToleranceKib?: number }} [options]
 * @returns {{ findings: {kind: string, detail: string}[], clean: boolean }}
 */
export function compareHostBaselines(before, after, options = {}) {
  const findings = [];
  // Default 1 GiB: a drill writes logs and temp media, so byte equality would be
  // noise. A regression larger than this is the drill leaving something behind.
  const tolerance = options.rootDiskToleranceKib ?? 1024 * 1024;

  for (const [label, baseline] of [["baseline trước", before], ["baseline sau", after]]) {
    if (baseline?.schema !== 1) {
      findings.push({ kind: FINDING.SCHEMA, detail: `${label} không phải schema 1` });
    }
    scanForCredentials(baseline, label, findings);
  }
  if (findings.some(finding => finding.kind === FINDING.SCHEMA)) {
    return { findings, clean: false };
  }

  if (before.cell_id !== after.cell_id || before.project !== after.project) {
    findings.push({
      kind: FINDING.CELL,
      detail: `cell/project đổi: ${before.cell_id}/${before.project} -> ${after.cell_id}/${after.project}`,
    });
  }

  const beforeByImage = containersById(before);
  const afterByImage = containersById(after);
  if (beforeByImage.size !== afterByImage.size) {
    findings.push({
      kind: FINDING.CONTAINER_SET,
      detail: `số container đổi: ${beforeByImage.size} -> ${afterByImage.size}`,
    });
  }

  for (const [image, previous] of beforeByImage) {
    const current = afterByImage.get(image);
    if (current === undefined) {
      findings.push({ kind: FINDING.IMAGE, detail: `mất container cho image ${image}` });
      continue;
    }
    if (previous.Id !== current.Id) {
      findings.push({
        kind: FINDING.CONTAINER_ID,
        detail: `container ${image} đã bị tạo lại (Id đổi)`,
      });
    }
    for (const [field, kind] of [
      ["Networks", FINDING.NETWORK],
      ["Mounts", FINDING.MOUNT],
      ["Ports", FINDING.PORTS],
    ]) {
      if (JSON.stringify(previous[field]) !== JSON.stringify(current[field])) {
        findings.push({ kind, detail: `${image}: ${field} khác trước drill` });
      }
    }
    if (Number(current.RestartCount) > Number(previous.RestartCount)) {
      findings.push({
        kind: FINDING.RESTART,
        detail: `${image}: RestartCount ${previous.RestartCount} -> ${current.RestartCount}`,
      });
    }
  }
  for (const image of afterByImage.keys()) {
    if (!beforeByImage.has(image)) {
      findings.push({ kind: FINDING.IMAGE, detail: `image lạ xuất hiện: ${image}` });
    }
  }

  if (String(before.systemd) !== String(after.systemd)) {
    findings.push({ kind: FINDING.SYSTEMD, detail: "trạng thái systemd khác trước drill" });
  }

  const freeBefore = rootFreeKib(before.root_filesystem);
  const freeAfter = rootFreeKib(after.root_filesystem);
  if (freeBefore === null || freeAfter === null) {
    findings.push({ kind: FINDING.ROOT_DISK, detail: "không đọc được dung lượng đĩa gốc" });
  } else if (freeBefore - freeAfter > tolerance) {
    findings.push({
      kind: FINDING.ROOT_DISK,
      detail: `đĩa gốc hụt ${freeBefore - freeAfter} KiB sau drill (ngưỡng ${tolerance})`,
    });
  }

  // Absence of evidence is a finding, not a pass. A drill that never measured the
  // model endpoint proves nothing about it, and `error: 1` is exactly what the
  // snapshot writes when the probe could not run at all.
  for (const [label, baseline] of [["trước", before], ["sau", after]]) {
    const probe = baseline.model_probe;
    if (
      probe === undefined || probe === null
      || Number(probe.error) !== 0
      || !(Number(probe.status) >= 200 && Number(probe.status) < 400)
    ) {
      findings.push({
        kind: FINDING.SLO_EVIDENCE,
        detail: `thiếu bằng chứng SLO endpoint mô hình ở baseline ${label}`,
      });
    }
  }

  return { findings, clean: findings.length === 0 };
}
