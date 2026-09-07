import type { CustomerFixtureAttestation, GoldenScenario } from './copilot-golden-browser-evidence.mjs';
export const CUSTOMER_CASES: Record<string,string>;
export interface CustomerRow { customer_id:string;customer_name:string;phone:string;contract_id:string;contract_number:string;contract_status:string;room_id:string;room_name:string;building_id:string;building_name:string;is_representative:boolean }
export interface CustomerFixture {
  prompt:string;query:string;contextId:string;actorDigest:string;payload:CustomerRow[];ownedCustomerId?:string;bindingDigest:string;attestation:CustomerFixtureAttestation;
}
export function customerQuery(caseId:string,contextId:string):string;
export function bindCustomerScenario(scenario:GoldenScenario,input:{query:string;contextId:string;actorDigest:string;payload:unknown;ownedCustomerId?:string}):CustomerFixture;
