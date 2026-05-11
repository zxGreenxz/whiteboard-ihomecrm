import { useState } from 'react';
import { Check, ChevronsUpDown, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useIncomeExpenseTypeCategories } from '@/hooks/useIncomeExpenseTypes';

interface CategoryComboboxProps {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  filterType?: 'income' | 'expense';
  placeholder?: string;
  className?: string;
}

/**
 * Combobox cho field `category` của loại thu/chi:
 * - Dropdown searchable: gõ để lọc các nhóm đã có
 * - Khi text gõ chưa khớp nhóm nào → hiện "+ Tạo mới: <text>" để gom luôn
 *   (lưu category là string mới ngay khi user chọn — phía form sẽ gửi lên DB
 *    khi submit, nên không cần round-trip).
 */
const CategoryCombobox = ({
  value,
  onChange,
  filterType,
  placeholder = 'Chọn nhóm hoặc gõ để tạo mới...',
  className,
}: CategoryComboboxProps) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { data: categories = [] } = useIncomeExpenseTypeCategories(filterType);

  const trimmedQuery = query.trim();
  const lowerCategories = categories.map((c) => c.toLowerCase());
  const queryMatchesExisting =
    trimmedQuery.length > 0 &&
    lowerCategories.includes(trimmedQuery.toLowerCase());
  const showCreateOption = trimmedQuery.length > 0 && !queryMatchesExisting;

  // Bao gồm value hiện tại trong danh sách nếu nó chưa được lưu (mới gõ trong
  // form lúc tạo type, chưa flush về DB) — để hiện tick cho user thấy.
  const allCategories = Array.from(
    new Set([...categories, ...(value ? [value] : [])])
  ).sort((a, b) => a.localeCompare(b, 'vi', { sensitivity: 'base' }));

  const handleSelect = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery('');
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(null);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'w-full justify-between font-normal',
            !value && 'text-muted-foreground',
            className
          )}
        >
          <span className="truncate">{value || placeholder}</span>
          <span className="flex items-center gap-1 shrink-0">
            {value ? (
              <span
                role="button"
                aria-label="Xoá nhóm"
                onClick={handleClear}
                className="rounded p-0.5 hover:bg-muted"
              >
                <X className="h-3.5 w-3.5 opacity-60" />
              </span>
            ) : null}
            <ChevronsUpDown className="h-4 w-4 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        align="start"
        style={{ width: 'var(--radix-popover-trigger-width)' }}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Tìm hoặc gõ tên nhóm mới..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {allCategories.length === 0 && !showCreateOption ? (
              <CommandEmpty>
                Chưa có nhóm nào. Gõ tên để tạo mới.
              </CommandEmpty>
            ) : null}
            {allCategories.length > 0 && (
              <CommandGroup heading="Nhóm đã có">
                {allCategories
                  .filter((c) =>
                    trimmedQuery.length === 0
                      ? true
                      : c
                          .toLowerCase()
                          .includes(trimmedQuery.toLowerCase())
                  )
                  .map((c) => (
                    <CommandItem
                      key={c}
                      value={c}
                      onSelect={() => handleSelect(c)}
                      className="cursor-pointer"
                    >
                      <Check
                        className={cn(
                          'mr-2 h-4 w-4',
                          value === c ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      {c}
                    </CommandItem>
                  ))}
              </CommandGroup>
            )}
            {showCreateOption && (
              <CommandGroup heading="Tạo mới">
                <CommandItem
                  value={`__create__:${trimmedQuery}`}
                  onSelect={() => handleSelect(trimmedQuery)}
                  className="cursor-pointer text-primary"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Tạo mới: <span className="font-medium ml-1">{trimmedQuery}</span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

export default CategoryCombobox;
