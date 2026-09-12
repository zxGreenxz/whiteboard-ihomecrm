import type { FormEventHandler } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePhoneViewport } from '@/hooks/use-mobile';
import { InvoiceEntryDesktop } from './InvoiceEntryDesktop';
import { InvoiceEntryMobile } from './InvoiceEntryMobile';
import type { InvoiceEntryProps } from './types';

interface Props extends InvoiceEntryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
}

/**
 * Vỏ chung của bộ nhập liệu hoá đơn: desktop mở Dialog 900px, điện thoại
 * (≤767px) mở màn hình app full-screen (.cm-stage/.cm-app). Dữ liệu và
 * submit do hộp thoại cha giữ; ở đây chỉ chọn biến thể và bọc <form>.
 */
export function InvoiceEntryShell({ open, onOpenChange, onSubmit, ...entry }: Props) {
  const isPhone = usePhoneViewport();
  if (!open) return null;

  if (isPhone) {
    // sheet-ov: dấu hiệu để copilot.css ẩn nút Copilot nổi trong lúc màn hình này mở.
    return (
      <div className="cm-stage ien-stage sheet-ov" role="dialog" aria-modal="true" aria-label={entry.header.title}>
        <div className="cm-app">
          <form onSubmit={onSubmit} className="ien-form" noValidate>
            <InvoiceEntryMobile {...entry} />
          </form>
        </div>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        className="block w-[calc(100vw-1rem)] max-w-[900px] gap-0 overflow-hidden rounded-xl border-[hsl(210_20%_88%)] p-0 shadow-[0_10px_30px_-12px_rgba(15,42,30,.18)]"
      >
        <DialogTitle className="sr-only">{entry.header.title}</DialogTitle>
        <DialogDescription className="sr-only">{entry.header.lockNote}</DialogDescription>
        <form onSubmit={onSubmit} className="max-h-[92vh] overflow-y-auto" noValidate>
          <InvoiceEntryDesktop {...entry} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
