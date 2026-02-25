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
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useCreateBuilding } from '@/hooks/useBuildings';
import type { Building } from '@/types/building';

interface QuickCreateBuildingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (building: Building) => void;
}

export default function QuickCreateBuildingDialog({
  open,
  onOpenChange,
  onCreated,
}: QuickCreateBuildingDialogProps) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [nameError, setNameError] = useState('');
  const createBuilding = useCreateBuilding();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('Tên toà nhà không được để trống');
      return;
    }

    try {
      const result = await createBuilding.mutateAsync({
        name: trimmedName,
        code: code.trim() || null,
        status: 'ACTIVE',
        province: '',
        district: '',
        ward: '',
        street_address: '',
      });
      onCreated(result as unknown as Building);
      handleClose();
    } catch {
      // Error handled by hook toast
    }
  };

  const handleClose = () => {
    setName('');
    setCode('');
    setNameError('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Thêm toà nhà nhanh</DialogTitle>
          <DialogDescription>
            Tạo toà nhà mới với thông tin cơ bản
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="quick-building-name">Tên toà nhà *</Label>
            <Input
              id="quick-building-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError('');
              }}
              placeholder="Nhập tên toà nhà"
              autoFocus
            />
            {nameError && (
              <p className="text-sm text-destructive">{nameError}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="quick-building-code">Mã toà</Label>
            <Input
              id="quick-building-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Nhập mã toà (không bắt buộc)"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose} disabled={createBuilding.isPending}>
              Huỷ
            </Button>
            <Button type="submit" disabled={createBuilding.isPending}>
              {createBuilding.isPending ? 'Đang tạo...' : 'Tạo toà nhà'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
