import { useState } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import MeterList from '@/components/meters/MeterList';
import MeterForm from '@/components/meters/MeterForm';
import { useMetersWithLatestReading } from '@/hooks/useMeters';
import { useBuildings } from '@/hooks/useBuildings';
import { Button } from '@/components/ui/button';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Plus } from 'lucide-react';
import { QueryRegion } from '@/components/errors/QueryRegion';

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

  const buildingsQuery = useBuildings();
  const metersQuery = useMetersWithLatestReading();
  const { data: buildings } = buildingsQuery;
  const { data: meters, isLoading } = metersQuery;

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
        {/* Thanh công cụ + bộ lọc hiện ngay; chỉ danh sách chờ dữ liệu (chủ chốt 02/10/2026). */}
        <QueryRegion label="danh sách công tơ" queries={[metersQuery, buildingsQuery]} skeleton="table" rows={8}>
        <MeterList
          meters={filteredMeters}
          onEdit={handleEdit}
          isLoading={isLoading}
        />
        </QueryRegion>

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
