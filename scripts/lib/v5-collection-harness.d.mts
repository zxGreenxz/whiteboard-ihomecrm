import type { SupabaseAdminConfig } from '../apply-accounting-rollout.mjs';
export const DEMO_ORG_ID: 'dddd0000-0000-4000-8000-000000000001';
export const DEMO_OWNER_EMAIL: 'demo.chunha@username.ihomecrm.local';
export function runQuery<Row extends object = Record<string, unknown>>(query: string, config?: SupabaseAdminConfig): Promise<Row[]>;
export function fixtureInvoiceSql(args: { marker: string; billingMonth: string; rent: number; deposit: number }): string;
export function committedFixtureTeardownSql(args: { marker: string; actorId: string }): string;
export function committedAdjustmentFixtureTeardownSql(args: { marker: string; actorId: string; invoiceId: string }): string;
export function fixtureMarker(runId: string): string;
export function newRunId(): string;
export function sqlLiteral(value: unknown): string;
/** Validates UUID syntax before returning a SQL literal. */
export function uuidLiteral(value: unknown): string;
