/** Payment evidence chooses a kind; only the current page's configured wallets choose an ID. */
export type PaymentKind = 'bank' | 'cash' | 'sp_card' | 'credit_card';
export type BillPayment = 'bank_transfer' | 'cash' | null;

export interface PaymentWalletCandidate {
  id: string;
  kind: string;
  accountId?: string | null;
  hidden?: boolean;
  isPreferred?: boolean;
}

export interface PaymentEvidence {
  /** Only text typed by the user or their voice transcript, never OCR/model-generated text. */
  userText?: string | null;
  billPayment?: BillPayment;
  platform?: 'shopee' | null;
  merchant?: string | null;
}

const plain = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
const shopee = (text: string): boolean => /\b(?:shopee|spaylater)\b|\bthe\s+sp\b/.test(plain(text));

/** A printed card logo or a recipient bank never authorizes guessing a credit-card wallet. */
export function inferPaymentKind(evidence: PaymentEvidence): PaymentKind | null {
  const userText = (evidence.userText ?? '').normalize('NFC').toLowerCase();
  if (evidence.platform === 'shopee' || shopee(userText) || shopee(evidence.merchant ?? '')) return 'sp_card';
  const affirmative = userText.replace(/(?:không|chưa|ko)\s+(?:(?:dùng|sử dụng|quẹt|trả|thanh toán|bằng|qua)\s+)*thẻ(?:\s+tín dụng)?/giu, '');
  if (/(?:^|[^a-zà-ỹđ])thẻ(?:$|[^a-zà-ỹđ])/iu.test(affirmative) || /\b(?:the tin dung|(?:dung|quet|bang|qua) the)\b/.test(plain(affirmative))) return 'credit_card';
  const text = plain(userText);
  if (/\btien mat\b|\bcash\b/.test(text)) return 'cash';
  if (/\b(?:chuyen khoan|ck|bank transfer)\b/.test(text)) return 'bank';
  if (evidence.billPayment === 'bank_transfer') return 'bank';
  if (evidence.billPayment === 'cash') return 'cash';
  return null;
}

export function selectPaymentWallet(evidence: PaymentEvidence, wallets: readonly PaymentWalletCandidate[]): {
  kind: PaymentKind | null;
  wallet: PaymentWalletCandidate | null;
} {
  const kind = inferPaymentKind(evidence);
  const eligible = kind ? wallets.filter(wallet => !wallet.hidden && wallet.kind === kind) : [];
  const preferred = eligible.filter(wallet => wallet.isPreferred);
  const wallet = preferred.length === 1 ? preferred[0] : preferred.length === 0 && eligible.length === 1 ? eligible[0] : null;
  return { kind, wallet };
}
