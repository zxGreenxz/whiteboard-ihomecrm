// Ghi tay mã hồ sơ đã nộp.
//
// VÌ SAO CẦN: extension chỉ bắt được mã của những lượt nộp diễn ra khi nó đang
// bật. Hồ sơ nộp trước khi có tính năng này, nộp trên máy khác, hay nộp lúc
// extension tắt thì mã vẫn nằm trên cổng — dán vào đây là hồ sơ khách có dấu.
import { useState } from 'react';
import { ClipboardPaste } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { maHoSoHopLe } from '@/lib/residenceRegistrations';

export interface RegistrationManualEntryProps {
  dangGhi?: boolean;
  onGhi: (submCode: string) => void;
}

export default function RegistrationManualEntry({ dangGhi, onGhi }: RegistrationManualEntryProps) {
  const [mo, setMo] = useState(false);
  const [ma, setMa] = useState('');
  const hopLe = maHoSoHopLe(ma.trim());

  if (!mo) {
    return (
      <Button type="button" size="sm" variant="ghost" className="h-9 text-xs" onClick={() => setMo(true)}>
        <ClipboardPaste className="h-3.5 w-3.5" /> Ghi mã hồ sơ đã nộp
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input aria-label="Mã hồ sơ đã nộp" value={ma} placeholder="G01.899.909-260916-890028"
        onChange={(e) => setMa(e.target.value)} disabled={dangGhi}
        className="h-9 w-64 rounded-md border border-input bg-background px-2 font-mono text-sm disabled:opacity-50" />
      <Button type="button" size="sm" disabled={!hopLe || dangGhi}
        onClick={() => { onGhi(ma.trim()); setMa(''); setMo(false); }}>Lưu</Button>
      <Button type="button" size="sm" variant="ghost" disabled={dangGhi}
        onClick={() => { setMa(''); setMo(false); }}>Huỷ</Button>
      {ma.trim() && !hopLe && <span className="text-xs text-amber-600">Mã hồ sơ trông không đúng dạng.</span>}
    </div>
  );
}
