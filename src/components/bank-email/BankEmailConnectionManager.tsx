import { useState } from 'react';
import { MailX } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useDisconnectBankEmail, useOwnedBankEmailConnections } from '@/hooks/useBankEmail';
import { friendlyError } from '@/lib/friendlyError';

/** Owner-only revocation remains reachable even after business permissions are removed. */
export function BankEmailConnectionManager() {
  const owned = useOwnedBankEmailConnections();
  const disconnect = useDisconnectBankEmail();
  const [error, setError] = useState('');

  async function stop(connectionId: string) {
    setError('');
    try {
      await disconnect.mutateAsync(connectionId);
      toast.success('Đã ngắt Gmail ACB và dừng tự ghi thu.');
    } catch (cause) {
      const feedback = friendlyError(cause, 'Chưa ngắt được Gmail ACB', { operation: 'ngắt Gmail ACB' });
      setError(`${feedback.title}. ${feedback.description}`);
    }
  }

  if (!owned.data?.length && !owned.isError) return null;
  return <Card aria-label="Kết nối Gmail ACB của tôi">
    <CardHeader>
      <div className="flex items-center gap-2"><MailX className="h-5 w-5" /><CardTitle>Kết nối Gmail ACB của tôi</CardTitle></div>
      <CardDescription>Bạn có thể ngắt quyền đọc Gmail của mình tại đây, kể cả khi không còn quyền cấu hình gạch nợ.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {owned.isError && <p role="alert" className="text-sm text-destructive">Chưa tải được kết nối Gmail ACB. <Button type="button" size="sm" variant="outline" onClick={() => void owned.refetch()}>Thử lại</Button></p>}
      {owned.data?.map(connection => <div key={connection.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">{connection.email ?? 'Gmail chưa hoàn tất kết nối'}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={connection.status === 'CONNECTED' ? 'default' : 'secondary'}>{connection.status === 'CONNECTED' ? 'Đang kết nối' : connection.status === 'RECONNECT_REQUIRED' ? 'Cần kết nối lại' : connection.status === 'AUTHORIZING' ? 'Đang ủy quyền' : 'Đã ngắt'}</Badge>
          {connection.status !== 'DISCONNECTED' && <Button type="button" size="sm" variant="outline" disabled={disconnect.isPending} onClick={() => void stop(connection.id)}>Ngắt Gmail ACB</Button>}
        </div>
      </div>)}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </CardContent>
  </Card>;
}
