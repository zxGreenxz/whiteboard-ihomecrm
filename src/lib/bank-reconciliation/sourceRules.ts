/** Routing policy for the local demo. Sender identity is a routing signal, not payment authorization. */
export type SourceChannel = 'sms' | 'notification' | 'gmail';
export interface DemoSource { id: string; name: string; org: string; kind: 'android' | 'gmail' }
export interface SourceMessage {
  id: string; org: string; sourceId: string; channel: SourceChannel;
  sender: string; packageName: string; title: string; body: string;
}
export interface SourceRule {
  id: string; org: string; name: string; sourceId: string; channel: SourceChannel;
  identity: string; textIncludes: string; accountToken: string; bookId: string; enabled: boolean;
}
export interface RoutingResult {
  status: 'resolved' | 'unmatched' | 'conflict'; bookId: string | null;
  ruleIds: string[]; reasons: string[];
}
export const channelLabels: Record<SourceChannel, string> = { sms: 'SMS', notification: 'Thông báo app', gmail: 'Gmail' };
export const identityLabels: Record<SourceChannel, string> = { sms: 'Người gửi SMS (sender)', notification: 'Mã ứng dụng (packageName)', gmail: 'Địa chỉ email gửi (From)' };
const canonical = (s: string) => s.trim().toLowerCase();
const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
export function emailAddress(raw: string): string {
  const value = raw.trim();
  const bracket = value.match(/^[^<>\r\n]*<([^<>\r\n]+)>$/);
  const address = canonical(bracket?.[1] ?? value);
  return emailPattern.test(address) ? address : '';
}
export function validateSourceRule(rule: SourceRule, sources: DemoSource[], bookIds: string[]): string[] {
  const errors: string[] = [];
  const source = sources.find(s => s.id === rule.sourceId && s.org === rule.org);
  if (!rule.name.trim()) errors.push('Nhập tên quy tắc.');
  if (!source) errors.push('Chọn nguồn kết nối trong công ty.');
  if (source && (source.kind === 'gmail') !== (rule.channel === 'gmail')) errors.push('Loại tin không phù hợp nguồn kết nối.');
  if (!bookIds.includes(rule.bookId)) errors.push('Chọn sổ ngân hàng đích.');
  if (!rule.identity.trim()) errors.push(`Nhập ${identityLabels[rule.channel].toLowerCase()}.`);
  if (rule.channel === 'notification' && !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+$/.test(rule.identity.trim())) errors.push('Dùng mã ứng dụng như com.mbbmobile, không dùng tên hiển thị MB Bank.');
  if (rule.channel === 'gmail' && !emailPattern.test(rule.identity.trim())) errors.push('Nhập một địa chỉ email đầy đủ, không dùng tên hiển thị hoặc tên miền đơn lẻ.');
  if (/[\r\n]/.test(rule.identity)) errors.push('Thông tin người gửi phải nằm trên một dòng.');
  if (rule.accountToken && !/^[a-zA-Z0-9*•]+$/.test(rule.accountToken.trim())) errors.push('Dấu tài khoản chỉ gồm chữ, số hoặc ký tự che * / •.');
  return errors;
}
export function ruleMatches(rule: SourceRule, message: SourceMessage): boolean {
  if (!rule.enabled || !rule.identity.trim() || rule.org !== message.org || rule.sourceId !== message.sourceId || rule.channel !== message.channel) return false;
  const identity = message.channel === 'notification' ? message.packageName : message.channel === 'gmail' ? emailAddress(message.sender) : message.sender;
  if (!identity || canonical(identity) !== canonical(rule.identity)) return false;
  const text = canonical(`${message.title}\n${message.body}`);
  if (rule.textIncludes.trim() && !text.includes(canonical(rule.textIncludes))) return false;
  if (rule.accountToken.trim()) {
    // Compare a whole literal token. "979" cannot accidentally match account "19790".
    const tokens = canonical(message.body).split(/[^a-z0-9*•]+/).filter(Boolean);
    if (!tokens.includes(canonical(rule.accountToken))) return false;
  }
  return true;
}
export function resolveSourceMessages(messages: SourceMessage[], rules: SourceRule[], org: string): RoutingResult {
  const matches = rules.filter(r => r.org === org && messages.some(m => m.org === org && ruleMatches(r, m)));
  const bookIds = [...new Set(matches.map(r => r.bookId))];
  if (!bookIds.length) return { status: 'unmatched', bookId: null, ruleIds: [], reasons: ['Chưa có quy tắc đang bật khớp nguồn và người gửi. Cần cấu hình sổ nhận.'] };
  if (bookIds.length > 1) return { status: 'conflict', bookId: null, ruleIds: matches.map(r => r.id), reasons: ['Có quy tắc hoặc tin báo cùng khoản chỉ sang nhiều sổ khác nhau. Cần sửa cấu hình trước khi khớp hóa đơn.', ...matches.map(r => r.name)] };
  return { status: 'resolved', bookId: bookIds[0]!, ruleIds: matches.map(r => r.id), reasons: matches.map(r => `${r.name} · ${channelLabels[r.channel]} · ${r.identity}${r.textIncludes.trim() ? ` · nội dung có “${r.textIncludes.trim()}”` : ''}${r.accountToken.trim() ? ` · tài khoản ${r.accountToken.trim()}` : ''}`) };
}
