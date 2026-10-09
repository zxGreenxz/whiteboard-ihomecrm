import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { buildGmailScript, GMAIL_BANK_DOMAINS, gmailLabelQuery, gmailSearchQuery } from '@/lib/bank-events/gmailScript';

/** Script chứa khóa nguồn: chỉ sống trong hộp thoại này, không lưu vào storage hay cache truy vấn. */
export function GmailSetup({ name, token, ingestUrl, onClose }: { name: string; token: string; ingestUrl: string | null; onClose: () => void }) {
  const [includeBanks, setIncludeBanks] = useState(true);
  const [label, setLabel] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const query = gmailSearchQuery({ label, includeBanks });
  const script = ingestUrl && query ? buildGmailScript({ ingestUrl, token, label, includeBanks }) : null;
  const problem = label.trim() && gmailLabelQuery(label) === null
    ? 'Nhãn chỉ gồm chữ, số, khoảng trắng và - _ /, tối đa 60 ký tự.'
    : !query ? 'Chọn email ngân hàng hoặc nhập một nhãn Gmail.' : null;

  return <>
    <DialogHeader className="pr-6">
      <DialogTitle>Kết nối Gmail · {name}</DialogTitle>
      <DialogDescription>Script chứa khóa kết nối và chỉ hiển thị lần này. Dán vào Apps Script của Gmail nhận email ngân hàng trước khi đóng.</DialogDescription>
    </DialogHeader>
    <div className="space-y-4 rounded-lg border p-4">
      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1 h-4 w-4" checked={includeBanks} onChange={event => setIncludeBanks(event.target.checked)} />
        <span><span className="font-medium">Email từ các ngân hàng</span><span className="mt-0.5 block text-xs text-muted-foreground">ACB, Vietcombank, Techcombank, MB, VPBank, BIDV, VietinBank, TPBank… ({GMAIL_BANK_DOMAINS.length} tên miền)</span></span>
      </label>
      <div>
        <Label htmlFor="gmail-label">Nhãn Gmail tự gắn (không bắt buộc)</Label>
        <Input id="gmail-label" className="mt-1.5" value={label} onChange={event => setLabel(event.target.value)} placeholder="Ví dụ: CRM" maxLength={60} />
        <p className="mt-1 text-xs text-muted-foreground">Tạo bộ lọc trong Gmail gắn nhãn này cho những email bạn muốn chuyển về CRM.</p>
      </div>
      {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
    </div>
    <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-6">
      <li>Mở <a href="https://script.google.com/" target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-2">script.google.com</a> bằng đúng tài khoản Gmail nhận email ngân hàng, bấm <strong>Dự án mới</strong>.</li>
      <li>Xoá đoạn mã có sẵn, dán toàn bộ script bên dưới rồi bấm <strong>Lưu</strong>.</li>
      <li>Ở thanh trên chọn hàm <code className="rounded bg-muted px-1">caiDat</code> rồi bấm <strong>Chạy</strong>.</li>
      <li>Google hỏi quyền: <strong>Xem xét quyền</strong> → chọn tài khoản → <strong>Nâng cao</strong> → <strong>Đi tới dự án (không an toàn)</strong> → <strong>Cho phép</strong>. Đây là script của chính bạn. Google ghi quyền “đọc, soạn, gửi và xoá email” vì mọi script dùng Gmail đều phải xin quyền đầy đủ; script này chỉ đọc thư và gửi email ngân hàng về CRM, bạn xem được toàn bộ mã ở trên.</li>
      <li>Quay lại tab Nguồn kết nối: trong vài phút nguồn này hiện “Script đã kết nối”.</li>
    </ol>
    <p className="text-xs leading-5 text-muted-foreground">Ban ngày quét 1 phút/lần; 00:30–06:30 quét 10 phút/lần. Google cho script chạy 90 phút mỗi ngày: nếu đã dùng quá 60 phút thì script tự giãn 5 phút/lần tới hết ngày.</p>
    <Label htmlFor="gmail-script">Script Apps Script</Label>
    {script
      ? <textarea id="gmail-script" readOnly spellCheck={false} value={script} className="h-40 w-full resize-y rounded-md border bg-muted p-3 font-mono text-xs" />
      : <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{ingestUrl ? 'Hoàn tất lựa chọn ở trên để tạo script.' : 'Chưa cấu hình địa chỉ nhận. Kiểm tra tab Vận hành.'}</p>}
    {copyError && <p role="alert" className="text-sm text-destructive">Không truy cập được clipboard. Hãy chọn toàn bộ script và sao chép trực tiếp.</p>}
    <Button disabled={!script} onClick={() => { if (script) void navigator.clipboard.writeText(script).then(() => { setCopied(script); setCopyError(false); }).catch(() => setCopyError(true)); }}>
      {script && copied === script ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}{script && copied === script ? 'Đã sao chép script' : 'Sao chép script'}
    </Button>
    <Button variant="outline" onClick={onClose}>Tôi đã dán script · Đóng</Button>
  </>;
}
