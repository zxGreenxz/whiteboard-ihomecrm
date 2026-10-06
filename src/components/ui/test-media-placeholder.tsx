import { ImageOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TEST_MEDIA_DETAIL, TEST_MEDIA_MESSAGE } from '@/lib/storage/testMedia';

export function TestMediaPlaceholder({ className }: { className?: string }) {
  return <div role="status" title={TEST_MEDIA_DETAIL}
    className={cn('flex flex-col items-center justify-center gap-1 bg-muted p-2 text-center text-xs text-muted-foreground', className)}>
    <ImageOff className="h-4 w-4 shrink-0" aria-hidden="true" />
    <span>{TEST_MEDIA_MESSAGE}</span>
  </div>;
}
