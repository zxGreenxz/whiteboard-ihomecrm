import { useState } from 'react';
import { useProvinces, useDistricts, useWards } from '@/hooks/useAddressData';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { assembleLegacyAddress } from '@/lib/customerAddressConversion';
import AdministrativeAddressPreview from './AdministrativeAddressPreview';

interface Props {
  province?: string | null;
  district?: string | null;
  ward?: string | null;
  detailedAddress?: string | null;
  permanentAddress?: string | null;
}

export default function CustomerAdministrativeAddress({ province, district, ward, detailedAddress, permanentAddress }: Props) {
  const { provinces } = useProvinces();
  const { districts } = useDistricts(province);
  const { wards } = useWards(district);
  const [preferredSource, setPreferredSource] = useState('permanent');
  const legacy = assembleLegacyAddress(detailedAddress || '', [
    wards.find(w => String(w.code) === ward)?.name || '',
    districts.find(d => String(d.code) === district)?.name || '',
    provinces.find(p => String(p.code) === province)?.name || '',
  ]);
  const permanent = permanentAddress?.trim() || '';
  const hasChoice = Boolean(permanent && legacy && permanent !== legacy);
  const address = hasChoice && preferredSource === 'legacy' ? legacy : permanent || legacy;

  return (
    <section aria-label="Địa chỉ hành chính mới" className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-semibold text-green-700">Địa chỉ hành chính mới</h3>
      {hasChoice && (
        <SearchableSelect
          aria-label="Chọn địa chỉ cũ để chuyển đổi"
          value={preferredSource}
          onValueChange={setPreferredSource}
          searchPlaceholder="Tìm loại địa chỉ…"
          options={[{ value: 'permanent', label: 'Địa chỉ thường trú' }, { value: 'legacy', label: 'Địa chỉ theo tỉnh / quận / phường đã chọn' }]}
        />
      )}
      <AdministrativeAddressPreview address={address} />
    </section>
  );
}
