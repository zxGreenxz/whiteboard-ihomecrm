import { useState } from "react";
import { Check, DoorOpen, Search } from "lucide-react";

import type { DoorDevice } from "@/lib/door-access/dto";
import { DEVICE_KIND_LABEL } from "@/lib/door-access/format";
import { deviceCountText, searchDeviceGroups } from "@/lib/door-access/mobile";

import { MobileSheet } from "./MobileSheet";
import { OnlineMark } from "./MobileDoorTab";

export function DoorPickerSheet({
  open,
  devices,
  selectedId,
  onlineOf,
  onClose,
  onSelect,
}: {
  open: boolean;
  devices: readonly DoorDevice[];
  selectedId: string | null;
  onlineOf: (device: DoorDevice) => boolean | null;
  onClose: () => void;
  onSelect: (deviceId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const groups = searchDeviceGroups(devices, query);
  return (
    <MobileSheet
      open={open}
      onClose={() => {
        setQuery("");
        onClose();
      }}
      title="Chọn cửa"
      description={deviceCountText(devices)}
    >
      <label className="search">
        <Search className="h-[18px] w-[18px]" aria-hidden="true" />
        <span className="sr-only">Tìm cửa</span>
        <input type="search" placeholder="Tìm theo toà hoặc tên cửa" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="flex flex-col gap-3.5">
        {groups.map((group) => (
          <section key={group.building} className="flex flex-col gap-1.5" aria-label={`Toà ${group.building}`}>
            <div className="flex items-baseline justify-between px-0.5">
              <span className="mono text-sm font-bold">{group.building}</span>
              <span className="text-xs text-[var(--ink-mute)]">{group.devices.length} cửa</span>
            </div>
            {group.devices.map((device) => {
              const current = device.id === selectedId;
              const online = onlineOf(device);
              return (
                <button
                  key={device.id}
                  type="button"
                  className="pick-item"
                  aria-current={current ? "true" : undefined}
                  onClick={() => {
                    setQuery("");
                    onSelect(device.id);
                  }}
                >
                  <span className={online === false ? "door-mark off" : "door-mark"} style={{ width: 38, height: 38, borderRadius: 11 }}>
                    <DoorOpen className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="row-main">
                    <span className="row-t">{device.display_name}</span>
                    <span className="row-s">{DEVICE_KIND_LABEL[device.device_kind]}</span>
                  </span>
                  <OnlineMark online={online} />
                  {current && <Check className="h-5 w-5 shrink-0 text-[var(--brand)]" aria-label="Đang chọn" />}
                </button>
              );
            })}
          </section>
        ))}
        {groups.length === 0 && (
          <p className="m-0 py-2 text-center text-[13px] text-[var(--ink-mute)]">Không có cửa nào khớp «{query}». Thử gõ tên toà.</p>
        )}
      </div>
    </MobileSheet>
  );
}
