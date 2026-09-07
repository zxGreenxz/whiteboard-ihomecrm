import type { ContractFixtureAttestation, GoldenScenario } from './copilot-golden-browser-evidence.mjs';
export const CONTRACT_CASES: Record<string, string>;
export interface ContractFixture {
  prompt: string; query: string; contractId?: string; bindingDigest: string; attestation: ContractFixtureAttestation;
  searchPayload: unknown; detailPayload?: unknown; customerPayload?: unknown;
}
export function contractQuery(caseId: string, contextId: string, listingPayload?: unknown): string;
export function bindContractScenario(scenario: GoldenScenario, input: { query: string; searchPayload: unknown; detailPayload?: unknown; customerPayload?: unknown }): ContractFixture;
