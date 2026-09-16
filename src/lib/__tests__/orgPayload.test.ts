import { describe, expect, it } from "vitest";
import { withOrg, withOrgAll } from "../orgPayload";

/**
 * Plan I3 (rà soát 15/09/2026): trigger BEFORE INSERT trên 33 bảng chuyển sang
 * app_private.autofill_org_strict — fail-closed. Người thuộc HAI tổ chức mà
 * client quên gửi organization_id thì INSERT nổ 23502. Helper này là chỗ duy
 * nhất mọi đường ghi client đi qua để điền cột đó từ tổ chức ĐANG CHỌN.
 */
const ORG = "dddd0000-0000-4000-8000-000000000001";

describe("withOrg", () => {
  it("điền organization_id từ tổ chức đang chọn khi payload chưa có", () => {
    expect(withOrg({ name: "A" }, ORG)).toEqual({ name: "A", organization_id: ORG });
  });

  it("KHÔNG ghi đè organization_id đã có sẵn trong payload", () => {
    const own = "aaaa0000-0000-4000-8000-000000000001";
    expect(withOrg({ name: "A", organization_id: own }, ORG)).toEqual({
      name: "A",
      organization_id: own,
    });
  });

  it("coi organization_id null/undefined/rỗng trong payload là CHƯA có và điền lại", () => {
    // Khai kiểu rộng như cột Insert sinh từ DB (`string | null`): literal
    // `{ organization_id: null }` làm giao kiểu rút về `never` ở mức TYPE, còn
    // hành vi runtime là thứ test này đo.
    const chuaCo: { organization_id: string | null } = { organization_id: null };
    const boTrong: { organization_id?: string } = { organization_id: undefined };
    expect(withOrg(chuaCo, ORG).organization_id).toBe(ORG);
    expect(withOrg(boTrong, ORG).organization_id).toBe(ORG);
    expect(withOrg({ organization_id: "" }, ORG).organization_id).toBe(ORG);
  });

  it("NÉM 'Chưa chọn công ty' khi chưa chốt tổ chức — không im lặng, không đoán", () => {
    expect(() => withOrg({ name: "A" }, null)).toThrow("Chưa chọn công ty");
    expect(() => withOrg({ name: "A" }, undefined)).toThrow("Chưa chọn công ty");
    expect(() => withOrg({ name: "A" }, "")).toThrow("Chưa chọn công ty");
  });

  it("payload đã có organization_id thì không cần tổ chức đang chọn", () => {
    expect(withOrg({ organization_id: ORG }, null)).toEqual({ organization_id: ORG });
  });

  it("không đột biến payload gốc", () => {
    const goc = { name: "A" };
    const ra = withOrg(goc, ORG);
    expect(goc).toEqual({ name: "A" });
    expect(ra).not.toBe(goc);
  });
});

describe("withOrgAll", () => {
  it("map từng phần tử, giữ phần tử đã có organization_id", () => {
    const own = "aaaa0000-0000-4000-8000-000000000001";
    expect(withOrgAll([{ a: 1 }, { a: 2, organization_id: own }], ORG)).toEqual([
      { a: 1, organization_id: ORG },
      { a: 2, organization_id: own },
    ]);
  });

  it("mảng rỗng trả mảng rỗng, không ném dù chưa chọn tổ chức", () => {
    expect(withOrgAll([], null)).toEqual([]);
  });

  it("có phần tử thiếu org mà chưa chọn tổ chức thì ném", () => {
    expect(() => withOrgAll([{ a: 1 }], null)).toThrow("Chưa chọn công ty");
  });
});
