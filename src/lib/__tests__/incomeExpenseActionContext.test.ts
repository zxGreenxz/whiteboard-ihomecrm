import { describe, it, expect } from "vitest";
import {
  buildIncomeExpenseActionContext,
  parseCancellationEligibility,
} from "../incomeExpenseActionContext";
import { decideIncomeExpenseActions } from "../incomeExpenseActionPolicy";
import type {
  ActionSnapshotBatch,
  IncomeExpenseActionSnapshot,
} from "../incomeExpenseActionSnapshot";
const ready = <T>(value: T) => ({ state: "ready" as const, value });
const row: IncomeExpenseActionSnapshot = {
  id: "v",
  organizationId: "o",
  buildingId: "b",
  roomId: null,
  contractId: null,
  tenantId: null,
  code: "PC",
  name: "Chi",
  type: "EXPENSE",
  totalAmount: 123,
  userId: "u",
  makerUserId: "u",
  payerName: null,
  receiveBankName: null,
  receiveBankAccount: null,
  notes: null,
  attachments: [],
  voucherDate: "2026-09-21",
  accountId: null,
  activePostingId: null,
  approvalStatus: "UNAPPROVED",
  postingStatus: "UNPOSTED",
  postingMode: "CASHBOOK",
  reviewState: "PENDING",
  reviewReason: null,
  approvalVersion: 3,
  postingVersion: 4,
  reviewVersion: 5,
  systemSource: null,
  flowKind: null,
  birthState: "COMMITTED",
  capabilities: {
    forfeitPair: false,
    forfeitAllowed: false,
    engineBlocked: false,
    manual: true,
    legacyCancelAllowed: true,
    compatCancelOwner: true,
    birthPrior: true,
    requiresRealAccount: false,
    reservationMoneyBlocked: false,
    reservationRefundReverseAllowed: false,
  },
  permissions: { approve: true, edit: true, cancel: false, reverse: false },
};
const batch: ActionSnapshotBatch = {
  actorId: "u",
  organizationId: "o",
  isAdmin: false,
  authorizationVersion: 1,
  routes: {
    readSemantics: "CANONICAL",
    workflow: "CANONICAL",
    posting: "CANONICAL",
    access: "CANONICAL",
    accountingStandardStrict: true,
  },
  rows: { v: row },
  unavailable: {},
};
const handlers = {
  approveOnly: true,
  cancel: true,
  edit: true,
  supplement: true,
  unapprove: true,
  requestChanges: true,
};
const build = (
  eligibility: Parameters<
    typeof buildIncomeExpenseActionContext
  >[0]["cancellation"],
  data = batch,
) =>
  buildIncomeExpenseActionContext({
    id: "v",
    snapshot: ready(data),
    cashbooks: ready([]),
    cancellation: eligibility,
    handlers,
  });
describe("strict shared action context", () => {
  it.each(["loading", "error"] as const)(
    "blocks cancel on %s eligibility",
    (state) => {
      const c = build(
        state === "loading" ? { state } : { state, reason: "network" },
      );
      expect(decideIncomeExpenseActions(c).cancel.enabled).toBe(false);
    },
  );
  it("uses legacy edit authority for the explicit strict-mode fallback", () => {
    const c = build(
      ready({
        income: {},
        flex: { v: { id: "v", eligible: false, reason_code: "STRICT_MODE" } },
      }),
    );
    expect(decideIncomeExpenseActions(c).cancel.enabled).toBe(true);
  });
  it("does not convert an absent result into an eligible cancel", () => {
    expect(
      decideIncomeExpenseActions(build(ready({ income: {}, flex: {} }))).cancel
        .enabled,
    ).toBe(false);
  });
  it("does not infer editable payload from source-null canonical ownership", () => {
    const c = build(ready({ income: {}, flex: {} }), {
      ...batch,
      rows: { v: { ...row, flowKind: "CANONICAL_INCOME_EXPENSE" } },
    });
    expect(decideIncomeExpenseActions(c).edit.enabled).toBe(false);
  });
  it("rejects malformed, duplicate and unrequested eligibility rows", () => {
    expect(() =>
      parseCancellationEligibility(
        [{ id: "v", eligible: "yes" }],
        ["v"],
        "flex",
      ),
    ).toThrow();
    expect(() =>
      parseCancellationEligibility(
        [
          { id: "v", eligible: true, reason_code: null },
          { id: "v", eligible: true, reason_code: null },
        ],
        ["v"],
        "flex",
      ),
    ).toThrow();
    expect(() =>
      parseCancellationEligibility(
        [{ id: "other", eligible: true, reason_code: null }],
        ["v"],
        "flex",
      ),
    ).toThrow();
  });
});

describe('reservation refund specialized context', () => {
 const cap={settlementId:'s',sourceVoucherId:'source',basisFingerprint:'basis',remaining:123,basisValid:true,current:true,fullRemaining:true};
 function actions(patch:Partial<IncomeExpenseActionSnapshot>={}, capability:unknown=cap,routes=batch.routes){
  const v={...row,systemSource:'reservation.refund',...patch,capabilities:{...row.capabilities,manual:false,reservationMoneyBlocked:true,reservationRefundReverseAllowed:true,reservationRefund:capability,...patch.capabilities}};
  return decideIncomeExpenseActions(buildIncomeExpenseActionContext({id:'v',snapshot:ready({...batch,routes,rows:{v}}) as never,cashbooks:ready([{id:'book',organizationId:'o',name:'Cash',isVirtual:false}]),cancellation:ready({income:{},flex:{}}),handlers:{...handlers,approveAndPost:true,post:true,reverse:true,resubmitReview:true,legacyApprove:true,editRecipient:true}}));
 }
 it('permits only the validated refund pending review/approval actions',()=>{
  const a=actions();expect(a.approveOnly.enabled).toBe(true);expect(a.approveAndPost.enabled).toBe(true);expect(a.requestChanges.enabled).toBe(true);
  for(const key of ['cancel','edit','editRecipient','legacyApprove','unapprove'] as const) expect(a[key].enabled).toBe(false);
 });
 it.each([undefined,null,{...cap,basisValid:false},{...cap,current:false},{...cap,fullRemaining:false}])('fails closed without a current full source proof %j',(c)=>{const a=actions({},c===undefined?null:c);expect(a.approveOnly.enabled).toBe(false);expect(a.requestChanges.enabled).toBe(false)});
 it('resubmits same voucher and never approves changes requested',()=>{const a=actions({reviewState:'CHANGES_REQUESTED'});expect(a.resubmitReview.enabled).toBe(true);expect(a.approveOnly.enabled).toBe(false);expect(a.approveAndPost.enabled).toBe(false)});
 it('requires all CAS and both routes for specialized money actions',()=>{
  expect(actions({reviewVersion:null}).approveOnly.enabled).toBe(false);
  expect(actions({approvalStatus:'APPROVED'},cap,{...batch.routes,workflow:'LEGACY'}).post.enabled).toBe(false);
 });
 it('post only needs custody, reverse needs its permission and exact custody',()=>{
  expect(actions({approvalStatus:'APPROVED',permissions:{approve:false,edit:false,cancel:false,reverse:false}}).post.enabled).toBe(true);
  expect(actions({approvalStatus:'APPROVED',postingStatus:'POSTED',accountId:'book',activePostingId:'p',permissions:{...row.permissions,reverse:true}},{...cap,remaining:0,fullRemaining:false}).reverse.enabled).toBe(true);
  expect(actions({approvalStatus:'APPROVED',postingStatus:'POSTED',accountId:'book',activePostingId:'p'},null).reverse.enabled).toBe(false);
 });
 it('does not grant OFFSET/REVENUE or owned source access',()=>{
  expect(actions({systemSource:'reservation.offset'}).approveOnly.enabled).toBe(false);
  expect(actions({flowKind:'RESERVATION'}).requestChanges.enabled).toBe(false);
 });
});
