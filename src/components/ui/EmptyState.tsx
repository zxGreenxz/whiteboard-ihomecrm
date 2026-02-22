import { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

/**
 * EmptyState - Reusable component for empty list states.
 * Displays an icon, title, optional description, and optional action button.
 *
 * Usage:
 * ```tsx
 * <EmptyState
 *   icon={Building2}
 *   title="Chưa có toà nhà nào"
 *   description="Hãy thêm toà nhà đầu tiên để bắt đầu quản lý"
 *   actionLabel="Thêm toà nhà"
 *   onAction={() => setCreateDialogOpen(true)}
 * />
 * ```
 */
const EmptyState = ({ icon: Icon, title, description, actionLabel, onAction }: EmptyStateProps) => {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
        <Icon className="h-8 w-8 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-semibold text-foreground mb-1">{title}</h3>
      {description && (
        <p className="text-sm text-muted-foreground max-w-sm mb-4">{description}</p>
      )}
      {actionLabel && onAction && (
        <Button onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
};

export default EmptyState;
