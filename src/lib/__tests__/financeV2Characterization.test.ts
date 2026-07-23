/**
 * financeV2Characterization.test.ts — CHARACTERIZATION ("pin") tests cho cutover
 * Finance V2 (plan §16.4: "trước migration, characterization đóng đinh hiện trạng
 * ... sau cutover thay bằng state/access matrix mới").
 *
 * MỤC ĐÍCH: đóng đinh HÀNH VI HIỆN TẠI (pre-migration) của lớp hiển thị phiếu
 * thu/chi để khi cutover Finance V2 diễn ra, DIFF là TƯỜNG MINH — test này sẽ
 * GÃY đúng chỗ hành vi đổi, buộc người sửa phải cập nhật/ xoá pin một cách có ý
 * thức thay vì đổi ngầm.
 *
 * Ba nhóm hiện trạng được pin:
 *   (1) voucherLayer() — mapping hiện tại. Điểm mấu chốt (§12.1 / §16.4):
 *       "voucherLayer chỉ CASH khi có posting active". HIỆN TẠI chưa có khái niệm
 *       posting → APPROVED + có sổ thật đã bị coi là CASH ngay (đây là "overload
 *       to be broken"). Ta pin cả CASE BUG này để cutover phải chủ động phá.
 *   (2) VoucherStatusBadge — chuỗi nhãn hiện tại ('Đã vào sổ' cho APPROVED, ...).
 *   (3) VoucherDetailPage.StatusBadge — chuỗi inline hiện tại ('Đã ghi nhận' /
 *       'Nháp'). Component này KHÔNG export nên pin qua SOURCE TEXT.
 *
 * SAU CUTOVER: cả (2) và (3) được thay bằng composite getVoucherDisplayState()
 * (plan §12.1 bảng mapping — "Đã Duyệt - Chưa Thu/Chi", "Đã ghi nhận - Không qua
 * sổ", "Đã Thu/Chi", ...). Khi đó các assertion dưới đây PHẢI được viết lại theo
 * state/access matrix mới — coi việc chúng gãy là TÍN HIỆU, không phải hồi quy.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { voucherLayer, VOUCHER_SOURCES, isInternalSource } from "../voucherSources";
import type { VoucherLayer } from "../voucherSources";
import { VoucherStatusBadge, InternalBadge } from "../../components/income-expenses/VoucherStatusBadge";

// ---------------------------------------------------------------------------
// (1) voucherLayer() — mapping hiện tại (pre-migration)
// ---------------------------------------------------------------------------

type LayerInput = Parameters<typeof voucherLayer>[0];

describe("voucherLayer() — pin mapping HIỆN TẠI (plan §16.4 characterization)", () => {
  // Bảng input→output cụ thể. Mỗi dòng là một hiện trạng phải đứng yên tới cutover.
  const cases: Array<{ name: string; input: LayerInput; expected: VoucherLayer }> = [
    // --- CANCELLED thắng mọi thứ ---
    {
      name: "CANCELLED → CANCELLED (bất kể sổ/nguồn/ảo)",
      input: {
        approval_status: "CANCELLED",
        account_id: "acc-1",
        system_source: "invoice.payment",
        account_is_virtual: false,
        change_account_is_virtual: false,
      },
      expected: "CANCELLED",
    },

    // --- PENDING: chưa duyệt HOẶC chưa chọn sổ ---
    {
      name: "UNAPPROVED (dù có sổ thật) → PENDING",
      input: { approval_status: "UNAPPROVED", account_id: "acc-1", system_source: "invoice.payment" },
      expected: "PENDING",
    },
    {
      name: "UNAPPROVED được ưu tiên TRƯỚC khi xét sổ ảo → PENDING (không phải INTERNAL)",
      input: {
        approval_status: "UNAPPROVED",
        account_id: "acc-1",
        system_source: "termination.offset",
        account_is_virtual: true,
        change_account_is_virtual: true,
      },
      expected: "PENDING",
    },
    {
      name: "APPROVED nhưng account_id = null → PENDING (chưa chọn sổ)",
      input: { approval_status: "APPROVED", account_id: null, system_source: "invoice.payment" },
      expected: "PENDING",
    },
    {
      name: "APPROVED nhưng account_id = undefined → PENDING",
      input: { approval_status: "APPROVED", account_id: undefined, system_source: "invoice.payment" },
      expected: "PENDING",
    },
    {
      name: "APPROVED nhưng account_id = '' (rỗng) → PENDING",
      input: { approval_status: "APPROVED", account_id: "", system_source: "invoice.payment" },
      expected: "PENDING",
    },

    // --- INTERNAL: mọi chân sổ ảo, HOẶC nguồn internal (fallback lịch sử) ---
    {
      name: "APPROVED + cả hai chân sổ ảo (change=true) → INTERNAL",
      input: {
        approval_status: "APPROVED",
        account_id: "acc-virtual",
        system_source: "invoice.payment",
        account_is_virtual: true,
        change_account_is_virtual: true,
      },
      expected: "INTERNAL",
    },
    {
      name: "APPROVED + chân chính ảo, change=null (một chân) → INTERNAL (== null bắt cả undefined)",
      input: {
        approval_status: "APPROVED",
        account_id: "acc-virtual",
        system_source: "invoice.payment",
        account_is_virtual: true,
        change_account_is_virtual: null,
      },
      expected: "INTERNAL",
    },
    {
      name: "APPROVED + chân chính ảo, change=undefined → INTERNAL (== null bắt undefined)",
      input: {
        approval_status: "APPROVED",
        account_id: "acc-virtual",
        system_source: "invoice.payment",
        account_is_virtual: true,
        change_account_is_virtual: undefined,
      },
      expected: "INTERNAL",
    },
    {
      name: "APPROVED + nguồn internal (termination.offset) trên SỔ THẬT → INTERNAL (fallback theo nguồn)",
      input: {
        approval_status: "APPROVED",
        account_id: "acc-real",
        system_source: "termination.offset",
        account_is_virtual: false,
        change_account_is_virtual: false,
      },
      expected: "INTERNAL",
    },

    // --- CASH: tiền thật đã "vào sổ" theo mô hình HIỆN TẠI ---
    {
      name: "★ BUG/overload — APPROVED + sổ THẬT + nguồn non-internal → CASH NGAY (chưa cần posting)",
      // Đây là hành vi PHẢI ĐỔI ở cutover: Finance V2 chỉ CASH khi có posting
      // active. Pin để diff cutover lộ rõ (§12.1: "voucherLayer() chỉ trả CASH khi
      // có posting active"; bảng §12.1: APPROVED + UNPOSTED → "Đã Duyệt - Chưa Thu/Chi").
      input: {
        approval_status: "APPROVED",
        account_id: "acc-real",
        system_source: "invoice.payment",
        account_is_virtual: false,
        change_account_is_virtual: false,
      },
      expected: "CASH",
    },
    {
      name: "★ BUG/overload — APPROVED + chỉ account_id (không cờ ảo, không nguồn) → CASH",
      // Case tối giản của bug: đủ để hiện trạng coi phiếu duyệt là tiền-thật-đã-vào-sổ.
      input: { approval_status: "APPROVED", account_id: "acc-real" },
      expected: "CASH",
    },
    {
      name: "APPROVED + chân chính ảo NHƯNG change=false (chân thật) → CASH (legsVirtual=false)",
      input: {
        approval_status: "APPROVED",
        account_id: "acc-real",
        system_source: "invoice.payment",
        account_is_virtual: true,
        change_account_is_virtual: false,
      },
      expected: "CASH",
    },
    {
      name: "APPROVED + handover.transfer (non-internal: tiền mặt thật giữa hai két) → CASH",
      input: {
        approval_status: "APPROVED",
        account_id: "acc-real",
        system_source: "handover.transfer",
        account_is_virtual: false,
        change_account_is_virtual: null,
      },
      expected: "CASH",
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(voucherLayer(input)).toBe(expected);
  });

  // Sổ các nguồn internal / non-internal đúng như bảng quyết định — vì INTERNAL
  // fallback dựa vào cờ này. Nếu bảng đổi, mapping ở trên đổi theo.
  it("isInternalSource() khớp bảng VOUCHER_SOURCES.internal (fallback INTERNAL)", () => {
    expect(isInternalSource("termination.offset")).toBe(true);
    expect(isInternalSource("termination.forfeit_offset")).toBe(true);
    expect(isInternalSource("backfill.initial_deposit")).toBe(true);
    expect(isInternalSource("adjustment.opening_balance")).toBe(true);
    expect(isInternalSource("adjustment.close_coc")).toBe(true);

    expect(isInternalSource("invoice.payment")).toBe(false);
    expect(isInternalSource("contract.deposit")).toBe(false);
    expect(isInternalSource("handover.transfer")).toBe(false);
    expect(isInternalSource("termination.refund")).toBe(false);
    expect(isInternalSource(null)).toBe(false);
    expect(isInternalSource(undefined)).toBe(false);
    expect(isInternalSource("unknown.source")).toBe(false);
  });

  const nonInternalSources = Object.keys(VOUCHER_SOURCES).filter((s) => !VOUCHER_SOURCES[s].internal);
  const internalSources = Object.keys(VOUCHER_SOURCES).filter((s) => VOUCHER_SOURCES[s].internal);

  // Property đóng đinh "OVERLOAD to be broken": với BẤT KỲ status nào KHÁC
  // UNAPPROVED/CANCELLED, miễn có account_id thật, chân không ảo và nguồn không
  // internal → HIỆN TẠI luôn CASH. Guard chỉ so === "UNAPPROVED", nên kể cả status
  // lạ ("VERIFIED", "FOO", chuỗi rỗng, ...) cũng rơi vào CASH. Cutover phải phá quá
  // tải này (thêm nhánh APPROVED-unposted).
  it("[property] status ∉ {UNAPPROVED,CANCELLED} + sổ thật + non-internal ⇒ CASH (overload hiện tại)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s !== "UNAPPROVED" && s !== "CANCELLED"),
        fc.constantFrom<(string | null | undefined)>(...nonInternalSources, null, undefined, "unknown.source"),
        fc.uuid(),
        (status, source, accountId) => {
          const layer = voucherLayer({
            approval_status: status,
            account_id: accountId,
            system_source: source,
            account_is_virtual: false,
            change_account_is_virtual: null,
          });
          expect(layer).toBe("CASH");
        },
      ),
    );
  });

  // Property: CANCELLED luôn thắng, bất kể các field còn lại.
  it("[property] CANCELLED ⇒ CANCELLED bất kể sổ/nguồn/cờ ảo", () => {
    fc.assert(
      fc.property(
        fc.option(fc.uuid(), { nil: null }),
        fc.constantFrom<(string | null)>(...Object.keys(VOUCHER_SOURCES), null),
        fc.boolean(),
        fc.boolean(),
        (accountId, source, av, cav) => {
          expect(
            voucherLayer({
              approval_status: "CANCELLED",
              account_id: accountId,
              system_source: source,
              account_is_virtual: av,
              change_account_is_virtual: cav,
            }),
          ).toBe("CANCELLED");
        },
      ),
    );
  });

  // Property: nguồn internal trên sổ thật (không ảo), đã duyệt ⇒ INTERNAL (fallback).
  it("[property] APPROVED + nguồn internal + sổ thật ⇒ INTERNAL (fallback theo nguồn)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...internalSources), fc.uuid(), (source, accountId) => {
        expect(
          voucherLayer({
            approval_status: "APPROVED",
            account_id: accountId,
            system_source: source,
            account_is_virtual: false,
            change_account_is_virtual: false,
          }),
        ).toBe("INTERNAL");
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// (2) VoucherStatusBadge — chuỗi nhãn HIỆN TẠI
//     Component leaf không dùng hook → gọi trực tiếp như hàm thuần và đọc text
//     trong cây React element (không cần DOM/jsdom).
//     SAU CUTOVER: các nhãn này bị thay bởi composite getVoucherDisplayState()
//     (plan §12.1). Khi đó rewrite/ xoá các assertion dưới đây.
// ---------------------------------------------------------------------------

/** Trích text con của một React element (string/number/array/lồng nhau). */
function badgeText(el: unknown): string {
  const walk = (node: any): string => {
    if (node == null || node === false || node === true) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(walk).join("");
    if (node?.props && "children" in node.props) return walk(node.props.children);
    return "";
  };
  return walk(el).trim();
}

describe("VoucherStatusBadge — pin nhãn HIỆN TẠI (thay bởi getVoucherDisplayState ở cutover)", () => {
  it("APPROVED (chưa verified) → 'Đã vào sổ'", () => {
    // ★ Nhãn chốt: cutover đổi thành 'Đã Duyệt - Chưa Thu/Chi' / 'Đã Thu/Chi' theo posting.
    expect(badgeText(VoucherStatusBadge({ status: "APPROVED" }))).toBe("Đã vào sổ");
    expect(badgeText(VoucherStatusBadge({ status: "APPROVED", verifiedAt: null }))).toBe("Đã vào sổ");
  });

  it("APPROVED + verifiedAt → 'Đã đối chiếu'", () => {
    expect(badgeText(VoucherStatusBadge({ status: "APPROVED", verifiedAt: "2026-07-22T00:00:00Z" }))).toBe(
      "Đã đối chiếu",
    );
  });

  it("UNAPPROVED → 'Chờ duyệt'", () => {
    expect(badgeText(VoucherStatusBadge({ status: "UNAPPROVED" }))).toBe("Chờ duyệt");
    // verifiedAt không override khi chưa duyệt (nhánh UNAPPROVED xét trước).
    expect(badgeText(VoucherStatusBadge({ status: "UNAPPROVED", verifiedAt: "2026-07-22T00:00:00Z" }))).toBe(
      "Chờ duyệt",
    );
  });

  it("CANCELLED → 'Đã huỷ'", () => {
    expect(badgeText(VoucherStatusBadge({ status: "CANCELLED" }))).toBe("Đã huỷ");
    expect(badgeText(VoucherStatusBadge({ status: "CANCELLED", verifiedAt: "2026-07-22T00:00:00Z" }))).toBe(
      "Đã huỷ",
    );
  });

  it("InternalBadge → 'Nội bộ'", () => {
    expect(badgeText(InternalBadge())).toBe("Nội bộ");
  });
});

// ---------------------------------------------------------------------------
// (3) VoucherDetailPage.StatusBadge — chuỗi inline HIỆN TẠI
//     Component StatusBadge là PRIVATE (không export) → pin qua SOURCE TEXT.
//     Khi cutover thay khối inline này bằng getVoucherDisplayState(), các literal
//     dưới đây rời khỏi file và test GÃY — đúng ý "make the cutover diff explicit".
// ---------------------------------------------------------------------------

describe("VoucherDetailPage.StatusBadge — pin chuỗi inline HIỆN TẠI (private, qua source)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const detailSrc = readFileSync(
    path.resolve(here, "../../pages/payments/VoucherDetailPage.tsx"),
    "utf8",
  );

  // §12.2 sweep (P11b): chữ "Nháp" đã bị loại khỏi domain Thu Chi — UNAPPROVED
  // hiển thị "Chờ duyệt" ở mọi nơi. Pin cập nhật theo plan §16.4 ("sau cutover
  // thay bằng state/access matrix mới").
  it("UNAPPROVED render 'Chờ duyệt' (không còn 'Nháp' trong domain Thu Chi)", () => {
    expect(detailSrc).toContain("Chờ duyệt");
    expect(detailSrc).not.toContain("Nháp");
  });

  it("mặc định (không CANCELLED/UNAPPROVED, tức APPROVED) render 'Đã ghi nhận'", () => {
    // Còn lại của overload legacy: nhãn APPROVED cứng. Khi VoucherDetailPage
    // chuyển sang composite getVoucherDisplayState() (route CANONICAL, §12.1),
    // literal này rời khỏi file và pin này được thay tiếp.
    expect(detailSrc).toContain("Đã ghi nhận");
  });

  it("thứ tự nhánh hiện tại: CANCELLED('Đã huỷ') → UNAPPROVED('Chờ duyệt') → mặc định('Đã ghi nhận')", () => {
    const idxHuy = detailSrc.indexOf("Đã huỷ");
    const idxChoDuyet = detailSrc.indexOf("Chờ duyệt");
    const idxGhiNhan = detailSrc.indexOf("Đã ghi nhận");
    expect(idxHuy).toBeGreaterThanOrEqual(0);
    expect(idxChoDuyet).toBeGreaterThan(idxHuy);
    expect(idxGhiNhan).toBeGreaterThan(idxChoDuyet);
  });
});