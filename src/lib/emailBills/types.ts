export type BillProvider = 'grab' | 'shopee';
export interface EmailBillSource { provider: BillProvider; mailbox: string; message_id: string; receipt_id: string }
export interface EmailBill { source: EmailBillSource; subject: string; description: string; date: string | null; amount: number | null; text: string; warnings: string[]; blocked: boolean }
export interface GmailSession { accessToken: string; expiresAt: number }
export interface GmailBillPage { bills: EmailBill[]; nextPageToken: string | null; failedCount: number }
export interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailMessagePart[];
}
export interface GmailMessage { id: string; payload?: GmailMessagePart }
