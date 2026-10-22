import { useEffect, useState } from 'react';
import QuickRoomBoard from './QuickRoomBoard';
import DisplaySettingsTab from './DisplaySettingsTab';
import MobileDisplaySettings from './mobile/MobileDisplaySettings';

/** Two editing layouts, one scoped inventory and the same canonical room writer. */
export default function SaleRoomWorkspace({ mobile = false, onBusyChange }: { mobile?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [view, setView] = useState<'quick' | 'sheet'>('quick');
  const [busy, setBusy] = useState(false);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2" role="group" aria-label="Cách cập nhật phòng">
      <button type="button" aria-pressed={view === 'quick'} disabled={busy} onClick={() => setView('quick')}
        className={`rounded-md border px-3 py-2 text-sm ${view === 'quick' ? 'bg-primary text-primary-foreground' : 'bg-background'}`}>Nhanh</button>
      <button type="button" aria-pressed={view === 'sheet'} disabled={busy} onClick={() => setView('sheet')}
        className={`rounded-md border px-3 py-2 text-sm ${view === 'sheet' ? 'bg-primary text-primary-foreground' : 'bg-background'}`}>Bảng Excel</button>
    </div>
    {view === 'quick' ? <QuickRoomBoard mobile={mobile} onBusyChange={setBusy} />
      : mobile ? <MobileDisplaySettings onBusyChange={setBusy} /> : <DisplaySettingsTab onBusyChange={setBusy} />}
  </div>;
}
