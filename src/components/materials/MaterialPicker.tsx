import { useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useMaterials } from '@/hooks/useMaterials';

interface Props {
  value: string | null;
  onChange: (id: string) => void;
  placeholder?: string;
  showStock?: boolean;
  disabled?: boolean;
}

export function MaterialPicker({
  value,
  onChange,
  placeholder = 'Chọn vật tư…',
  showStock = false,
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const { data: materials = [] } = useMaterials({});

  const selected = materials.find((m) => m.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          className="w-full justify-between font-normal"
          disabled={disabled}
        >
          {selected ? (
            <span className="truncate text-left">
              {selected.name}
              {showStock && (
                <span className="text-muted-foreground ml-1.5 text-xs">
                  (còn {Number(selected.on_hand).toLocaleString('vi-VN')} {selected.unit})
                </span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Tìm vật tư…" />
          <CommandList>
            <CommandEmpty>Không có vật tư phù hợp.</CommandEmpty>
            <CommandGroup>
              {materials.map((m) => (
                <CommandItem
                  key={m.id}
                  value={`${m.name} ${m.code ?? ''}`}
                  onSelect={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4', value === m.id ? 'opacity-100' : 'opacity-0')} />
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="truncate">{m.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {m.code ? `${m.code} · ` : ''}còn {Number(m.on_hand).toLocaleString('vi-VN')} {m.unit}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
