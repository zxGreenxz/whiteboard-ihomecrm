import { Search, Plus, Download, Upload, Printer, LayoutGrid, List } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useMyBuildingScope } from '@/hooks/useMyBuildingScope';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';

export type ViewMode = 'list' | 'grid';

interface CustomerListToolbarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onAdd: () => void;
  onExport: () => void;
  onImport: () => void;
  onPrint: () => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}

export default function CustomerListToolbar({
  searchQuery,
  onSearchChange,
  onAdd,
  onExport,
  onImport,
  onPrint,
  viewMode,
  onViewModeChange,
}: CustomerListToolbarProps) {
  const { hasAnyScope } = useMyBuildingScope();
  const { data: perms } = useMyPermissions();
  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
      {/* Search */}
      <div className="relative w-full sm:w-72">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          data-ai-safe="customers.list.customer.search"
          placeholder="Tìm kiếm khách hàng..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {hasAnyScope && canUse(perms, 'customers', 'create') && (
          <Button size="sm" onClick={onAdd} className="bg-green-600 hover:bg-green-700">
            <Plus className="h-4 w-4" />
          </Button>
        )}
        {canUse(perms, 'customers', 'export') && (
          <Button size="sm" variant="outline" onClick={onExport}>
            <Download className="h-4 w-4" />
          </Button>
        )}
        {hasAnyScope && canUse(perms, 'customers', 'import') && (
          <Button size="sm" variant="outline" onClick={onImport}>
            <Upload className="h-4 w-4" />
          </Button>
        )}
        {canUse(perms, 'customers', 'print') && (
          <Button size="sm" variant="outline" onClick={onPrint}>
            <Printer className="h-4 w-4" />
          </Button>
        )}

        {/* View toggle */}
        <div className="flex items-center border rounded-md">
          <Button
            size="sm"
            variant="ghost"
            className={cn('rounded-r-none', viewMode === 'grid' && 'bg-muted')}
            onClick={() => onViewModeChange('grid')}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={cn('rounded-l-none', viewMode === 'list' && 'bg-muted')}
            onClick={() => onViewModeChange('list')}
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
