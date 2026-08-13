import { useState } from 'react';
import { Loader2, Link2, Unlink, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSearchCustomers, useLinkConversation, useUnlinkConversation } from '@/hooks/chat-zalo/useZaloCrmProfile';
import { useZaloOrgId } from '@/hooks/useZaloChat';
import type { ZaloConversation } from './types';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  conv: ZaloConversation | null;
}

/** Dialog gắn/tháo hồ sơ CRM (khách hàng) cho hội thoại — search theo tên/SĐT trong org. */
export default function LinkCustomerDialog({ open, onOpenChange, conv }: Props) {
  const orgId = useZaloOrgId();
  const [term, setTerm] = useState('');
  const { data: hits = [], isFetching } = useSearchCustomers(term, open ? orgId : null);
  const link = useLinkConversation();
  const unlink = useUnlinkConversation();

  if (!conv) return null;
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setTerm(''); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Gắn hồ sơ CRM</DialogTitle>
          <DialogDescription>
            Hội thoại: <b>{conv.name}</b>{conv.phone ? ` · ${conv.phone}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Tìm khách hàng theo tên hoặc SĐT…"
              className="pl-8"
              autoFocus
            />
          </div>
          <div className="max-h-64 overflow-y-auto rounded-md border">
            {isFetching && <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Đang tìm…</div>}
            {!isFetching && term.trim().length >= 2 && hits.length === 0 && (
              <div className="p-3 text-sm text-muted-foreground">Không tìm thấy khách hàng nào.</div>
            )}
            {hits.map((c) => (
              <button
                key={c.id}
                className="flex w-full items-center justify-between gap-2 border-b px-3 py-2 text-left text-sm last:border-0 hover:bg-muted"
                onClick={() => link.mutate(
                  { conversationId: conv.id, customerId: c.id },
                  { onSuccess: () => onOpenChange(false) },
                )}
                disabled={link.isPending}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{c.full_name}</span>
                  <span className="block text-xs text-muted-foreground">{c.phone}</span>
                </span>
                <Link2 className="h-4 w-4 shrink-0 text-primary" />
              </button>
            ))}
          </div>
          {(conv.customerId || conv.leadId) && (
            <Button
              variant="outline"
              className="w-full"
              disabled={unlink.isPending}
              onClick={() => unlink.mutate({ conversationId: conv.id }, { onSuccess: () => onOpenChange(false) })}
            >
              {unlink.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Unlink className="mr-2 h-4 w-4" />}
              Tháo liên kết hiện tại
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
