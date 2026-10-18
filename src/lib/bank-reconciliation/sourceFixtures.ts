import type { BankTransaction } from './demoModel';
import { channelLabels, type DemoSource, type SourceMessage, type SourceRule } from './sourceRules';

export const demoSources: DemoSource[] = [
  { id: 'src-an', name: 'Máy An Nhiên', org: 'DEMO', kind: 'android' },
  { id: 'src-binh', name: 'Máy Bình Minh', org: 'DEMO', kind: 'android' },
  { id: 'src-chung', name: 'Máy thu chung', org: 'DEMO', kind: 'android' },
  { id: 'src-mbdemo', name: 'MBDemo', org: 'DEMO', kind: 'android' },
  { id: 'src-mail', name: 'Gmail thu tiền DEMO', org: 'DEMO', kind: 'gmail' },
  { id: 'src-unknown', name: 'Máy chưa cấu hình', org: 'DEMO', kind: 'android' },
];
const accounts = [
  { bookId: 'demo-an', sourceId: 'src-an', sender: 'VCB-DEMO', packageName: 'com.demo.vcb', account: '8001' },
  { bookId: 'demo-binh', sourceId: 'src-binh', sender: 'TCB-DEMO', packageName: 'com.demo.tcb', account: '8002' },
  { bookId: 'demo-chung', sourceId: 'src-chung', sender: 'MB-DEMO', packageName: 'com.mbbmobile', account: '8003' },
  { bookId: 'demo-mbdemo', sourceId: 'src-mbdemo', sender: 'MB-DEMO', packageName: 'com.mbbmobile', account: '00xxx123' },
];
export function createSourceRules(): SourceRule[] {
  return accounts.flatMap(a => (['sms', 'notification', 'gmail'] as const).map(channel => ({
    id: `${a.bookId}-${channel}`, org: 'DEMO', name: `${a.bookId === 'demo-mbdemo' ? 'MBDemo' : demoSources.find(s => s.id === a.sourceId)!.name} · ${channelLabels[channel]}`,
    sourceId: channel === 'gmail' ? 'src-mail' : a.sourceId, channel,
    identity: channel === 'notification' ? a.packageName : channel === 'gmail' ? 'bank-alerts@example.test' : a.sender,
    textIncludes: '', accountToken: a.account, bookId: a.bookId, enabled: true,
  })));
}
export function messagesForTransaction(t: BankTransaction): SourceMessage[] {
  const account = accounts.find(a => a.bookId === t.book);
  return t.sources.map((label, index) => {
    const channel = label.startsWith('Gmail') ? 'gmail' : label.startsWith('Thông báo') ? 'notification' : 'sms';
    return { id: `${t.id}-message-${index + 1}`, org: t.org, sourceId: channel === 'gmail' ? 'src-mail' : account?.sourceId ?? 'src-unknown', channel,
      sender: channel === 'gmail' ? 'Ngân hàng DEMO <bank-alerts@example.test>' : account?.sender ?? 'BANK-DEMO', packageName: channel === 'notification' ? account?.packageName ?? 'com.demo.unknown' : '',
      title: channel === 'sms' ? '' : 'Thông báo biến động số dư', body: `TK ${account?.account ?? 'xxx000'} | GD: ${t.direction === 'in' ? '+' : '-'}${t.amount}VND | ND: ${t.description}`,
    };
  });
}
export const mbDemoSample: SourceMessage = { id: 'sample-mbdemo', org: 'DEMO', sourceId: 'src-mbdemo', channel: 'notification', sender: '', packageName: 'com.mbbmobile', title: 'Thông báo biến động số dư', body: 'TK 00xxx123|GD: +650,000VND 17/10/26 09:15 |ND: KHACH MAU MINH CHAU thanh toan' };
