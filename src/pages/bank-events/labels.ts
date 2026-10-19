import { Bell, FlaskConical, Mail, MessageSquare, type LucideIcon } from 'lucide-react';
import type { BankEvent } from '@/lib/bank-events/service';
import type { Flow } from '@/lib/bank-events/view';

export const eventLabels: Record<BankEvent['eventType'], string> = { 'sms.received': 'SMS', 'notification.received': 'Thông báo app', 'email.received': 'Email', 'gateway.test': 'Tin thử' };
export const eventIcons: Record<BankEvent['eventType'], LucideIcon> = { 'sms.received': MessageSquare, 'notification.received': Bell, 'email.received': Mail, 'gateway.test': FlaskConical };
export const scheduleLabels = { 'day-1m': '1 phút/lần (ban ngày)', 'night-10m': '10 phút/lần (00:30–06:30)', 'saver-5m': '5 phút/lần (tiết kiệm hạn mức)' } as const;
// APK release do CI ký trên main, đăng ở GitHub Release (repo public nên tải không cần đăng nhập). Bản mới: đăng release từ artifact ihome-bank-gateway-release-<sha> rồi đổi hằng này.
export const gatewayApk = { version: '0.2.0', url: 'https://github.com/zxGreenxz/whiteboard-ihomecrm/releases/download/v0.2.0/app-release.apk' } as const;

export const flowTone: Record<Flow, string> = {
  in: 'text-emerald-700 dark:text-emerald-400',
  out: 'text-red-600 dark:text-red-400',
  other: 'text-muted-foreground/70',
};
export const flowLabel: Record<Flow, string> = { in: 'Tiền vào', out: 'Tiền ra', other: 'Khác' };
