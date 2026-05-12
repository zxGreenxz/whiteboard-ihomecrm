import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useCreateFloor } from '@/hooks/useFloors';
import type { Database } from '@/integrations/supabase/types';

type Floor = Database['public']['Tables']['floors']['Row'];

interface QuickCreateFloorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buildingId: string;
  onCreated: (floor: Floor) => void;
}

export default function QuickCreateFloorDialog({
  open,
  onOpenChange,
  buildingId,
  onCreated,
}: QuickCreateFloorDialogProps) {
  const [floorNumber, setFloorNumber] = useState('');
  const [floorName, setFloorName] = useState('');
  const [floorNumberError, setFloorNumberError] = useState('');
  const createFloor = useCreateFloor();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const num = parseInt(floorNumber, 10);
    if (!floorNumber.trim() || isNaN(num) || num < 1) {
      setFloorNumberError('Số tầng phải là số nguyên dương');
      return;
    }

    try {
      const result = await createFloor.mutateAsync({
        building_id: buildingId,
        floor_number: num,
        name: floorName.trim() || null,
      });
      onCreated(result as Floor);
      handleClose();
    } catch {
      // Error handled by hook toast
    }
  };

  const handleClose = () => {
    setFloorNumber('');
    setFloorName('');
    setFloorNumberError('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Thêm tầng nhanh</DialogTitle>
          <DialogDescription>
            Tạo tầng mới cho toà nhà đã chọn
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="quick-floor-number">Số tầng *</Label>
            <NumberInput
              id="quick-floor-number"
              min={1}
              value={floorNumber ? parseInt(floorNumber, 10) : null}
              onChange={(v) => {
                setFloorNumber(v ? String(v) : '');
                if (floorNumberError) setFloorNumberError('');
              }}
              placeholder="Nhập số tầng"
              autoFocus
            />
            {floorNumberError && (
              <p className="text-sm text-destructive">{floorNumberError}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="quick-floor-name">Tên tầng</Label>
            <Input
              id="quick-floor-name"
              value={floorName}
              onChange={(e) => setFloorName(e.target.value)}
              placeholder="Nhập tên tầng (không bắt buộc)"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose} disabled={createFloor.isPending}>
              Huỷ
            </Button>
            <Button type="submit" disabled={createFloor.isPending}>
              {createFloor.isPending ? 'Đang tạo...' : 'Tạo tầng'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
