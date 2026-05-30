import { useState } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import MeterList from '@/components/meters/MeterList';
import MeterForm from '@/components/meters/MeterForm';
import { useMetersWithLatestReading } from '@/hooks/useMeters';
import { useBuildings } from '@/hooks/useBuildings';
import { Button } from '@/components/ui/button';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Plus } from 'lucide-react';

const METER_TYPE_OPTIONS = [
  { value: 'ELECTRICITY', label: 'Điện' },
  { value: 'WATER', label: 'Nước' },
  { value: 'GAS', label: 'Gas' },
] as const;

export default function MetersPage() {
  const [buildingFilter, setBuildingFilter] = useState<string | null>(null);
  const [meterTypeFilter, setMeterTypeFilter] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingMeter, setEditingMeter] = useState<any | null>(null);

  const { data: buildings } = useBuildings();
  const { data: meters, isLoading } = useMetersWithLatestReading();

  // Client-side filter on the flat meters list
  const filteredMeters = (meters || []).filter((m: any) => {
    if (buildingFilter && m.building_id !== buildingFilter) return false;
    if (meterTypeFilter && m.meter_type !== meterTypeFilter) return false;
    return true;
  });

  const handleEdit = (meter: any) => {
    setEditingMeter(meter);
    setIsFormOpen(true);
  };

  const handleFormClose = (open: boolean) => {
    setIsFormOpen(open);
    if (!open) setEditingMeter(null);
  };

  return (
    <MainLayout>
      <div className="space-y-4">
        {/* Breadcrumb */}
        <div className="text-sm text-muted-foreground">
          Cài đặt hệ thống &gt; Danh mục khác &gt; Tài chính &gt;{' '}
          <span className="text-foreground font-medium">Đồng hồ Công tơ</span>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => { setEditingMeter(null); setIsFormOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />
            Thêm
          </Button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3">
          <SearchableSelect
            value={buildingFilter ?? 'ALL'}
            onValueChange={(v) => setBuildingFilter(v === 'ALL' ? null : v)}
            className="w-[200px]"
            placeholder="Chọn tòa nhà"
            options={[
              { value: 'ALL', label: 'Tất cả tòa nhà' },
              ...(buildings || []).map((b) => ({ value: b.id, label: b.name })),
            ]}
          />

          <SearchableSelect
            value={meterTypeFilter ?? 'ALL'}
            onValueChange={(v) => setMeterTypeFilter(v === 'ALL' ? null : v)}
            className="w-[200px]"
            placeholder="Loại công tơ"
            options={[
              { value: 'ALL', label: 'Tất cả loại' },
              ...METER_TYPE_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label })),
            ]}
          />
        </div>

        {/* Meter List */}
        <MeterList
          meters={filteredMeters}
          onEdit={handleEdit}
          isLoading={isLoading}
        />

        {/* Meter Form Dialog */}
        <MeterForm
          open={isFormOpen}
          onOpenChange={handleFormClose}
          meter={editingMeter}
        />
      </div>
    </MainLayout>
  );
}
