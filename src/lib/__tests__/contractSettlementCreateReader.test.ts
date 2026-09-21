import { expect, it } from "vitest";
import {
  parseSettlementCreateSource,
  parseSettlementRefundPreview,
  parseSettlementSaleProposals,
} from "../contractSettlementCreateReader";
const actor = "20000000-0000-4000-8000-000000000001",
  org = "10000000-0000-4000-8000-000000000001",
  id = "30000000-0000-4000-8000-000000000001";
const ref = { kind: "broker" as const, organizationId: org, contractId: id };
const source = () => ({
  actorId: actor,
  organizationId: org,
  kind: "broker",
  sourceId: id,
  revision: "actual",
  canCreate: true,
  blockedReason: null,
  canForce: false,
  existingVoucherId: null,
  hiddenExisting: false,
  contractId: id,
  buildingId: id,
  roomId: id,
  sourceCode: null,
  sourceStatus: "ACTIVE",
  sourceDate: "2026-09-21",
  today: "2026-09-21",
  name: "Nguồn",
  recipientName: null,
  recipientBank: null,
  recipientAccount: null,
  suggestedAmount: "100",
  capAmount: null,
  basis: {
    kind: "commission",
    months: 12,
    ratePercent: "50.5",
    expectedAmount: "100",
    warning: null,
  },
  refund: null,
  latestObligation: null,
});
it("parses numeric strings without fabricating missing authority", () => {
  expect(parseSettlementCreateSource(source(), ref, actor)).toMatchObject({
    suggestedAmount: 100,
    basis: { ratePercent: 50.5 },
  });
});
it('binds contract source and basis kind instead of accepting unrelated anchors',()=>{
 expect(()=>parseSettlementCreateSource({...source(),contractId:actor},ref,actor)).toThrow();
 expect(()=>parseSettlementCreateSource({...source(),basis:{...source().basis,kind:'bonus'}},ref,actor)).toThrow();
});
it.each([
  "actorId",
  "organizationId",
  "sourceId",
  "canCreate",
  "hiddenExisting",
  "today",
  "suggestedAmount",
  "basis",
])("rejects missing %s", (field) => {
  const raw: Record<string, unknown> = source();
  delete raw[field];
  expect(() => parseSettlementCreateSource(raw, ref, actor)).toThrow();
});
it("rejects hidden claim IDs, wrong org and invalid calendar dates", () => {
  expect(() =>
    parseSettlementCreateSource(
      { ...source(), hiddenExisting: true, existingVoucherId: id },
      ref,
      actor,
    ),
  ).toThrow();
  expect(() =>
    parseSettlementCreateSource(
      { ...source(), organizationId: id },
      ref,
      actor,
    ),
  ).toThrow();
  expect(() =>
    parseSettlementCreateSource(
      { ...source(), today: "2026-02-31" },
      ref,
      actor,
    ),
  ).toThrow();
});
it("requires complete refund amounts and exact status", () => {
  const preview = {
    terminationId: id,
    contractId: id,
    organizationId: org,
    requestedAmount: 100,
    realHeld: 0,
    recognizedOnly: 100,
    basisStatus: "RECOGNIZED_ONLY",
    basisFingerprint: "fingerprint",
    obligationStatus: "CHUA_TUNG_VAO_KET",
    warning: "Cảnh báo",
  };
  expect(parseSettlementRefundPreview(preview).realHeld).toBe(0);
  expect(() =>
    parseSettlementRefundPreview({ ...preview, realHeld: undefined }),
  ).toThrow();
  expect(() =>
    parseSettlementRefundPreview({ ...preview, obligationStatus: "NEW" }),
  ).toThrow();
});
it("rejects wrong-org and duplicate proposal rows while retaining actual deposit IDs", () => {
  const row = {
    id,
    organization_id: org,
    code: "PT-1",
    name: "Cọc",
    voucher_date: "2026-09-21",
    building_id: id,
    room_id: null,
  };
  expect(
    parseSettlementSaleProposals([row], org, "sale_deposit")[0].sourceRef,
  ).toEqual({
    kind: "sale_deposit",
    organizationId: org,
    depositVoucherId: id,
  });
  expect(() =>
    parseSettlementSaleProposals([row, row], org, "sale_deposit"),
  ).toThrow();
  expect(() =>
    parseSettlementSaleProposals(
      [{ ...row, organization_id: id }],
      org,
      "sale_deposit",
    ),
  ).toThrow();
});
