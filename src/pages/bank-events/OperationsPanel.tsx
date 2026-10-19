import { useState } from 'react';
import { Check, Copy, CopyCheck, Download, Inbox, Lock, Mail, ScanText, ShieldCheck, Smartphone, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { BankStatus } from '@/lib/bank-events/service';
import { intakeState, vnStamp } from '@/lib/bank-events/view';
import { cn } from '@/lib/utils';
import { gatewayApk } from './labels';
import { LiveDot } from './parts';

const mono = 'font-numeric tabular-nums';
const pipeline: [LucideIcon, string, string][] = [
  [Smartphone, 'Điện thoại · Gmail', 'SMS, thông báo app và email ngân hàng'],
  [ShieldCheck, 'Xác thực nguồn', 'Mỗi nguồn một khóa riêng'],
  [CopyCheck, 'Chống ghi trùng', 'Tin gửi lặp chỉ được đếm'],
  [Lock, 'Mã hóa', 'Nội dung nguyên văn không rời máy chủ'],
  [ScanText, 'Tách số tiền', 'Chiều tiền, số tiền, số dư, nội dung'],
  [Inbox, 'Hộp tiếp nhận', 'Chỉ super admin xem'],
];
const phoneSteps = [
  'Cài iHome Gateway trên điện thoại Android 8 trở lên.',
  'Thêm nguồn loại Điện thoại Android, sao chép địa chỉ webhook và khóa vào app.',
  'Bật chuyển thông báo và chọn app ngân hàng, không chỉ SMS.',
  'Gửi tin thử rồi làm mới trang để xác nhận nguồn nhận đúng.',
];
const gmailRules = [
  'Lấy email từ các ngân hàng và email có nhãn bạn chọn.',
  'Ban ngày quét 1 phút/lần; 00:30–06:30 quét 10 phút/lần.',
  'Google cho 90 phút chạy mỗi ngày: dùng quá 60 phút thì tự giãn 5 phút/lần tới hết ngày.',
];
const card = (phone: boolean) => cn('border bg-card shadow-sm', phone ? 'rounded-2xl px-4 py-3.5' : 'rounded-xl px-6 py-[22px]');
const iconTile = 'grid shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400';

function IntakeChip({ status, failed, small }: { status: BankStatus | undefined; failed: boolean; small?: boolean }) {
  const state = intakeState(status, failed);
  return <span className={cn('inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full font-semibold', small ? 'h-6 px-[9px] text-[11.5px]' : 'h-[26px] px-2.5 text-xs',
    state.live ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' : 'bg-muted text-muted-foreground')}><LiveDot paused={!state.live} />{state.label}</span>;
}

function ScheduleBar({ phone }: { phone: boolean }) {
  return <div className={phone ? 'mt-3' : 'mt-4'}>
    {!phone && <div className="flex justify-between text-[11.5px] font-medium text-muted-foreground"><span>Nhịp quét trong ngày</span><span>Google cho 90 phút chạy mỗi ngày</span></div>}
    <div aria-hidden className={cn('flex overflow-hidden rounded-[7px] text-[11px] font-semibold', phone ? 'h-[26px]' : 'mt-1.5 h-7')}>
      <div className="w-[2.1%] bg-emerald-100 dark:bg-emerald-900/50" />
      <div className="grid w-[25%] place-items-center whitespace-nowrap bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">{phone ? '10 phút' : '10 phút/lần'}</div>
      <div className="grid flex-1 place-items-center bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">1 phút/lần</div>
    </div>
    <div aria-hidden className={cn(mono, 'relative mt-1 h-3.5 text-[10.5px] text-muted-foreground/80')}>
      <span className="absolute left-0">00:00</span><span className={cn('absolute', phone ? 'left-[23%]' : 'left-[27.1%]')}>06:30</span><span className="absolute right-0">24:00</span>
    </div>
  </div>;
}

export function OperationsPanel({ phone, status, failed }: { phone: boolean; status: BankStatus | undefined; failed: boolean }) {
  const [copy, setCopy] = useState<'idle' | 'done' | 'error'>('idle');
  const url = status?.ingestUrl ?? null;
  const copyUrl = () => { if (url) void navigator.clipboard?.writeText(url).then(() => setCopy('done')).catch(() => setCopy('error')); };
  const clock = status ? vnStamp(status.serverTime) : failed ? 'Chưa tải được' : '—';
  const urlBlock = url
    ? <code className={cn(mono, 'min-w-0 break-all rounded-md bg-muted', phone ? 'flex-1 rounded-lg px-2.5 py-2 text-[11.5px]' : 'px-2 py-1 text-[12.5px]')}>{url}</code>
    : <span className="text-[13px] text-muted-foreground">{failed ? 'Chưa tải được' : 'Chưa có địa chỉ nhận được xác nhận'}</span>;
  const copyButton = url && <Button variant="outline" size="sm" onClick={copyUrl} aria-label="Sao chép địa chỉ nhận" className={phone ? 'h-9 w-9 shrink-0 rounded-[9px] p-0' : 'h-7 px-2 text-xs'}>
    {copy === 'done' ? <Check className="h-[13px] w-[13px]" /> : <Copy className="h-[13px] w-[13px]" />}{!phone && <span className="ml-1">{copy === 'done' ? 'Đã chép' : 'Sao chép'}</span>}
  </Button>;
  const privacy = <div className={cn('flex gap-3 border bg-muted/40 text-muted-foreground', phone ? 'gap-2.5 rounded-[14px] px-3.5 py-3 text-xs leading-[18px]' : 'rounded-xl px-[18px] py-4 text-[13px] leading-[21px]')}>
    <Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
    <p><strong className="font-semibold text-foreground">Nội dung nguyên văn có thể chứa OTP và tin cá nhân.</strong> Chỉ super admin được xem trang tổng và mở chi tiết; danh sách chỉ hiện số tiền, số dư và nội dung đã tách. Không tự suy ra số dư hiện tại, không cộng các tin nhận được thành doanh thu. Android hoặc ứng dụng ngân hàng có thể ẩn một phần thông báo.</p>
  </div>;
  const gmail = <article className={card(phone)}>
    <div className="flex items-center gap-2.5"><span aria-hidden className={cn(iconTile, phone ? 'h-[30px] w-[30px]' : 'h-[34px] w-[34px] rounded-[9px]')}><Mail className="h-4 w-4" /></span><h2 className={phone ? 'text-sm font-semibold' : 'text-base font-semibold'}>Kết nối Gmail</h2></div>
    <p className={cn('text-muted-foreground', phone ? 'mt-2.5 text-[12.5px] leading-[19px]' : 'mt-3 text-[13px] leading-[21px]')}>Thêm nguồn loại Gmail rồi dán script vào Apps Script của tài khoản nhận email ngân hàng. Script chạy trên máy chủ Google bằng quyền của bạn; CRM không giữ mật khẩu Gmail.</p>
    <ScheduleBar phone={phone} />
    <ul className={cn('list-disc pl-[18px] text-muted-foreground', phone ? 'mt-2.5 text-[12.5px] leading-5' : 'mt-3.5 text-[13px] leading-[22px]')}>{gmailRules.map(rule => <li key={rule}>{rule}</li>)}</ul>
  </article>;
  const android = <article className={cn(card(phone), 'flex flex-col')}>
    <div className="flex items-center gap-2.5"><span aria-hidden className={cn(iconTile, phone ? 'h-[30px] w-[30px]' : 'h-[34px] w-[34px] rounded-[9px]')}><Smartphone className="h-4 w-4" /></span><h2 className={phone ? 'text-sm font-semibold' : 'text-base font-semibold'}>Kết nối điện thoại</h2></div>
    <ol className={cn('flex flex-col text-muted-foreground', phone ? 'mt-3 gap-2 text-[12.5px] leading-[19px]' : 'mt-3.5 gap-2.5 text-[13px] leading-5')}>
      {phoneSteps.map((step, index) => <li key={step} className="flex gap-2.5"><span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-bold text-foreground">{index + 1}</span><span>{step}</span></li>)}
    </ol>
    <div className="flex-1" />
    <Button variant="outline" asChild className={phone ? 'mt-3.5 h-[42px] w-full rounded-[11px] font-semibold' : 'mt-4 self-start'}>
      <a href={gatewayApk.url} target="_blank" rel="noopener noreferrer"><Download className="mr-2 h-4 w-4" />Tải app Android<span className="ml-1.5 text-xs font-normal text-muted-foreground">v{gatewayApk.version}</span></a>
    </Button>
  </article>;

  if (phone) return <div className="flex flex-col gap-3">
    <section className={card(true)}>
      <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">Trạng thái tiếp nhận</h2><IntakeChip status={status} failed={failed} small /></div>
      <dl className="mt-3 flex flex-col gap-2.5 text-[13px]">
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Đồng hồ máy chủ</dt><dd className={cn(mono, 'text-[12.5px]')}>{clock}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Tự cập nhật</dt><dd>15 giây/lần ở trang đầu</dd></div>
        <div><dt className="text-muted-foreground">Địa chỉ nhận</dt><dd className="mt-1.5 flex items-center gap-2">{urlBlock}{copyButton}</dd></div>
      </dl>
      {copy === 'error' && <p role="alert" className="mt-2 text-xs text-destructive">Không truy cập được clipboard. Hãy chọn và sao chép địa chỉ trực tiếp.</p>}
    </section>
    <section className={card(true)}>
      <h2 className="text-sm font-semibold">Luồng tiếp nhận</h2>
      <p className="mt-1.5 text-[12.5px] leading-[19px] text-muted-foreground">Điện thoại gửi SMS, thông báo được cấp quyền; script Gmail gửi email ngân hàng. Máy chủ xác thực nguồn, chống ghi trùng, mã hóa và tách số tiền để theo dõi.</p>
      <ol className="mt-3 flex flex-col">
        {pipeline.map(([Icon, title, text], index) => <li key={title} className="flex gap-3">
          <div className="flex flex-col items-center"><span aria-hidden className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-[9px]', index === pipeline.length - 1 ? 'bg-primary text-primary-foreground' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400')}><Icon className="h-4 w-4" /></span>{index < pipeline.length - 1 && <span aria-hidden className="min-h-2.5 w-px flex-1 bg-emerald-200 dark:bg-emerald-900" />}</div>
          <div className="pb-3 pt-[5px]"><p className="text-[13px] font-semibold">{title}</p><p className="mt-px text-xs text-muted-foreground">{text}</p></div>
        </li>)}
      </ol>
    </section>
    {gmail}{android}{privacy}
  </div>;

  return <div className="space-y-4">
    <section className={card(false)}>
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div><h2 className="text-[17px] font-semibold">Luồng tiếp nhận</h2><p className="mt-1.5 max-w-[680px] text-[13px] leading-5 text-muted-foreground">Điện thoại gửi SMS, thông báo được cấp quyền; script Gmail gửi email ngân hàng. Máy chủ xác thực nguồn, chống ghi trùng, mã hóa và tách số tiền để theo dõi.</p></div>
        <IntakeChip status={status} failed={failed} />
      </div>
      <ol className="mt-5 grid grid-cols-3 gap-y-5 lg:grid-cols-6">
        {pipeline.map(([Icon, title, text], index) => <li key={title} className="pr-[18px]">
          <div className="flex items-center gap-2"><span aria-hidden className={cn('grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px]', index === pipeline.length - 1 ? 'bg-primary text-primary-foreground' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400')}><Icon className="h-[18px] w-[18px]" /></span>{index < pipeline.length - 1 && <span aria-hidden className="h-px flex-1 bg-emerald-200 dark:bg-emerald-900" />}</div>
          <p className="mt-2.5 text-[13px] font-semibold">{title}</p><p className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{text}</p>
        </li>)}
      </ol>
      <dl className="mt-[22px] grid gap-6 border-t pt-[18px] md:grid-cols-[200px_minmax(0,1fr)_220px]">
        <div><dt className="text-xs text-muted-foreground">Đồng hồ máy chủ</dt><dd className={cn(mono, 'mt-1 text-[13px]')}>{clock}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Địa chỉ nhận</dt><dd className="mt-1 flex flex-wrap items-center gap-2">{urlBlock}{copyButton}</dd>{copy === 'error' && <dd role="alert" className="mt-1 text-xs text-destructive">Không truy cập được clipboard. Hãy chọn và sao chép địa chỉ trực tiếp.</dd>}</div>
        <div><dt className="text-xs text-muted-foreground">Tự cập nhật</dt><dd className="mt-1 text-[13px]">15 giây/lần ở trang đầu</dd></div>
      </dl>
    </section>
    <div className="grid gap-4 md:grid-cols-2">{gmail}{android}</div>
    {privacy}
  </div>;
}
