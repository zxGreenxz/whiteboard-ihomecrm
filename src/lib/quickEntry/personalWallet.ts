import type { Wallet } from '@/lib/personalFinance/contract';

export type PersonalWalletRef = Pick<Wallet, 'id' | 'name' | 'kind' | 'hidden' | 'is_default'>;
export type WalletReason = 'manual' | 'explicit' | 'platform' | 'bank_transfer' | 'cash_default' | 'unresolved';
export interface WalletResolution { walletId: string | null; reason: WalletReason }
export interface WalletEvidence { payment_method?: 'cash' | 'bank_transfer' | null; platform?: 'shopee' | 'grab' | null }

export function normalizeWalletText(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
}
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text: string, name: string) => !!name && new RegExp(`(?:^|[^a-z0-9])${escaped(name)}(?=$|[^a-z0-9])`).test(text);
const platformPattern = '\\b(?:shopee(?:\\s*(?:food|pay))?|grab(?:\\s*(?:food|express|bike|car|mart|taxi|rent|delivery))?)\\b';
// "không (trả bằng|phải thanh toán|đi…) X": up to three verbs/fillers may sit between the negation and X.
const negation = '\\b(?:khong|chua|chang)\\s+(?:(?:di|phai|dung|mua|dat|goi|thanh toan|su dung|tra|bang|qua|la|duoc)\\s+){0,3}';
const negatedPlatform = new RegExp(`${negation}${platformPattern}`);
const clauses = (text:string) => text.normalize('NFC').split(/[,;.!?]|\bnhưng\b|\bnhung\b/i);
const affirmativeSource = (text:string) => clauses(text).filter(clause => !negatedPlatform.test(normalizeWalletText(clause))).join('; ');
// Only the negated phrase is dropped: "Shopee 100k không phải Grab" still names Shopee.
const affirmativeText = (text:string) => normalizeWalletText(clauses(text).join('; '))
  .replace(new RegExp(`${negation}${platformPattern}`, 'g'), ' ')
  .replace(new RegExp(`${negation}(?:tien mat|cash|chuyen khoan|bank transfer)\\b`, 'g'), ' ');
// A one-word name without digits ("Nhà", "Xe") is also an ordinary word: it needs a lead such as "ví Nhà".
const walletLead = '(?:vi|the|tk|tai khoan|bang|tu|qua)\\s+';
const namesWallet = (text: string, name: string) => /\s|\d/.test(name) ? mentions(text, name)
  : !!name && new RegExp(`(?:^|[^a-z0-9])${walletLead}${escaped(name)}(?=$|[^a-z0-9])`).test(text);
export function platformFromText(text:string): WalletEvidence['platform'] {
  const normalized=affirmativeText(text);
  if (/\bshopee(?:\s*(?:food|pay))?\b/.test(normalized)) return 'shopee';
  if (/\bgrab(?:\s*(?:food|express|bike|car|mart|taxi|rent|delivery))?\b/.test(normalized)) return 'grab';
  return null;
}
/** A default of another kind cannot silently change the payment method. */
export function defaultPersonalWallet(wallets: readonly PersonalWalletRef[], kind: 'cash' | 'bank' = 'cash'): string | null {
  const visible = wallets.filter(wallet => !wallet.hidden && wallet.kind === kind);
  return (visible.find(wallet => wallet.is_default) ?? visible[0])?.id ?? null;
}

export function resolvePersonalWallet(input: {
  wallets: readonly PersonalWalletRef[];
  text?: string;
  evidence?: WalletEvidence;
  existingWalletId?: string | null;
  manual?: boolean;
}): WalletResolution {
  if (input.manual) return {walletId: input.existingWalletId ?? null, reason:'manual'};
  // Ignore negative clauses, but keep a later affirmative clause ("không đi Grab, mua Shopee").
  const rawText = input.text ?? '';
  const text = affirmativeText(rawText);
  const explicit = input.wallets.filter(wallet => namesWallet(text, normalizeWalletText(wallet.name)));
  if (explicit.length) {
    const [only] = explicit;
    return explicit.length === 1 && only && !only.hidden ? {walletId:only.id, reason:'explicit'} : {walletId:null,reason:'unresolved'};
  }
  const namedWallet = /(?:^|[\s,;])(?:ví|vi)\s*[:=]?\s+\S/i.test(affirmativeSource(rawText));
  if (namedWallet && !/\bvi\s+(?:tien mat|cash|chuyen khoan)\b/.test(text)) return {walletId:null,reason:'unresolved'};
  const method = /\b(?:tien mat|cash)\b/.test(text) ? 'cash' : /\b(?:chuyen khoan|bank transfer)\b/.test(text) ? 'bank' : null;
  if (method) {
    const walletId = defaultPersonalWallet(input.wallets, method);
    return {walletId,reason:walletId ? 'explicit' : 'unresolved'};
  }
  const negativePlatform = !platformFromText(rawText) && new RegExp(platformPattern).test(normalizeWalletText(rawText));
  const platform = platformFromText(rawText) || (!negativePlatform && input.evidence?.platform);
  if (platform) {
    const candidates = input.wallets.filter(wallet => normalizeWalletText(wallet.name) === 'the sp');
    const [only] = candidates;
    return candidates.length === 1 && only && !only.hidden
      ? {walletId:only.id,reason:'platform'} : {walletId:null,reason:'unresolved'};
  }
  const bank = input.evidence?.payment_method === 'bank_transfer';
  const walletId = defaultPersonalWallet(input.wallets, bank ? 'bank' : 'cash');
  return {walletId,reason:walletId ? bank ? 'bank_transfer' : 'cash_default' : 'unresolved'};
}
