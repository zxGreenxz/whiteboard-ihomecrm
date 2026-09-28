import type { Session } from '@supabase/supabase-js';

/** TEST-only configuration. Values must never be logged or serialized to artifacts. */
export interface VoucherReadTestConnection {
  cred: {
    pat: string;
    prodDbPassword: string;
    testRef: string;
    testDbPassword: string;
    testPat: string | null;
    testSecretKey: string;
    testPublishableKey: string;
    testPoolerHost: string | null;
    passwordSeed: string;
  };
  test: string;
  url: string;
}

export const ORIGINAL_VOUCHER_ID: '5af4bc29-6111-4d49-865b-b6894a4d9131';
export const RPC: 'read_income_expense_details_v1';
export function testConnection(): Promise<VoucherReadTestConnection>;
export function signInTest(context: VoucherReadTestConnection, email: string, password: string): Promise<Session>;
export function originalTestSession(context: VoucherReadTestConnection): Promise<Session>;
export function request<T = unknown>(context: VoucherReadTestConnection, jwt: string, path: string, body?: unknown, profile?: string): Promise<{
  status: number;
  ok: boolean;
  json: T;
  ms: number;
}>;
export function runHarness(options?: { baseline?: boolean }): Promise<{ passed: number; report: string }>;
