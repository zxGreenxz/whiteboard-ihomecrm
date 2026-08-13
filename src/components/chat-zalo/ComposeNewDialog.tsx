import { useMemo, useState } from 'react';
import { Loader2, MessageSquarePlus } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ZaloAccount, ZaloConversation } from './types';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accounts: ZaloAccount[];
  conversations: ZaloConversation[];
  finding: boolean;
  /** tìm/tạo hội thoại theo SĐT trên account đã chọn */
  onStart: (accountId: string, phone: string) => void;
  /** mở hội thoại đã có sẵn */
  onOpenExisting: (conversationId: string) => void;
}

const normPhone = (p: string) => {
  const d = p.replace(/\D/g, '');
  return d.startsWith('84') && d.length >= 10 ? '0' + d.slice(2) : d;
};

/** Dialog "Soạn tin mới": chọn tài khoản gửi + nhập SĐT → mở/tạo hội thoại 1-1. */
export default function ComposeNewDialog({ open, onOpenChange, accounts, conversations, finding, onStart, onOpenExisting }: Props) {
  const connected = accounts.filter((a) => a.status === 'connected');
  const [accountId, setAccountId] = useState('');
  const [phone, setPhone] = useState('');
  const accId = accountId || connected[0]?.id || '';
  const digits = normPhone(phone);
  const valid = /^0\d{9}$/.test(digits);

  // Trùng hội thoại có sẵn → mở luôn, khỏi gọi worker
  const existing = useMemo(() => {
    if (!valid) return null;
    return conversations.find((c) => !c.isGroup && normPhone(c.phone) === digits && (!accId || c.accountId === accId)) || null;
  }, [conversations, digits, valid, accId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Soạn tin mới</DialogTitle>
          <DialogDescription>Tìm khách theo số điện thoại và bắt đầu chat Zalo.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {connected.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có tài khoản Zalo nào đang kết nối — kết nối trước rồi quay lại.</p>
          ) : (
            <>
              {connected.length > 1 && (
                <div className="space-y-1.5">
                  <Label>Gửi từ tài khoản</Label>
                  <Select value={accId} onValueChange={setAccountId}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {connected.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="compose-phone">Số điện thoại</Label>
                <Input
                  id="compose-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="0xxx xxx xxx"
                  inputMode="tel"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && valid && !finding) {
                      if (existing) onOpenExisting(existing.id);
                      else onStart(accId, digits);
                    }
                  }}
                />
                {phone && !valid && <p className="text-xs text-destructive">Số chưa hợp lệ (10 số, bắt đầu bằng 0).</p>}
                {existing && <p className="text-xs text-muted-foreground">Đã có hội thoại với <b>{existing.name}</b> — mở lại thay vì tạo mới.</p>}
              </div>
              <Button
                className="w-full"
                disabled={!valid || finding || !accId}
                onClick={() => (existing ? onOpenExisting(existing.id) : onStart(accId, digits))}
              >
                {finding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MessageSquarePlus className="mr-2 h-4 w-4" />}
                {existing ? 'Mở hội thoại có sẵn' : finding ? 'Đang tìm trên Zalo…' : 'Bắt đầu chat'}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
