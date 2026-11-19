import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, Copy, Eye, EyeOff, KeyRound, Loader2, Shuffle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useResetUserPassword } from '@/hooks/useResetUserPassword';
import { adminPasswordProblem, MIN_PASSWORD_CHARS } from '@/lib/accountFeedback';
import { chuanHoaLoiDatLaiMatKhau } from '@/lib/edgeFunctions';
import { focusFirstError } from '@/lib/formErrors';
import { taoMatKhauNgauNhien } from '@/lib/resetUserPassword';
import { cn } from '@/lib/utils';

export interface ResetUserPasswordTarget {
  userId: string;
  /** Tên hiển thị: họ tên, hoặc email khi chưa có tên. */
  name: string;
  /**
   * Tên đăng nhập (email) của NGƯỜI BỊ ĐỔI. Đặt vào ô username ẩn để trình quản lý mật khẩu gắn mật
   * khẩu mới với người này, không đề nghị "cập nhật" mật khẩu đã lưu của chính người đang bấm.
   */
  login?: string | null;
}

export interface ResetUserPasswordDialogProps {
  /** Khác `null` ⇒ hộp thoại mở cho người này. */
  target: ResetUserPasswordTarget | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Hộp thoại "Đặt lại mật khẩu" — dùng chung cho trang Thành viên và /admin/users.
 *
 * Mọi state (mật khẩu, lỗi, kết quả, cả mutation) nằm trong `NoiDungDatLai`, khoá theo phiên mở
 * và `userId`: mở lại hay đổi người là dựng lại từ đầu, đóng thì Radix gỡ nội dung sau hiệu ứng
 * đóng ⇒ không mật khẩu nào còn lại cho lần mở sau.
 *
 * Đang gửi thì không đóng được (ẩn nút X, khoá Huỷ): đóng giữa chừng là mất mật khẩu vừa đặt mà
 * không biết kết quả.
 */
export function ResetUserPasswordDialog({ target, onOpenChange }: ResetUserPasswordDialogProps) {
  const dangMo = target !== null;
  // `so` tăng mỗi lần mở mới. `nguoi` giữ người gần nhất để nội dung không trống lúc đang đóng.
  const [phien, setPhien] = useState({ mo: dangMo, so: 0, nguoi: target });
  if (dangMo !== phien.mo || (target !== null && target !== phien.nguoi)) {
    setPhien({ mo: dangMo, so: dangMo && !phien.mo ? phien.so + 1 : phien.so, nguoi: target ?? phien.nguoi });
  }
  const nguoi = target ?? phien.nguoi;
  const [dangGui, setDangGui] = useState(false);

  return (
    <Dialog
      open={dangMo}
      onOpenChange={(open) => {
        if (!open && dangGui) return;
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-md" hideClose={dangGui}>
        {nguoi && (
          <NoiDungDatLai
            key={`${phien.so}:${nguoi.userId}`}
            target={nguoi}
            onPendingChange={setDangGui}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface NoiDungProps {
  target: ResetUserPasswordTarget;
  onPendingChange: (pending: boolean) => void;
  onClose: () => void;
}

function NoiDungDatLai({ target, onPendingChange, onClose }: NoiDungProps) {
  const datLai = useResetUserPassword();
  const dangGui = datLai.isPending;
  const [matKhau, setMatKhau] = useState('');
  const [hienMatKhau, setHienMatKhau] = useState(false);
  const [loiO, setLoiO] = useState<string | null>(null);
  const [loiMayChu, setLoiMayChu] = useState<{ message: string; outcomeUnknown: boolean } | null>(null);
  const [daDat, setDaDat] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const id = useId();
  const oMatKhauId = `${id}-mat-khau`;
  const goiYId = `${id}-goi-y`;
  const loiOId = `${id}-loi`;

  useEffect(() => {
    onPendingChange(dangGui);
  }, [dangGui, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);

  const taoNgauNhien = () => {
    try {
      setMatKhau(taoMatKhauNgauNhien());
      setHienMatKhau(true);
      setLoiO(null);
    } catch (error) {
      setLoiO(error instanceof Error ? error.message : 'Chưa tạo được mật khẩu ngẫu nhiên. Tự nhập mật khẩu mới.');
    }
  };

  const gui = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (dangGui) return;
    const loi = adminPasswordProblem(matKhau);
    setLoiO(loi);
    setLoiMayChu(null);
    if (loi) {
      void focusFirstError({ password: loi }, { root: formRef.current });
      return;
    }
    const matKhauGui = matKhau;
    try {
      await datLai.mutateAsync({ userId: target.userId, password: matKhauGui });
      setDaDat(matKhauGui);
    } catch (error) {
      const loiDatLai = chuanHoaLoiDatLaiMatKhau(error);
      setLoiMayChu({ message: loiDatLai.message, outcomeUnknown: loiDatLai.outcomeUnknown });
      // Chưa rõ kết quả thì người dùng cần đúng mật khẩu này để thử đăng nhập.
      if (loiDatLai.outcomeUnknown) setHienMatKhau(true);
    }
  };

  if (daDat !== null) return <DaDatLai ten={target.name} matKhau={daDat} onClose={onClose} />;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Đặt lại mật khẩu</DialogTitle>
        <DialogDescription>
          Đặt mật khẩu mới cho <span className="font-medium text-foreground">{target.name}</span>. Mật khẩu cũ của họ
          sẽ không dùng được nữa.
        </DialogDescription>
      </DialogHeader>

      <form
        ref={formRef}
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          void gui(event);
        }}
      >
        {/* Ô username ẩn (vẫn trong DOM, không display:none) cho trình quản lý mật khẩu: không có nó,
            Chrome dễ đề nghị lưu mật khẩu mới vào tài khoản của chính người đang bấm. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={target.login || target.name}
          readOnly
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
        />
        <div className="space-y-1.5">
          <Label htmlFor={oMatKhauId}>Mật khẩu mới</Label>
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-[12rem] flex-1">
              <Input
                id={oMatKhauId}
                name="password"
                type={hienMatKhau ? 'text' : 'password'}
                value={matKhau}
                onChange={(event) => {
                  setMatKhau(event.target.value);
                  setLoiO(null);
                }}
                readOnly={dangGui}
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={loiO !== null}
                aria-describedby={loiO ? `${loiOId} ${goiYId}` : goiYId}
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setHienMatKhau((hien) => !hien)}
                aria-label={hienMatKhau ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-2 text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {hienMatKhau ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button type="button" variant="outline" onClick={taoNgauNhien} disabled={dangGui}>
              <Shuffle className="mr-1.5 h-4 w-4" />
              Tạo ngẫu nhiên
            </Button>
          </div>
          {loiO && (
            <p id={loiOId} role="alert" className="text-sm text-destructive">
              {loiO}
            </p>
          )}
          <p id={goiYId} className="text-xs text-muted-foreground">
            Ít nhất {MIN_PASSWORD_CHARS} ký tự, không có dấu cách ở đầu hoặc cuối.
          </p>
        </div>

        {loiMayChu && (
          <div
            role="alert"
            className={cn(
              'flex gap-2 rounded-md border p-3 text-sm',
              loiMayChu.outcomeUnknown
                ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
                : 'border-destructive/40 text-destructive',
            )}
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{loiMayChu.message}</p>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={onClose} disabled={dangGui}>
            Huỷ
          </Button>
          <Button type="submit" disabled={dangGui}>
            {dangGui ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
            Đặt lại mật khẩu
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function DaDatLai({ ten, matKhau, onClose }: { ten: string; matKhau: string; onClose: () => void }) {
  const [chep, setChep] = useState<'chua' | 'xong' | 'loi'>('chua');
  const oId = useId();

  const chepMatKhau = async () => {
    try {
      // `navigator.clipboard` không có ở trang không HTTPS: lỗi rơi vào catch như mọi lỗi chép khác.
      await navigator.clipboard.writeText(matKhau);
      setChep('xong');
    } catch {
      setChep('loi');
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Đặt lại mật khẩu</DialogTitle>
        <DialogDescription className="flex items-start gap-2 text-foreground">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <span>Đã đặt lại mật khẩu cho {ten}.</span>
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <Label htmlFor={oId}>Mật khẩu mới</Label>
        <div className="flex gap-2">
          {/* Form vừa bị thay thế nên tiêu điểm phải có chỗ đứng mới: đặt vào ô mật khẩu, chữ đã được chọn sẵn. */}
          <Input
            id={oId}
            readOnly
            autoFocus
            value={matKhau}
            onFocus={(event) => event.currentTarget.select()}
            className="font-mono"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void chepMatKhau();
            }}
          >
            <Copy className="mr-1.5 h-4 w-4" />
            Chép
          </Button>
        </div>
        {chep === 'xong' && (
          <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
            Đã chép mật khẩu.
          </p>
        )}
        {chep === 'loi' && (
          <p role="alert" className="text-sm text-destructive">
            Chưa chép được. Chọn ô mật khẩu rồi tự sao chép.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Người này sẽ bị đăng xuất khỏi các thiết bị đang dùng (chậm nhất khoảng 1 giờ) và phải đăng nhập lại bằng
          mật khẩu mới.
        </p>
        <p className="text-xs text-muted-foreground">
          Gửi mật khẩu này cho người dùng qua kênh riêng; họ nên tự đổi lại ở trang Hồ sơ sau khi đăng nhập.
        </p>
      </div>

      <DialogFooter>
        <Button type="button" onClick={onClose}>
          Xong
        </Button>
      </DialogFooter>
    </>
  );
}
