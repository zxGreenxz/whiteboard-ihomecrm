// Thanh bộ lọc nhà của bảng "LN được chia Nhà × Tháng": chip "Tất cả" + các bộ lọc người xem tự tạo.
// Bộ lọc chỉ đổi cột nào được BÀY; lưu theo tài khoản trên máy chủ (xem hooks/useBuildingFilterState).

import { useState, type FormEvent } from 'react';
import { Plus, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  BUILDING_FILTER_NAME_MAX, activeBuildingFilter, buildingFilterDraftError, removeBuildingFilter, upsertBuildingFilter,
  type BuildingFilterState,
} from '@/lib/profitLedger/buildingFilters';
import type { BuildingColumn } from '@/lib/profitLedger/selfView';

const chipClass = (active: boolean) =>
  `rounded-full border px-3 py-1 text-[12px] font-semibold leading-4 transition-colors ${
    active
      ? 'border-emerald-700 bg-emerald-700 text-white'
      : 'border-[var(--ph-line)] bg-white text-[var(--ph-ink-2)] hover:bg-[#f3f6f4]'
  }`;

interface DraftState {
  /** null = đang tạo mới. */
  editingId: string | null;
  name: string;
  keys: string[];
}

export function BuildingFilterBar({ buildings, state, onChange, syncError = null, onRetry }: {
  /** Mọi nhà chọn được (kể cả nhà ngoài năm/tháng đang xem). */
  buildings: readonly BuildingColumn[];
  state: BuildingFilterState;
  onChange: (next: BuildingFilterState) => void;
  /** Chưa đọc / chưa lưu được lên tài khoản (bộ lọc vẫn dùng được trên trình duyệt này). */
  syncError?: string | null;
  onRetry?: () => void;
}) {
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = activeBuildingFilter(state);
  // Chỉ tính nhà còn trong danh sách: nhà đã rời sổ không được đếm, không được lưu lại.
  const draftKeys = draft ? buildings.map((b) => b.key).filter((key) => draft.keys.includes(key)) : [];

  const open = (next: DraftState) => { setDraft(next); setError(null); };
  const close = () => { setDraft(null); setError(null); };
  const toggleKey = (key: string, checked: boolean) => {
    setError(null);
    setDraft((previous) => previous && ({
      ...previous,
      keys: checked ? [...new Set([...previous.keys, key])] : previous.keys.filter((k) => k !== key),
    }));
  };
  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (!draft) return;
    const problem = buildingFilterDraftError({ name: draft.name, keys: draftKeys }, state.presets, draft.editingId);
    if (problem) { setError(problem); return; }
    onChange(upsertBuildingFilter(state, { id: draft.editingId ?? crypto.randomUUID(), name: draft.name, keys: draftKeys }));
    close();
  };
  const remove = () => {
    if (!draft?.editingId) return;
    onChange(removeBuildingFilter(state, draft.editingId));
    close();
  };

  return (
    <>
      <div className="ph-card__push" role="group" aria-label="Bộ lọc nhà">
        <button type="button" className={chipClass(active === null)} aria-pressed={active === null} onClick={() => onChange({ ...state, activeId: null })}>
          Tất cả
        </button>
        {state.presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={chipClass(preset.id === active?.id)}
            aria-pressed={preset.id === active?.id}
            title={`${preset.keys.length} nhà`}
            onClick={() => onChange({ ...state, activeId: preset.id })}
          >
            {preset.name}
          </button>
        ))}
        {active && (
          <button type="button" className="ph-mini-btn" onClick={() => open({ editingId: active.id, name: active.name, keys: [...active.keys] })}>
            <SlidersHorizontal className="mr-1 inline h-3 w-3" aria-hidden="true" />Sửa bộ lọc
          </button>
        )}
        <button type="button" className="ph-mini-btn" disabled={buildings.length === 0} onClick={() => open({ editingId: null, name: '', keys: [] })}>
          <Plus className="mr-1 inline h-3 w-3" aria-hidden="true" />Tạo bộ lọc
        </button>
        {syncError && (
          <p role="status" className="basis-full text-[11px] text-amber-800">
            {syncError}
            {onRetry && (
              <button type="button" className="ml-2 font-semibold underline" onClick={onRetry}>Thử lại</button>
            )}
          </p>
        )}
      </div>

      <Dialog open={draft !== null} onOpenChange={(next) => { if (!next) close(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{draft?.editingId ? 'Sửa bộ lọc nhà' : 'Tạo bộ lọc nhà'}</DialogTitle>
            <DialogDescription>
              Chọn các nhà muốn hiện trong bảng Nhà × Tháng. Bộ lọc chỉ đổi cách xem và được lưu theo tài khoản của bạn
              (mở lại trên máy hay trình duyệt khác vẫn còn).
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <form id="building-filter-form" className="space-y-3" onSubmit={save}>
              <div className="space-y-1.5">
                <Label htmlFor="building-filter-name">Tên bộ lọc</Label>
                <Input
                  id="building-filter-name"
                  value={draft.name}
                  maxLength={BUILDING_FILTER_NAME_MAX}
                  placeholder="Ví dụ: Cụm Phú Nhuận"
                  onChange={(event) => { setError(null); setDraft({ ...draft, name: event.target.value }); }}
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Nhà hiển thị ({draftKeys.length}/{buildings.length})</span>
                  <span className="flex gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => { setError(null); setDraft({ ...draft, keys: buildings.map((b) => b.key) }); }}>Chọn hết</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => { setError(null); setDraft({ ...draft, keys: [] }); }}>Bỏ chọn</Button>
                  </span>
                </div>
                <div className="grid max-h-64 grid-cols-2 gap-x-4 gap-y-2 overflow-y-auto rounded-md border p-3">
                  {buildings.map((building) => {
                    const id = `building-filter-${building.key}`;
                    return (
                      <div key={building.key} className="flex items-center gap-2">
                        <Checkbox id={id} checked={draft.keys.includes(building.key)} onCheckedChange={(checked) => toggleKey(building.key, checked === true)} />
                        <Label htmlFor={id} className="cursor-pointer font-normal">{building.name}</Label>
                      </div>
                    );
                  })}
                </div>
              </div>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </form>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            {draft?.editingId
              ? <Button type="button" variant="outline" className="text-destructive" onClick={remove}>Xoá bộ lọc</Button>
              : <span />}
            <span className="flex gap-2">
              <Button type="button" variant="outline" onClick={close}>Huỷ</Button>
              <Button type="submit" form="building-filter-form">Lưu bộ lọc</Button>
            </span>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
