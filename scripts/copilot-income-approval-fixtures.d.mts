import type { GoldenScenario, IncomeApprovalFixtureAttestation } from './copilot-golden-browser-evidence.mjs';
export const INCOME_APPROVAL_CASES: Record<string,string>;
export interface IncomeApprovalRequest {
  rpc:'copilot_income_expense_search_v1'|'copilot_pending_requests_v1'; args:Record<string,string|number|null>;
}
export interface VoucherRow {
  phieu_id:string; ma_phieu:string|null; loai:'INCOME'|'EXPENSE'; ten:string|null; so_tien:number; ngay:string;
  hang_muc:string|null; so_quy:string|null; trang_thai:'UNAPPROVED'|'APPROVED'|'CANCELLED';
  trang_thai_ghi_nhan:'UNPOSTED'|'POSTED'|'REVERSED'|'NOT_APPLICABLE'; nguoi_tao:string|null; toa_nha:string|null;
}
export interface PendingRow {
  yeu_cau_id:string; lan_gui:number; gui_luc:string|null; so_tien:number; phieu_id:string|null; ma_phieu:string|null;
  ten_phieu:string|null; loai:'INCOME'|'EXPENSE'; nguoi_lap:string; buoc:number;
}
export interface IncomeApprovalFixture {
  prompt:string; request:IncomeApprovalRequest; payload:{gioi_han:20;so_luong:number;phieu?:VoucherRow[];hop_cho?:PendingRow[]};
  dailyCashbook?:DailyCashbookBinding;
  actorDigest:string; bindingDigest:string; attestation:IncomeApprovalFixtureAttestation;
}
export function incomeApprovalRequest(caseId:string):IncomeApprovalRequest;
export function bindIncomeApprovalScenario(scenario:GoldenScenario,input:{request:IncomeApprovalRequest;payload:unknown;actorDigest:string;dailyCashbook?:{request:ReturnType<typeof dailyCashbookRequest>;payload:unknown}}):IncomeApprovalFixture;

export interface DailyCashbookPayload {
  gioi_han:20; so_luong:number; tu:string; den:string;
  tong_hop:{tong_thu:number;tong_chi:number;rong:number;so_ngay_co_phat_sinh:number;phieu_han_che_bi_loai:number};
  theo_ngay:{ngay:string;thu:number;chi:number;rong:number}[];
}
export interface DailyCashbookBinding {request:ReturnType<typeof dailyCashbookRequest>;payload:DailyCashbookPayload}
export function dailyCashbookRequest():{rpc:'copilot_report_daily_cashbook_v1';args:Record<string,string|number|null>};
export function validDailyCashbookBinding(value:unknown):value is DailyCashbookBinding;
