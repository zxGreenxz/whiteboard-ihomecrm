import { useEffect, useRef, useState } from 'react';
import { Loader2, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { convertCustomerAddress, type AddressConversion } from '@/lib/customerAddressConversion';

type Preview = { address: string; pending?: boolean; result?: AddressConversion; error?: string };

export default function AdministrativeAddressPreview({ address }: { address: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const request = useRef<{ controller: AbortController; timer: ReturnType<typeof setTimeout> } | null>(null);
  const cancel = () => {
    if (request.current) {
      clearTimeout(request.current.timer);
      request.current.controller.abort();
      request.current = null;
    }
  };
  useEffect(() => cancel, [address]);
  const visible = preview?.address === address ? preview : null;
  const valid = address.trim().length > 0 && address.length <= 600;

  const lookup = async () => {
    cancel();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (request.current?.controller !== controller) return;
      controller.abort();
      request.current = null;
      setPreview({ address, error: 'Tra địa chỉ quá lâu. Vui lòng thử lại.' });
    }, 15000);
    request.current = { controller, timer };
    setPreview({ address, pending: true });
    try {
      const result = await convertCustomerAddress(address, controller.signal);
      if (!controller.signal.aborted && request.current?.controller === controller) setPreview({ address, result });
    } catch (error) {
      if (!controller.signal.aborted && request.current?.controller === controller) {
        setPreview({ address, error: error instanceof Error ? error.message : 'Chưa tra được địa chỉ. Vui lòng thử lại.' });
      }
    } finally {
      clearTimeout(timer);
      if (request.current?.controller === controller) request.current = null;
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-md bg-muted/50 p-3 text-sm">
        <p className="mb-1 text-xs text-muted-foreground">Địa chỉ cũ dùng để tra cứu</p>
        <p className="break-words">{address || 'Điền địa chỉ thường trú hoặc chọn tỉnh, quận/huyện, phường/xã ở trên.'}</p>
      </div>
      {address.length > 600 && <p role="alert" className="text-sm text-destructive">Địa chỉ quá dài, vui lòng rút gọn còn tối đa 600 ký tự.</p>}
      <Button type="button" variant="outline" size="sm" onClick={lookup} disabled={!valid || visible?.pending}>
        {visible?.pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MapPin className="mr-2 h-4 w-4" />}
        {visible?.pending ? 'Đang tra…' : 'Tra địa chỉ mới'}
      </Button>
      {visible?.error && <p role="alert" className="text-sm text-destructive">{visible.error}</p>}
      {visible?.result && (
        <div aria-live="polite" className="space-y-3">
          {visible.result.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa tìm được địa chỉ hành chính mới. Hãy kiểm tra địa chỉ cũ và thử lại.</p>
          ) : (
            <>
              {visible.result.candidates.length > 1 && <p className="text-sm">Có {visible.result.candidates.length} kết quả gợi ý. Vui lòng đối chiếu địa chỉ của khách.</p>}
              {visible.result.candidates.map(candidate => (
                <div key={candidate.id} className="space-y-2 rounded-md border border-green-200 bg-green-50/40 p-3 text-sm">
                  <p className="break-words font-medium">{candidate.formattedAddress}</p>
                  <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div><dt className="text-xs text-muted-foreground">Tỉnh/Thành phố mới</dt><dd>{candidate.province}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Phường/Xã mới</dt><dd>{candidate.ward}</dd></div>
                  </dl>
                  {candidate.oldAddress && <p className="text-xs text-muted-foreground">Địa giới cũ đối chiếu: {candidate.oldAddress}</p>}
                </div>
              ))}
              <p className="text-xs text-muted-foreground">Nguồn: Goong V2. Kết quả để đối chiếu, chưa thay đổi địa chỉ trong hồ sơ khách.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
