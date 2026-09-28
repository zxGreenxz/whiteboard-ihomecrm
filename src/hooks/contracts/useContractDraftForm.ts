import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useBuildingServices } from '@/hooks/useBuildingServices';
import { useOrganization } from '@/contexts/OrganizationContext';
import type { ContractFormData } from '@/lib/contractValidation';
import { emptyContractDraftPayload, emptyDraftOwner, type DraftOwner, type ContractDraft, type ContractDraftPayload } from '@/lib/contractDrafts';
import type { ContractPrefill, SelectedCustomer, SelectedService } from '@/components/contracts/contract-form/types';
import type { CustomerBasic } from '@/components/contracts/CustomerSelectionDialog';
import type { ServiceBasic } from '@/components/contracts/ServiceSelectionDialog';

/** Reuses the form sections, but does not instantiate any official-contract/money mutation. */
export function useContractDraftForm(open: boolean, draft?: ContractDraft, prefill?: ContractPrefill) {
  const form = useForm<ContractFormData>({ defaultValues: emptyContractDraftPayload().form });
  const { selectedOrganizationId } = useOrganization();
  const { data: buildingRows = [] } = useBuildings({ enabled: open });
  const buildings = buildingRows.filter(building => building.organization_id === selectedOrganizationId);
  const [selectedBuildingId, setSelectedBuildingId] = useState('');
  const [selectedCustomers, setSelectedCustomers] = useState<SelectedCustomer[]>([]);
  const [selectedServices, setSelectedServices] = useState<SelectedService[]>([]);
  const [savedDefaultServices, setSavedDefaultServices] = useState<SelectedService[] | null>(null);
  const [useCustomServices, setUseCustomServices] = useState(false);
  const [owner, setOwner] = useState<DraftOwner>(emptyDraftOwner);
  const [customerDialogOpen, setCustomerDialogOpen] = useState(false);
  const [serviceDialogOpen, setServiceDialogOpen] = useState(false);
  const { data: rooms = [] } = useRooms(selectedBuildingId || undefined);
  const buildingServicesQuery = useBuildingServices(selectedBuildingId);
  const buildingActiveServices = useMemo(() => (buildingServicesQuery.data ?? []).filter(b => b.is_active), [buildingServicesQuery.data]);
  const currentBuildingServices = useMemo<SelectedService[]>(() => buildingActiveServices.map(b => ({
    id: b.service_id, name: b.service?.name ?? '', unit_price: b.unit_price_override ?? b.service?.unit_price ?? 0,
    unit: b.service?.unit ?? null, type: b.service?.type ?? '', pricing_type: b.service?.pricing_type ?? null,
    initial_reading: 0, quantity: b.service?.pricing_type === 'DON_GIA_THEO_NGUOI' ? Math.max(1, selectedCustomers.length) : 1,
  })), [buildingActiveServices, selectedCustomers.length]);
  const buildingServicesAsSelected = savedDefaultServices ?? currentBuildingServices;
  useEffect(() => {
    if (!open) return;
    const payload = draft?.payload ?? emptyContractDraftPayload();
    form.reset({ ...payload.form, room_id: draft?.room_id ?? prefill?.roomId ?? '' });
    setSelectedBuildingId(draft?.building_id ?? prefill?.buildingId ?? '');
    setSelectedCustomers(payload.customers.map(c => ({ id: c.id, full_name: c.full_name, phone: c.phone, id_number: c.id_number, is_representative: c.is_representative, notes: c.notes })));
    const restoredServices = payload.services.map(s => ({ id: s.id, name: s.name, unit: s.unit, type: s.type, pricing_type: s.pricing_type, unit_price: s.unit_price, initial_reading: s.initial_reading, quantity: s.quantity }));
    setSelectedServices(restoredServices);
    setSavedDefaultServices(draft ? restoredServices : null);
    setUseCustomServices(payload.use_custom_services);
    setOwner(payload.owner ?? emptyDraftOwner());
    // A refreshed list must never overwrite unsaved input in an open editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft?.id]);
  const handleBuildingChange = (id: string) => {
    setSelectedBuildingId(id); form.setValue('room_id', '');
    setSelectedServices([]); setUseCustomServices(false);
    setSavedDefaultServices(null);
  };
  const handleRoomChange = (id: string) => {
    form.setValue('room_id', id);
    if (!draft) {
      const room = rooms.find(r => r.id === id);
      form.setValue('rent_price', Number(room?.rent_price ?? 0));
      form.setValue('total_deposit', Number(room?.rent_price ?? 0));
    }
  };
  const handleCustomersSelected = (customers: CustomerBasic[]) => {
    const next = customers.map(c => selectedCustomers.find(s => s.id === c.id) ?? { ...c, is_representative: false, notes: null });
    if (next.length && !next.some(c => c.is_representative)) next[0].is_representative = true;
    setSelectedCustomers(next);
  };
  const handleRemoveCustomer = (id: string) => setSelectedCustomers(current => {
    const next = current.filter(c => c.id !== id);
    if (next.length && !next.some(c => c.is_representative)) next[0] = { ...next[0], is_representative: true };
    return next;
  });
  const handleServicesSelected = (services: ServiceBasic[]) => setSelectedServices(services.map(s => selectedServices.find(c => c.id === s.id) ?? { ...s, initial_reading: 0, quantity: 1 }));
  const getPayload = (): ContractDraftPayload => {
    const values = form.getValues();
    return { form: { room_id: values.room_id, signed_date: values.signed_date, start_date: values.start_date,
      end_date: values.end_date, rent_price: values.rent_price, total_deposit: values.total_deposit,
      payment_cycle: values.payment_cycle, start_billing_date: values.start_billing_date ?? '',
      end_billing_date: values.end_billing_date ?? '', notes: values.notes ?? '',
      discount_months: values.discount_months ?? 0, discount_amount_per_month: values.discount_amount_per_month ?? 0 },
      customers: selectedCustomers.map(c => ({ ...c })),
      services: (useCustomServices ? selectedServices : buildingServicesAsSelected).map(s => ({
        id: s.id, name: s.name, unit_price: s.unit_price, unit: s.unit, type: s.type,
        pricing_type: s.pricing_type ?? null, initial_reading: s.initial_reading, quantity: s.quantity,
      })),
      use_custom_services: useCustomServices, owner,
    };
  };
  return { form, buildings, selectedBuildingId, filteredRooms: selectedBuildingId ? rooms : [],
    selectedCustomers, selectedServices, useCustomServices, buildingActiveServices, buildingServicesAsSelected,
    customerDialogOpen, setCustomerDialogOpen, serviceDialogOpen, setServiceDialogOpen,
    handleBuildingChange, handleRoomChange, handleCustomersSelected, handleRemoveCustomer,
    handleRepresentativeChange: (id: string) => setSelectedCustomers(c => c.map(row => ({ ...row, is_representative: row.id === id }))),
    handleCustomerNotesChange: (id: string, notes: string) => setSelectedCustomers(c => c.map(row => row.id === id ? { ...row, notes: notes || null } : row)),
    handleServicesSelected,
    handleToggleCustomServices: (on: boolean) => {
      setUseCustomServices(on);
      if (on && !selectedServices.length) setSelectedServices(buildingServicesAsSelected);
      if (!on && buildingServicesQuery.isSuccess) setSavedDefaultServices(currentBuildingServices);
    },
    handleRemoveService: (id: string) => setSelectedServices(c => c.filter(row => row.id !== id)),
    handleServiceFieldChange: (id: string, field: 'initial_reading' | 'quantity' | 'unit_price', value: number) => setSelectedServices(c => c.map(row => row.id === id ? { ...row, [field]: value } : row)),
    getPayload, owner, setOwner,
  };
}
