import type { GoldenScenario } from './copilot-golden-browser-evidence.mjs';
export type FinancialReadCaseId='C03'|'C05'|'C15'|'C17'|'C19'|'C24'|'C26';
export type FinancialRole='invoice'|'pnl'|'stats';
export type FinancialRpc='copilot_invoice_search_v1'|'copilot_financial_pnl_v1'|'copilot_invoice_stats_v1';
export interface FinancialRequest {rpc:FinancialRpc;args:Record<string,string|boolean>}
export interface InvoiceRow {id:string;invoice_number:string|null;billing_month:string;total_amount:number;status:string;building_id:string;building_name:string;room_id:string;room_name:string}
export interface PnlRow {month:string;building_id:string;building_name:string;is_virtual:boolean;revenue:number;expense:number;net:number}
export interface InvoiceStats {total_amount:number;total_paid:number;total_remaining:number;total_refunded:number;total_count:number;rent_amount:number;electric_amount:number;water_amount:number;pdv_amount:number;total_collected:number;payment_tm:number;payment_tk:number;payment_tt:number;payment_ct:number;change_amount:number;deposit_collected:number}
export interface FinancialRoleAttestation {rpc:FinancialRpc;argsDigest:string;responseDigest:string;factDigest:string;schemaDigest:string;rowCount:number;shape:'object'|'array';readiness:'empty'|'positive';basis?:'cash'|'accrual';responseKeyOrder?:string[]}
export interface FinancialReadAttestation {kind:'financial-read';organizationId:string;actorDigest:string;appOrigin:string;apiOrigin:string;roles:Partial<Record<FinancialRole,FinancialRoleAttestation>>}
export interface FinancialReadFixture {prompt:string;organizationId:string;actorDigest:string;appOrigin:string;apiOrigin:string;bindingDigest:string;attestation:FinancialReadAttestation;roles:{invoice?:{request:FinancialRequest;payload:InvoiceRow[]};pnl?:{request:FinancialRequest;payload:PnlRow[]};stats?:{request:FinancialRequest;payload:InvoiceStats}}}
export const FINANCIAL_READ_CASES:Record<FinancialReadCaseId,string>;
export function financialReadRequests(id:string):Partial<Record<FinancialRole,FinancialRequest>>;
export function bindFinancialReadScenario(scenario:GoldenScenario,input:unknown):FinancialReadFixture;
export function sameFinancialArgs(actual:unknown,expected:Record<string,unknown>):boolean;
export function financialRoleDigest(attestation:FinancialReadAttestation):string;
export function validFinancialReadAttestation(id:string,value:unknown,actorDigest:string):value is FinancialReadAttestation;
