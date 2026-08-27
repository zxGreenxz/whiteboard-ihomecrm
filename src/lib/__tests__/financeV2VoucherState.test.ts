import { describe, it, expect } from "vitest";
import {
  getVoucherDisplayState,
  getVoucherActions,
  isForfeitRevenueVoucher,
  isForfeitOffsetVoucher,
  forfeitKqkdGate,
  forfeitKqkdReasonValid,
  FORFEIT_KQKD_REASON_MIN,
  FORFEIT_REVENUE_SOURCE,
  FORFEIT_OFFSET_SOURCE,
  VOUCHER_LABELS,
  type VoucherDisplayInput,
  type VoucherLifecycleState,
  type VoucherCapabilities,
} from "../financeV2VoucherState";

// Hậu tố phân sổ lấy đúng từ hằng để không lệch dấu "·"/khoảng trắng.
const SUFFIX = VOUCHER_LABELS.awaitingAssignmentSuffix; // " · Chờ phân sổ"

// Nền UNAPPROVED/CASHBOOK/UNPOSTED cho từng type.
const base = (
  type: "INCOME" | "EXPENSE",
  over: Partial<VoucherDisplayInput> = {},
): VoucherDisplayInput => ({
  type,
  approval_status: "UNAPPROVED",
  review_state: "PENDING",
  posting_mode: "CASHBOOK",
  posting_status: "UNPOSTED",
  execution_state: null,
  ...over,
});

describe("getVoucherDisplayState — bảng §12.1 (cả INCOME và EXPENSE)", () => {
  it("UNAPPROVED + CHANGES_REQUESTED → Cần bổ sung", () => {
    for (const type of ["INCOME", "EXPENSE"] as const) {
      const r = getVoucherDisplayState(
        base(type, { review_state: "CHANGES_REQUESTED" }),
      );
      expect(r.label).toBe("Cần bổ sung");
      expect(r.tone).toBe("changes");
      expect(r.isCash).toBe(false);
    }
  });

  it("UNAPPROVED + DISPUTED → Đang tranh chấp", () => {
    for (const type of ["INCOME", "EXPENSE"] as const) {
      const r = getVoucherDisplayState(
        base(type, { review_state: "DISPUTED" }),
      );
      expect(r.label).toBe("Đang tranh chấp");
      expect(r.tone).toBe("disputed");
      expect(r.isCash).toBe(false);
    }
  });

  it("UNAPPROVED + PENDING + UNPOSTED → Chờ duyệt (KHÔNG bao giờ là Nháp)", () => {
    for (const type of ["INCOME", "EXPENSE"] as const) {
      const r = getVoucherDisplayState(base(type));
      expect(r.label).toBe("Chờ duyệt");
      expect(r.tone).toBe("pending");
      expect(r.isCash).toBe(false);
      expect(r.label).not.toContain("Nháp");
    }
  });

  it("APPROVED + UNPOSTED → Đã Duyệt - Chưa Chi / Chưa Thu", () => {
    const chi = getVoucherDisplayState(
      base("EXPENSE", { approval_status: "APPROVED", review_state: "RESOLVED" }),
    );
    expect(chi.label).toBe("Đã Duyệt - Chưa Chi");
    expect(chi.tone).toBe("approved");
    expect(chi.isCash).toBe(false);

    const thu = getVoucherDisplayState(
      base("INCOME", { approval_status: "APPROVED", review_state: "RESOLVED" }),
    );
    expect(thu.label).toBe("Đã Duyệt - Chưa Thu");
    expect(thu.tone).toBe("approved");
    expect(thu.isCash).toBe(false);
  });

  it("APPROVED + UNPOSTED + execution=UNASSIGNED → thêm hậu tố · Chờ phân sổ", () => {
    const chi = getVoucherDisplayState(
      base("EXPENSE", {
        approval_status: "APPROVED",
        review_state: "RESOLVED",
        execution_state: "UNASSIGNED",
      }),
    );
    expect(chi.label).toBe("Đã Duyệt - Chưa Chi" + SUFFIX);
    expect(chi.tone).toBe("approved");

    const thu = getVoucherDisplayState(
      base("INCOME", {
        approval_status: "APPROVED",
        review_state: "RESOLVED",
        execution_state: "UNASSIGNED",
      }),
    );
    expect(thu.label).toBe("Đã Duyệt - Chưa Thu" + SUFFIX);
  });

  it("APPROVED + UNPOSTED + execution=ASSIGNED → KHÔNG có hậu tố", () => {
    for (const type of ["INCOME", "EXPENSE"] as const) {
      const r = getVoucherDisplayState(
        base(type, {
          approval_status: "APPROVED",
          review_state: "RESOLVED",
          execution_state: "ASSIGNED",
        }),
      );
      expect(r.label).not.toContain("Chờ phân sổ");
    }
  });

  it("APPROVED + NON_CASH + NOT_APPLICABLE → Đã ghi nhận - Không qua sổ", () => {
    for (const type of ["INCOME", "EXPENSE"] as const) {
      const r = getVoucherDisplayState(
        base(type, {
          approval_status: "APPROVED",
          review_state: "RESOLVED",
          posting_mode: "NON_CASH",
          posting_status: "NOT_APPLICABLE",
        }),
      );
      expect(r.label).toBe("Đã ghi nhận - Không qua sổ");
      expect(r.tone).toBe("approved");
      expect(r.isCash).toBe(false);
    }
  });

  it("active posting POSTED → Đã Chi / Đã Thu", () => {
    const chi = getVoucherDisplayState(
      base("EXPENSE", {
        approval_status: "APPROVED",
        review_state: "RESOLVED",
        posting_status: "POSTED",
      }),
    );
    expect(chi.label).toBe("Đã Chi");
    expect(chi.tone).toBe("posted");
    expect(chi.isCash).toBe(true);

    const thu = getVoucherDisplayState(
      base("INCOME", {
        approval_status: "APPROVED",
        review_state: "RESOLVED",
        posting_status: "POSTED",
      }),
    );
    expect(thu.label).toBe("Đã Thu");
    expect(thu.tone).toBe("posted");
    expect(thu.isCash).toBe(true);
  });

  it("REVERSED → Đã hoàn tác", () => {
    for (const type of ["INCOME", "EXPENSE"] as const) {
      const r = getVoucherDisplayState(
        base(type, {
          approval_status: "APPROVED",
          review_state: "RESOLVED",
          posting_status: "REVERSED",
        }),
      );
      expect(r.label).toBe("Đã hoàn tác");
      expect(r.tone).toBe("reversed");
      expect(r.isCash).toBe(false);
    }
  });

  it("CANCELLED → Đã hủy (cả CASHBOOK lẫn NON_CASH)", () => {
    for (const type of ["INCOME", "EXPENSE"] as const) {
      const cash = getVoucherDisplayState(
        base(type, { approval_status: "CANCELLED", review_state: "RESOLVED" }),
      );
      expect(cash.label).toBe("Đã hủy");
      expect(cash.tone).toBe("cancelled");
      expect(cash.isCash).toBe(false);

      const nonCash = getVoucherDisplayState(
        base(type, {
          approval_status: "CANCELLED",
          review_state: "RESOLVED",
          posting_mode: "NON_CASH",
          posting_status: "NOT_APPLICABLE",
        }),
      );
      expect(nonCash.label).toBe("Đã hủy");
      expect(nonCash.tone).toBe("cancelled");
    }
  });
});

describe("getVoucherDisplayState — isCash CHỈ khi POSTED", () => {
  const states: Array<Partial<VoucherDisplayInput>> = [
    { approval_status: "UNAPPROVED", review_state: "PENDING", posting_status: "UNPOSTED" },
    { approval_status: "UNAPPROVED", review_state: "CHANGES_REQUESTED", posting_status: "UNPOSTED" },
    { approval_status: "UNAPPROVED", review_state: "DISPUTED", posting_status: "UNPOSTED" },
    { approval_status: "APPROVED", review_state: "RESOLVED", posting_status: "UNPOSTED" },
    { approval_status: "APPROVED", review_state: "RESOLVED", posting_mode: "NON_CASH", posting_status: "NOT_APPLICABLE" },
    { approval_status: "APPROVED", review_state: "RESOLVED", posting_status: "REVERSED" },
    { approval_status: "CANCELLED", review_state: "RESOLVED", posting_status: "UNPOSTED" },
  ];

  it("mọi trạng thái KHÔNG-POSTED đều isCash=false", () => {
    for (const type of ["INCOME", "EXPENSE"] as const) {
      for (const s of states) {
        expect(getVoucherDisplayState(base(type, s)).isCash).toBe(false);
      }
    }
  });

  it("chỉ POSTED mới isCash=true", () => {
    for (const type of ["INCOME", "EXPENSE"] as const) {
      const r = getVoucherDisplayState(
        base(type, {
          approval_status: "APPROVED",
          review_state: "RESOLVED",
          posting_status: "POSTED",
        }),
      );
      expect(r.isCash).toBe(true);
    }
  });

  it("bất biến: isCash === (posting_status === 'POSTED') cho mọi tổ hợp", () => {
    const postings = ["UNPOSTED", "POSTED", "REVERSED", "NOT_APPLICABLE"] as const;
    const approvals = ["UNAPPROVED", "APPROVED", "CANCELLED"] as const;
    for (const type of ["INCOME", "EXPENSE"] as const) {
      for (const posting_status of postings) {
        for (const approval_status of approvals) {
          const r = getVoucherDisplayState(
            base(type, { approval_status, posting_status }),
          );
          expect(r.isCash).toBe(posting_status === "POSTED");
        }
      }
    }
  });
});

describe("getVoucherActions — ma trận năng lực", () => {
  const approverOnly: VoucherCapabilities = {
    canApprove: true,
    isCustodian: false,
    isMaker: false,
    canReverse: false,
  };
  const custodianOnly: VoucherCapabilities = {
    canApprove: false,
    isCustodian: true,
    isMaker: false,
    canReverse: false,
  };
  const both: VoucherCapabilities = {
    canApprove: true,
    isCustodian: true,
    isMaker: false,
    canReverse: false,
  };
  const maker: VoucherCapabilities = {
    canApprove: false,
    isCustodian: false,
    isMaker: true,
    canReverse: false,
  };
  // KNOWER tạo Phiếu thu = maker của phiếu income, không thêm quyền gì khác.
  const knower: VoucherCapabilities = {
    canApprove: false,
    isCustodian: false,
    isMaker: true,
    canReverse: false,
  };
  const reverser: VoucherCapabilities = {
    canApprove: false,
    isCustodian: false,
    isMaker: false,
    canReverse: true,
  };

  const pending: VoucherLifecycleState = {
    approval_status: "UNAPPROVED",
    review_state: "PENDING",
    posting_mode: "CASHBOOK",
    posting_status: "UNPOSTED",
  };
  const changesRequested: VoucherLifecycleState = {
    approval_status: "UNAPPROVED",
    review_state: "CHANGES_REQUESTED",
    posting_mode: "CASHBOOK",
    posting_status: "UNPOSTED",
  };
  const disputed: VoucherLifecycleState = {
    approval_status: "UNAPPROVED",
    review_state: "DISPUTED",
    posting_mode: "CASHBOOK",
    posting_status: "UNPOSTED",
  };
  const approvedUnposted: VoucherLifecycleState = {
    approval_status: "APPROVED",
    review_state: "RESOLVED",
    posting_mode: "CASHBOOK",
    posting_status: "UNPOSTED",
  };
  const nonCashApproved: VoucherLifecycleState = {
    approval_status: "APPROVED",
    review_state: "RESOLVED",
    posting_mode: "NON_CASH",
    posting_status: "NOT_APPLICABLE",
  };
  const posted: VoucherLifecycleState = {
    approval_status: "APPROVED",
    review_state: "RESOLVED",
    posting_mode: "CASHBOOK",
    posting_status: "POSTED",
  };
  const reversed: VoucherLifecycleState = {
    approval_status: "APPROVED",
    review_state: "RESOLVED",
    posting_mode: "CASHBOOK",
    posting_status: "REVERSED",
  };
  const cancelled: VoucherLifecycleState = {
    approval_status: "CANCELLED",
    review_state: "RESOLVED",
    posting_mode: "CASHBOOK",
    posting_status: "UNPOSTED",
  };

  describe("phiếu Chờ duyệt (UNAPPROVED + PENDING)", () => {
    it("approver-only: Duyệt + các quyết định review, KHÔNG post", () => {
      const a = getVoucherActions(pending, approverOnly);
      expect(a.approve).toBe(true);
      expect(a.approveAndPost).toBe(false); // thiếu CUSTODIAN
      expect(a.post).toBe(false);
      expect(a.requestChanges).toBe(true);
      expect(a.reject).toBe(true);
      expect(a.dispute).toBe(true);
      expect(a.withdraw).toBe(false);
      expect(a.resubmit).toBe(false);
      expect(a.reverse).toBe(false);
    });

    it("custodian-only: không quyết định gì trên phiếu chưa duyệt", () => {
      const a = getVoucherActions(pending, custodianOnly);
      expect(a.approve).toBe(false);
      expect(a.approveAndPost).toBe(false); // thiếu approve
      expect(a.post).toBe(false); // chưa APPROVED
      expect(a.requestChanges).toBe(false);
      expect(a.reject).toBe(false);
      expect(a.dispute).toBe(false);
    });

    it("both (approver + custodian): mở khóa Duyệt và Thu/Chi", () => {
      const a = getVoucherActions(pending, both);
      expect(a.approve).toBe(true);
      expect(a.approveAndPost).toBe(true);
      expect(a.post).toBe(false); // post là action riêng cho phiếu đã duyệt
      expect(a.requestChanges).toBe(true);
      expect(a.reject).toBe(true);
      expect(a.dispute).toBe(true);
    });

    it("maker: chỉ được rút phiếu của mình", () => {
      const a = getVoucherActions(pending, maker);
      expect(a.withdraw).toBe(true);
      expect(a.resubmit).toBe(false);
      expect(a.approve).toBe(false);
      expect(a.approveAndPost).toBe(false);
      expect(a.post).toBe(false);
      expect(a.requestChanges).toBe(false);
      expect(a.reject).toBe(false);
      expect(a.dispute).toBe(false);
    });

    it("knower (maker của Phiếu thu): rút được, không duyệt/không post", () => {
      const a = getVoucherActions(pending, knower);
      expect(a.withdraw).toBe(true);
      expect(a.approve).toBe(false);
      expect(a.approveAndPost).toBe(false);
      expect(a.post).toBe(false);
      expect(a.reverse).toBe(false);
    });
  });

  describe("phiếu Cần bổ sung (CHANGES_REQUESTED)", () => {
    it("maker: sửa + nộp lại (resubmit) và vẫn rút được", () => {
      const a = getVoucherActions(changesRequested, maker);
      expect(a.resubmit).toBe(true);
      expect(a.withdraw).toBe(true);
      expect(a.approve).toBe(false);
    });

    it("approver: KHÔNG approve trực tiếp, KHÔNG requestChanges lại, vẫn dispute/reject", () => {
      const a = getVoucherActions(changesRequested, approverOnly);
      expect(a.approve).toBe(false); // phải resubmit về PENDING trước
      expect(a.requestChanges).toBe(false); // đã ở CHANGES_REQUESTED
      expect(a.dispute).toBe(true);
      expect(a.reject).toBe(true);
    });
  });

  describe("phiếu Đang tranh chấp (DISPUTED)", () => {
    it("approver: KHÔNG dispute lại, vẫn requestChanges + reject, không approve thẳng", () => {
      const a = getVoucherActions(disputed, approverOnly);
      expect(a.dispute).toBe(false); // đã DISPUTED
      expect(a.requestChanges).toBe(true);
      expect(a.reject).toBe(true);
      expect(a.approve).toBe(false);
    });

    it("maker: KHÔNG được rút phiếu đang tranh chấp", () => {
      const a = getVoucherActions(disputed, maker);
      expect(a.withdraw).toBe(false);
      expect(a.resubmit).toBe(false);
    });
  });

  describe("phiếu Đã Duyệt - Chưa Thu/Chi (APPROVED + UNPOSTED)", () => {
    it("custodian-only: được Thu/Chi (post), không cần quyền duyệt", () => {
      const a = getVoucherActions(approvedUnposted, custodianOnly);
      expect(a.post).toBe(true);
      expect(a.approve).toBe(false);
      expect(a.approveAndPost).toBe(false);
      expect(a.reject).toBe(false);
      expect(a.withdraw).toBe(false);
    });

    it("approver-only (không giữ sổ): KHÔNG post được", () => {
      const a = getVoucherActions(approvedUnposted, approverOnly);
      expect(a.post).toBe(false);
      expect(a.approve).toBe(false); // đã duyệt rồi
    });

    it("both: post được", () => {
      expect(getVoucherActions(approvedUnposted, both).post).toBe(true);
    });

    it("maker (không giữ sổ): không action nào", () => {
      const a = getVoucherActions(approvedUnposted, maker);
      expect(a.post).toBe(false);
      expect(a.withdraw).toBe(false); // đã APPROVED
      expect(a.resubmit).toBe(false);
    });
  });

  describe("phiếu Đã ghi nhận - Không qua sổ (APPROVED + NON_CASH)", () => {
    it("custodian: KHÔNG post (không qua sổ quỹ)", () => {
      expect(getVoucherActions(nonCashApproved, custodianOnly).post).toBe(false);
    });
    it("both: KHÔNG approveAndPost/post", () => {
      const a = getVoucherActions(nonCashApproved, both);
      expect(a.post).toBe(false);
      expect(a.approveAndPost).toBe(false);
    });
  });

  describe("phiếu Đã Chi/Thu (POSTED)", () => {
    it("reverser: chỉ được đảo", () => {
      const a = getVoucherActions(posted, reverser);
      expect(a.reverse).toBe(true);
      expect(a.post).toBe(false);
      expect(a.approve).toBe(false);
      expect(a.withdraw).toBe(false);
    });

    it("custodian/both không có canReverse: KHÔNG đảo được, không post lại", () => {
      expect(getVoucherActions(posted, custodianOnly).reverse).toBe(false);
      expect(getVoucherActions(posted, both).reverse).toBe(false);
      expect(getVoucherActions(posted, custodianOnly).post).toBe(false);
    });
  });

  describe("phiếu terminal REVERSED / CANCELLED", () => {
    it("REVERSED: không action nào kể cả full caps", () => {
      const full: VoucherCapabilities = {
        canApprove: true,
        isCustodian: true,
        isMaker: true,
        canReverse: true,
      };
      const a = getVoucherActions(reversed, full);
      expect(Object.values(a).every((x) => x === false)).toBe(true);
    });

    it("CANCELLED: không action nào kể cả full caps", () => {
      const full: VoucherCapabilities = {
        canApprove: true,
        isCustodian: true,
        isMaker: true,
        canReverse: true,
      };
      const a = getVoucherActions(cancelled, full);
      expect(Object.values(a).every((x) => x === false)).toBe(true);
    });
  });

  it("approveAndPost đòi ĐỒNG THỜI approver và custodian trên phiếu Chờ duyệt CASHBOOK", () => {
    expect(getVoucherActions(pending, approverOnly).approveAndPost).toBe(false);
    expect(getVoucherActions(pending, custodianOnly).approveAndPost).toBe(false);
    expect(getVoucherActions(pending, both).approveAndPost).toBe(true);
  });
});

describe("Nhận diện hai chân cặp bút toán bỏ cọc", () => {
  it("nhận chân doanh thu theo system_source", () => {
    expect(isForfeitRevenueVoucher({ system_source: FORFEIT_REVENUE_SOURCE })).toBe(true);
    expect(isForfeitOffsetVoucher({ system_source: FORFEIT_REVENUE_SOURCE })).toBe(false);
  });

  it("nhận chân đối ứng theo system_source", () => {
    expect(isForfeitOffsetVoucher({ system_source: FORFEIT_OFFSET_SOURCE })).toBe(true);
    expect(isForfeitRevenueVoucher({ system_source: FORFEIT_OFFSET_SOURCE })).toBe(false);
  });

  it("KHÔNG đoán theo tên phiếu — tên do người dùng gõ lại được", () => {
    // Phiếu thường đặt tên y hệt vẫn không phải bút toán bỏ cọc: guard ở server
    // canh theo system_source, nên UI phải canh cùng một cột.
    const giaMao = { system_source: null, name: "Doanh thu bỏ cọc — HĐ ABC" };
    expect(isForfeitRevenueVoucher(giaMao)).toBe(false);
    expect(isForfeitOffsetVoucher(giaMao)).toBe(false);
  });

  it("phiếu thường và giá trị rỗng đều trả false", () => {
    for (const v of [null, undefined, {}, { system_source: "invoice.collection.v5" }]) {
      expect(isForfeitRevenueVoucher(v)).toBe(false);
      expect(isForfeitOffsetVoucher(v)).toBe(false);
    }
  });
});

describe("forfeitKqkdGate — ai mở được ô nào trên phiếu bỏ cọc", () => {
  const REV = { system_source: FORFEIT_REVENUE_SOURCE, approval_status: "APPROVED" as const };
  const OFF = { system_source: FORFEIT_OFFSET_SOURCE, approval_status: "APPROVED" as const };
  const THUONG = { system_source: null, approval_status: "APPROVED" as const };

  const chuCongTy = { isAdmin: false, isCompanyOwner: true };
  const superAdmin = { isAdmin: true, isCompanyOwner: false };
  const quanLyToa = { isAdmin: false, isCompanyOwner: false };

  it("chủ công ty mở được cửa KQKD trên chân doanh thu", () => {
    const g = forfeitKqkdGate(REV, chuCongTy);
    expect(g.forfeitKqkdMode).toBe(true);
    // Và cửa hẹp LOẠI TRỪ đường sửa thường — đây là điểm chính.
    expect(g.canEditNormally).toBe(false);
  });

  it("super admin cũng chỉ được cửa hẹp, KHÔNG được sửa mọi ô", () => {
    // Trước đợt này super admin có canEdit = true trên mọi phiếu, nên form mời
    // sửa số tiền rồi trigger writer thanh lý từ chối bằng một câu khó hiểu.
    const g = forfeitKqkdGate(REV, superAdmin);
    expect(g.forfeitKqkdMode).toBe(true);
    expect(g.canEditNormally).toBe(false);
  });

  it("quản lý toà KHÔNG mở được gì trên phiếu bỏ cọc", () => {
    const g = forfeitKqkdGate(REV, quanLyToa);
    expect(g.forfeitKqkdMode).toBe(false);
    expect(g.canEditNormally).toBe(false);
  });

  it("chân ĐỐI ỨNG khoá với tất cả — kể cả chủ công ty và super admin", () => {
    // kqkd của chân cấn cọc phải bằng 0 vĩnh viễn; server trả P0001 nếu gọi.
    for (const ai of [chuCongTy, superAdmin, quanLyToa]) {
      const g = forfeitKqkdGate(OFF, ai);
      expect(g.forfeitKqkdMode).toBe(false);
      expect(g.canEditNormally).toBe(false);
      expect(g.isForfeitLeg).toBe(true);
    }
  });

  it("phiếu bỏ cọc ĐÃ HUỶ thì đóng cửa", () => {
    const g = forfeitKqkdGate(
      { system_source: FORFEIT_REVENUE_SOURCE, approval_status: "CANCELLED" },
      chuCongTy,
    );
    expect(g.forfeitKqkdMode).toBe(false);
  });

  it("phiếu bỏ cọc CHỜ DUYỆT vẫn đi cửa hẹp, không đi đường thường", () => {
    // Đường thường sẽ chết ở trigger writer thanh lý dù phiếu đang chờ duyệt.
    const g = forfeitKqkdGate(
      { system_source: FORFEIT_REVENUE_SOURCE, approval_status: "UNAPPROVED" },
      chuCongTy,
    );
    expect(g.forfeitKqkdMode).toBe(true);
    expect(g.canEditNormally).toBe(false);
  });

  it("KHÔNG đụng gì tới phiếu thường", () => {
    expect(forfeitKqkdGate(THUONG, superAdmin)).toEqual({
      isForfeitLeg: false, forfeitKqkdMode: false, canEditNormally: true,
    });
    expect(forfeitKqkdGate(THUONG, quanLyToa).canEditNormally).toBe(false);
    expect(
      forfeitKqkdGate({ system_source: null, approval_status: "UNAPPROVED" }, quanLyToa)
        .canEditNormally,
    ).toBe(true);
  });

  it("tạo phiếu mới (không có voucher) vẫn sửa được bình thường", () => {
    expect(forfeitKqkdGate(null, quanLyToa).canEditNormally).toBe(true);
    expect(forfeitKqkdGate(undefined, quanLyToa).forfeitKqkdMode).toBe(false);
  });
});

describe("forfeitKqkdReasonValid — cùng ngưỡng với server", () => {
  it("giữ đúng con số mà set_forfeit_voucher_kqkd_v1 bắt (22023 khi < 8)", () => {
    expect(FORFEIT_KQKD_REASON_MIN).toBe(8);
  });

  it("từ chối lý do rỗng, thiếu, hoặc chỉ toàn khoảng trắng", () => {
    // Server dùng btrim rồi mới đếm — client phải cắt y hệt, nếu không người
    // dùng bấm được nút rồi mới ăn lỗi 22023.
    for (const r of [null, undefined, "", "   ", "\n\t  ", "ngan"]) {
      expect(forfeitKqkdReasonValid(r)).toBe(false);
    }
  });

  it("nhận lý do đủ 8 ký tự sau khi cắt khoảng trắng", () => {
    expect(forfeitKqkdReasonValid("12345678")).toBe(true);
    expect(forfeitKqkdReasonValid("  12345678  ")).toBe(true);
    expect(forfeitKqkdReasonValid("  1234567  ")).toBe(false);
  });
});
