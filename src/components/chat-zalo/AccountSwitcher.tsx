import { useState } from 'react';
import { ChevronsUpDown, PlugZap, Plus, RefreshCw, Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { avatarStyle, EMERALD } from './zaloTheme';
import ZaloAvatar from './ZaloAvatar';
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
  /** Tập tài khoản đang được CHỌN để xem (nhiều cùng lúc). */
  selectedIds: string[];
  onToggle: (id: string) => void;       // bật/tắt 1 tài khoản trong tập xem
  onOnly: (id: string) => void;         // chỉ xem RIÊNG 1 tài khoản
  onAll: () => void;                    // chọn tất cả
  onConnectNew: () => void;
  onReconnect: (id: string) => void;
  onDisconnect: (id: string) => void;
}

function Dot({ status }: { status: AccountStatus }) {
  const s = STATUS[status] || STATUS.disconnected;
  return <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.dot, flex: 'none' }} />;
}

function Box({ on }: { on: boolean }) {
  return (
    <span style={{ width: 18, height: 18, borderRadius: 5, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', border: on ? 'none' : '1.5px solid hsl(210 20% 80%)', background: on ? EMERALD : '#fff' }}>
      {on && <Check size={13} color="#fff" strokeWidth={3} />}
    </span>
  );
}

/** Thanh chọn/kết nối tài khoản Zalo — CHỌN NHIỀU tài khoản cùng lúc. */
export default function AccountSwitcher({ accounts, selectedIds, onToggle, onOnly, onAll, onConnectNew, onReconnect, onDisconnect }: Props) {
  const [open, setOpen] = useState(false);
  const connectedCount = accounts.filter((a) => a.status === 'connected').length;
  const allSelected = accounts.length > 0 && selectedIds.length >= accounts.length;
  const single = selectedIds.length === 1 ? accounts.find((a) => a.id === selectedIds[0]) : null;

  const summaryTop = allSelected ? 'Tất cả tài khoản Zalo' : single ? single.name : `Đang xem ${selectedIds.length}/${accounts.length} tài khoản`;
  const summarySub = allSelected ? `${connectedCount} tài khoản kết nối` : single ? (STATUS[single.status]?.label || '') : 'đã chọn';

  return (
    <div style={{ padding: '10px 12px', borderBottom: '1px solid hsl(210 20% 93%)', background: 'hsl(152 35% 98%)' }}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '6px 8px', border: '1px solid hsl(210 20% 88%)', background: '#fff', borderRadius: 10, cursor: 'pointer', textAlign: 'left' }}>
            <div style={avatarStyle('emerald', 34, 13)}>{single ? (single.name || 'Z').slice(0, 2) : 'Za'}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'hsl(160 30% 14%)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summaryTop}</div>
              <div style={{ fontSize: 11, color: 'hsl(210 10% 45%)' }}>{summarySub}</div>
            </div>
            <ChevronsUpDown size={15} color="hsl(210 10% 50%)" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[320px] p-2">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px 8px' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'hsl(210 10% 45%)' }}>Tài khoản hiển thị</span>
            <button onClick={onAll} style={{ fontSize: 11.5, fontWeight: 600, color: EMERALD, background: 'none', border: 'none', cursor: 'pointer' }}>Chọn tất cả</button>
          </div>

          <div className="wz-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
            {accounts.map((a) => {
              const s = STATUS[a.status] || STATUS.disconnected;
              const on = selectedIds.includes(a.id);
              return (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8 }}>
                  <button onClick={() => onToggle(a.id)} title={on ? 'Bỏ hiển thị' : 'Hiển thị'} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, flex: 'none' }}>
                    <Box on={on} />
                  </button>
                  <ZaloAvatar url={a.avatarUrl} initials={(a.name || 'Z').slice(0, 2)} tone="emerald" size={30} fontSize={12} />
                  <button onClick={() => { onOnly(a.id); setOpen(false); }} title="Chỉ xem tài khoản này" style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                    <span style={{ fontSize: 11, color: 'hsl(210 10% 45%)', display: 'flex', alignItems: 'center', gap: 5 }}><Dot status={a.status} />{s.label}</span>
                  </button>
                  {a.status === 'connected' ? (
                    <button title="Ngắt kết nối" onClick={() => onDisconnect(a.id)} style={{ flex: 'none', width: 28, height: 28, borderRadius: 7, border: '1px solid hsl(210 20% 88%)', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'hsl(0 70% 50%)' }}>
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
          </div>

          <div style={{ height: 1, background: 'hsl(210 20% 92%)', margin: '6px 0' }} />
          <button onClick={() => { setOpen(false); onConnectNew(); }} className="w-full" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '9px', borderRadius: 8, border: 'none', background: EMERALD, color: '#fff', fontWeight: 600, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}>
            <Plus size={16} /> Kết nối Zalo cá nhân
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
