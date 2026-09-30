import { QueryRegion } from '@/components/errors/QueryRegion';
import { isZaloActionUnconfirmed, zaloActionErrorMessage } from '@/lib/zaloActionFeedback';
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
  const searchQuery = useSearchCustomers(term, open ? orgId : null);
  const { data: hits = [], isFetching } = searchQuery;
  const [failures,setFailures] = useState<Record<string,unknown>>({});
  const failure = conv ? failures[conv.id] : null;
  const blocked = isZaloActionUnconfirmed(failure);
  const handleFailure = (error:unknown) => { if(conv) setFailures(previous=>({...previous,[conv.id]:error})); };
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
              aria-label="Tên hoặc số điện thoại khách hàng"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Tìm khách hàng theo tên hoặc SĐT…"
              className="pl-8"
              autoFocus
            />
          </div>
          {failure != null && <p role="alert" className="text-sm text-destructive">{zaloActionErrorMessage(failure,'thay đổi liên kết hồ sơ khách hàng')}</p>}
          {term.trim().length < 2 && <p className="text-sm text-muted-foreground">Nhập ít nhất 2 ký tự tên hoặc số điện thoại để tìm khách hàng.</p>}
          <QueryRegion label="kết quả tìm khách hàng" queries={term.trim().length>=2 && orgId ? [searchQuery] : []}>
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
                  { onSuccess: () => onOpenChange(false), onError:handleFailure },
                )}
                disabled={link.isPending || unlink.isPending || blocked}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{c.full_name}</span>
                  <span className="block text-xs text-muted-foreground">{c.phone}</span>
                </span>
                <Link2 className="h-4 w-4 shrink-0 text-primary" />
              </button>
            ))}
          </div>
          </QueryRegion>
          {(conv.customerId || conv.leadId) && (
            <Button
              variant="outline"
              className="w-full"
              disabled={unlink.isPending || link.isPending || blocked}
              onClick={() => unlink.mutate({ conversationId: conv.id }, { onSuccess: () => onOpenChange(false), onError:handleFailure })}
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
