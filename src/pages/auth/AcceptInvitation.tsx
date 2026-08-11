// Trang nhận lời mời: /invite/:token
//
// Người được mời phải ĐANG ĐĂNG NHẬP bằng đúng email đã nhận lời mời — máy chủ
// so email của auth.uid() với email_normalized của lời mời. Vì vậy trang này
// nằm sau ProtectedRoute: chưa đăng nhập thì bị đưa về /login rồi quay lại đây.

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useQueryClient } from '@tanstack/react-query';
import { acceptInvitation } from '@/hooks/useAcceptInvitation';

export default function AcceptInvitation() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [trangThai, setTrangThai] = useState<'dangXuLy' | 'xong' | 'loi'>('dangXuLy');
  const [loi, setLoi] = useState('');

  useEffect(() => {
    let huy = false;
    (async () => {
      if (!token) {
        setLoi('Đường dẫn thiếu mã lời mời.');
        setTrangThai('loi');
        return;
      }
      try {
        await acceptInvitation(token);
      } catch (e) {
        if (huy) return;
        setLoi(e instanceof Error ? e.message : 'Không nhận được lời mời.');
        setTrangThai('loi');
        return;
      }
      if (huy) return;
      // Quyền của phiên hiện tại vừa đổi — buộc mọi truy vấn đọc lại.
      await qc.invalidateQueries();
      setTrangThai('xong');
      setTimeout(() => navigate('/', { replace: true }), 1800);
    })();
    return () => {
      huy = true;
    };
  }, [token, navigate, qc]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-4 p-6 text-center">
          {trangThai === 'dangXuLy' && (
            <>
              <Loader2 className="mx-auto h-10 w-10 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Đang xử lý lời mời…</p>
            </>
          )}
          {trangThai === 'xong' && (
            <>
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
              <div>
                <p className="font-medium">Bạn đã vào tổ chức.</p>
                <p className="mt-1 text-sm text-muted-foreground">Đang chuyển về trang chính…</p>
              </div>
            </>
          )}
          {trangThai === 'loi' && (
            <>
              <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
              <div>
                <p className="font-medium">Không nhận được lời mời</p>
                <p className="mt-1 text-sm text-muted-foreground">{loi}</p>
                <p className="mt-3 text-xs text-muted-foreground">
                  Hãy chắc chắn bạn đang đăng nhập bằng <strong>đúng email</strong> đã nhận lời mời.
                </p>
              </div>
              <Button variant="outline" onClick={() => navigate('/', { replace: true })}>
                Về trang chính
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
