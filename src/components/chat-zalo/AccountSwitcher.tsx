import { useState } from 'react';
import { ChevronsUpDown, Plug, PlugZap, Plus, RefreshCw, Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { avatarStyle, EMERALD } from './zaloTheme';
import type { ZaloAccount, AccountStatus } from './types';

const STATUS: Record<AccountStatus, { dot: string; label: string }> = {
  connected: { dot: 'hsl(142 71% 45%)', label: 'Đang kết nối' },
  connecting: { dot: 'hsl(38 92% 50%)', label: 'Đang đăng nhập…' },
  waiting_scan: { dot: 'hsl(38 92% 50%)', label: 'Chờ quét QR…' },
  disconnected: { dot: 'hsl(210 10% 60%)', label: 'Chưa kết nối' },
  error: { dot: 'hsl(0 84% 60%)', label: 'Lỗi kết nối' },
};

interface Props {
  accounts: ZaloAccount[];
  selectedId: string | null;       // null = tất cả
  onSelect: (id: string | null) => void;
  onConnectNew: () => void;
  onReconnect: (id: string) => void;
  onDisconnect: (id: string) => void;
}

function Dot({ status }: { status: AccountStatus }) {
  const s = STATUS[status] || STATUS.disconnected;
  const pulsing = status === 'connecting' || status === 'waiting_scan';
  return <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.dot, flex: 'none', boxShadow: pulsing ? `0 0 0 3px ${s.dot}33` : 'none' }} />;
}

/** Thanh chọn / kết nối tài khoản Zalo (đầu cột danh sách hội thoại). */
export default function AccountSwitcher({ accounts, selectedId, onSelect, onConnectNew, onReconnect, onDisconnect }: Props) {
  const [open, setOpen] = useState(false);
  const active = selectedId ? accounts.find((a) => a.id === selectedId) : null;
  const connectedCount = accounts.filter((a) => a.status === 'connected').length;

  return (
    <div style={{ padding: '10px 12px', borderBottom: '1px solid hsl(210 20% 93%)', background: 'hsl(152 35% 98%)' }}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '6px 8px', border: '1px solid hsl(210 20% 88%)', background: '#fff', borderRadius: 10, cursor: 'pointer', textAlign: 'left' }}
          >
            <div style={{ position: 'relative', flex: 'none' }}>
              <div style={avatarStyle('emerald', 34, 13)}>{active ? (active.name || 'Z').slice(0, 2) : 'Za'}</div>
              <span style={{ position: 'absolute', bottom: -1, right: -1, padding: 1.5, background: '#fff', borderRadius: '50%', display: 'flex' }}>
                <Dot status={active ? active.status : (connectedCount ? 'connected' : 'disconnected')} />
              </span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'hsl(160 30% 14%)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {active ? active.name : 'Tất cả tài khoản Zalo'}
              </div>
              <div style={{ fontSize: 11, color: 'hsl(210 10% 45%)' }}>
                {active ? (STATUS[active.status]?.label || '') : `${connectedCount} tài khoản kết nối`}
              </div>
            </div>
            <ChevronsUpDown size={15} color="hsl(210 10% 50%)" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[300px] p-2">
          <button
            onClick={() => { onSelect(null); setOpen(false); }}
            className="w-full"
            style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px', borderRadius: 8, border: 'none', background: !selectedId ? 'hsl(152 30% 95%)' : 'transparent', cursor: 'pointer', textAlign: 'left' }}
          >
            <span style={{ width: 30, height: 30, borderRadius: 8, background: 'hsl(210 20% 95%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <Plug size={15} color="hsl(210 10% 45%)" />
            </span>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>Tất cả tài khoản</span>
            {!selectedId && <Check size={15} color={EMERALD} />}
          </button>

          {accounts.length > 0 && <div style={{ height: 1, background: 'hsl(210 20% 92%)', margin: '6px 0' }} />}

          {accounts.map((a) => {
            const s = STATUS[a.status] || STATUS.disconnected;
            const sel = a.id === selectedId;
            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, background: sel ? 'hsl(152 30% 95%)' : 'transparent' }}>
                <button onClick={() => { onSelect(a.id); setOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 1, minWidth: 0, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                  <div style={avatarStyle('emerald', 30, 12)}>{(a.name || 'Z').slice(0, 2)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
                    <div style={{ fontSize: 11, color: 'hsl(210 10% 45%)', display: 'flex', alignItems: 'center', gap: 5 }}><Dot status={a.status} />{s.label}</div>
                  </div>
                  {sel && <Check size={15} color={EMERALD} />}
                </button>
                {a.status === 'connected' ? (
                  <button title="Ngắt kết nối" onClick={() => { onDisconnect(a.id); }} style={{ flex: 'none', width: 28, height: 28, borderRadius: 7, border: '1px solid hsl(210 20% 88%)', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'hsl(0 70% 50%)' }}>
                    <PlugZap size={14} />
                  </button>
                ) : (
                  <button title="Đăng nhập lại" onClick={() => { setOpen(false); onReconnect(a.id); }} style={{ flex: 'none', width: 28, height: 28, borderRadius: 7, border: '1px solid hsl(152 40% 82%)', background: 'hsl(152 40% 96%)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: EMERALD }}>
                    <RefreshCw size={14} />
                  </button>
                )}
              </div>
            );
          })}

          <div style={{ height: 1, background: 'hsl(210 20% 92%)', margin: '6px 0' }} />
          <button
            onClick={() => { setOpen(false); onConnectNew(); }}
            className="w-full"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '9px', borderRadius: 8, border: 'none', background: EMERALD, color: '#fff', fontWeight: 600, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
          >
            <Plus size={16} /> Kết nối Zalo cá nhân
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
