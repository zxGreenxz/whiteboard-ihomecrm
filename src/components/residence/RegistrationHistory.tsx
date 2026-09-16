// Dấu "đã đăng ký tạm trú" của khách: lần nộp gần nhất hiện thẳng ra, các lần
// trước gấp lại thành lịch sử — nộp lại (gia hạn, bị trả rồi nộp bù) là chuyện thường.
import { useState } from 'react';
import { BadgeCheck, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { ngayVn, type ResidenceRegistration } from '@/lib/residenceRegistrations';

export interface RegistrationHistoryProps { registrations: ResidenceRegistration[] }

function dongMoTa(r: ResidenceRegistration): string {
  const han = r.temp_resident_to ? `hạn đến ${ngayVn(r.temp_resident_to)}` : '';
  const tu = r.temp_resident_from ? `từ ${ngayVn(r.temp_resident_from)}` : '';
  return [tu, han].filter(Boolean).join(' · ');
}

export default function RegistrationHistory({ registrations }: RegistrationHistoryProps) {
  const [moLichSu, setMoLichSu] = useState(false);
  const moiNhat = registrations[0];
  if (!moiNhat) return null;
  const cu = registrations.slice(1);

  const chep = (ma: string) => {
    navigator.clipboard?.writeText(ma).then(
      () => toast.success('Đã sao chép mã hồ sơ'),
      () => toast.error('Không sao chép được mã hồ sơ'),
    );
  };

  return (
    <div className="space-y-1 rounded-md border border-green-200 bg-green-50/60 p-2" aria-label="Đã đăng ký tạm trú">
      <p className="flex flex-wrap items-center gap-1.5 text-sm">
        <BadgeCheck className="h-4 w-4 text-green-600" />
        <span className="font-medium">Đã đăng ký tạm trú</span>
        <span className="font-mono text-xs">{moiNhat.subm_code}</span>
        <button type="button" aria-label="Sao chép mã hồ sơ" onClick={() => chep(moiNhat.subm_code)}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground">
          <Copy className="h-3.5 w-3.5" />
        </button>
      </p>
      <p className="text-xs text-muted-foreground">
        Nộp {ngayVn(moiNhat.submitted_at) || new Date(moiNhat.submitted_at).toLocaleDateString('vi-VN')}
        {dongMoTa(moiNhat) ? ` · ${dongMoTa(moiNhat)}` : ''}
        {moiNhat.receive_org ? ` · ${moiNhat.receive_org}` : ''}
      </p>
      {cu.length > 0 && (
        <>
          <button type="button" onClick={() => setMoLichSu(v => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={moLichSu}>
            {moLichSu ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {cu.length} lần nộp trước
          </button>
          {moLichSu && (
            <ul className="space-y-0.5 pl-4 text-xs text-muted-foreground" aria-label="Lịch sử đăng ký tạm trú">
              {cu.map(r => (
                <li key={r.id}>
                  <span className="font-mono">{r.subm_code}</span>
                  {' — nộp '}{new Date(r.submitted_at).toLocaleDateString('vi-VN')}
                  {dongMoTa(r) ? ` · ${dongMoTa(r)}` : ''}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
