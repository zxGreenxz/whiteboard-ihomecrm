import { createHash } from 'node:crypto';

export const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
