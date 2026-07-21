import { useEffect, useMemo, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDot,
  GripVertical,
  Loader2,
  LocateFixed,
  MapPinOff,
  Navigation,
  Route,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useSetUiPreference, useUiPreferences } from "@/hooks/useUiPreferences";
import type { Mission } from "@/hooks/useMyDay";
import { cn } from "@/lib/utils";
import {
  applySavedRouteOrder,
  buildGoogleMapsLegUrl,
  buildGoogleMapsRouteChunks,
  coerceSavedRoutePlan,
  hasRouteCoordinates,
  isActiveRouteCandidate,
  normalizePriorityBucket,
  optimizeActiveRouteByPriority,
  reconcileRouteOrder,
  type RouteCoordinates,
  type V5SavedRoutePlan,
} from "@/lib/v5Routing";

const ROUTE_PLAN_KEY = "v5_route_plan";
const ACTIVE_BUCKETS = new Set([0, 1, 2]);

const BUCKET_COPY: Record<number, { label: string; className: string }> = {
  0: { label: "Đến nhịp FULL", className: "bg-amber-100 text-amber-800" },
  1: { label: "Nên ghé hôm nay", className: "bg-sky-100 text-sky-800" },
  2: { label: "Sắp đến nhịp", className: "bg-cyan-50 text-cyan-800" },
  3: { label: "Mới được ghé", className: "bg-slate-100 text-slate-600" },
  4: { label: "Đã ghé hôm nay", className: "bg-emerald-100 text-emerald-800" },
};

interface RoutePlannerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  missions: Mission[];
  date: string;
  onStartInspection: (mission: Mission) => void;
}

function isActiveRouteStop(mission: Mission): boolean {
  return ACTIVE_BUCKETS.has(normalizePriorityBucket(mission.priority_bucket)) && isActiveRouteCandidate(mission);
}

function addressLabel(mission: Mission): string {
  return [mission.street_address, mission.ward, mission.district, mission.province]
    .map((part) => part?.trim())
    .filter((part, index, all): part is string => !!part && all.indexOf(part) === index)
    .join(", ");
}

function formatDate(date: string | null): string {
  if (!date) return "chưa có";
  const [year, month, day] = date.split("-");
  return year && month && day ? `${day}/${month}/${year}` : date;
}

function missionTiming(mission: Mission): string {
  const full = mission.days_since_full == null
    ? "FULL chưa có lần đầu"
    : `FULL ${mission.days_since_full}/${mission.full_interval_days} ngày`;
  const touch = mission.days_since_touch == null
    ? "chưa có lần ghé"
    : `ghé ${mission.days_since_touch}/${mission.touch_sla_days} ngày`;
  return `${full} · ${touch}`;
}

function missionHistory(mission: Mission): string {
  return `Ghé gần nhất ${formatDate(mission.last_touch_date)} · FULL gần nhất ${formatDate(mission.last_full_date)}`
    + (mission.last_full_by_name ? ` · ${mission.last_full_by_name}` : "");
}

function getCurrentPosition(): Promise<RouteCoordinates> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Thiết bị không hỗ trợ định vị"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      }),
      (error) => reject(error),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  });
}

interface SortableMissionProps {
  mission: Mission;
  index: number;
  count: number;
  mapsUrl: string | null;
  onMove: (from: number, to: number) => void;
  onStartInspection: (mission: Mission) => void;
}

function SortableMission({
  mission,
  index,
  count,
  mapsUrl,
  onMove,
  onStartInspection,
}: SortableMissionProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: mission.building_id,
  });
  const bucket = BUCKET_COPY[normalizePriorityBucket(mission.priority_bucket)] ?? BUCKET_COPY[3];

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "rounded-2xl border border-slate-200 bg-white p-3 shadow-sm",
        isDragging && "relative z-10 opacity-70 shadow-xl",
      )}
    >
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          className="mt-0.5 flex h-10 w-8 shrink-0 touch-none items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          aria-label={`Kéo để đổi vị trí ${mission.building_name}. Nhấn Space rồi dùng phím mũi tên.`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-5 w-5" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-slate-900 px-1.5 text-xs font-semibold text-white">
              {index + 1}
            </span>
            <h3 className="min-w-0 truncate text-sm font-semibold text-slate-900">{mission.building_name}</h3>
            <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", bucket.className)}>
              {bucket.label}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">{mission.reason}</p>
          <p className="mt-1 text-[11px] text-slate-400">{missionTiming(mission)}</p>
          <p className="mt-0.5 text-[11px] text-slate-400">{missionHistory(mission)}</p>
        </div>

        <div className="flex shrink-0 flex-col gap-1" aria-label="Đổi thứ tự bằng nút">
          <button
            type="button"
            className="rounded-md border p-1 text-slate-500 disabled:opacity-25"
            aria-label={`Đưa ${mission.building_name} lên một vị trí`}
            disabled={index === 0}
            onClick={() => onMove(index, index - 1)}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded-md border p-1 text-slate-500 disabled:opacity-25"
            aria-label={`Đưa ${mission.building_name} xuống một vị trí`}
            disabled={index === count - 1}
            onClick={() => onMove(index, index + 1)}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-2.5 flex items-center justify-end gap-2 border-t border-slate-100 pt-2.5">
        {mapsUrl ? (
          <a
            href={mapsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-sky-200 px-2.5 text-xs font-medium text-sky-700 hover:bg-sky-50"
            aria-label={`Mở Google Maps riêng đến ${mission.building_name}`}
          >
            <Navigation className="h-3.5 w-3.5" /> Mở riêng
          </a>
        ) : !hasRouteCoordinates(mission) ? (
          <span className="inline-flex h-8 items-center gap-1.5 px-2 text-[11px] text-slate-400">
            <MapPinOff className="h-3.5 w-3.5" /> Chưa có địa chỉ
          </span>
        ) : null}
        <Button size="sm" className="h-8" onClick={() => onStartInspection(mission)}>
          Kiểm tra
        </Button>
      </div>
    </article>
  );
}

function ReferenceMission({ mission }: { mission: Mission }) {
  const completed = mission.checked_today || normalizePriorityBucket(mission.priority_bucket) === 4;
  return (
    <div className={cn(
      "flex items-start gap-2.5 rounded-xl border px-3 py-2.5",
      completed ? "border-emerald-100 bg-emerald-50" : "border-slate-100 bg-slate-50",
    )}>
      {completed
        ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        : <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium">{mission.building_name}</span>
          <span className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold",
            completed ? "bg-emerald-100 text-emerald-800" : "bg-white text-slate-500",
          )}>
            {completed ? "Đã ghé hôm nay" : "Mới được ghé"}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-slate-500">
          {missionTiming(mission)}
        </p>
        {completed && (
          <p className="mt-0.5 text-[11px] text-emerald-700">Giữ lại để đối chiếu · không đưa lại vào tuyến hôm nay</p>
        )}
        <p className="mt-0.5 text-[11px] text-slate-400">{missionHistory(mission)}</p>
      </div>
    </div>
  );
}

export default function RoutePlannerSheet({
  open,
  onOpenChange,
  missions,
  date,
  onStartInspection,
}: RoutePlannerSheetProps) {
  const { data: preferences } = useUiPreferences();
  const setPreference = useSetUiPreference();
  const [ordered, setOrdered] = useState<Mission[]>([]);
  const [mode, setMode] = useState<V5SavedRoutePlan["mode"]>("priority");
  const [dirty, setDirty] = useState(false);
  const [currentPosition, setCurrentPosition] = useState<RouteCoordinates | null>(null);
  const [locating, setLocating] = useState(false);

  const activeMissions = useMemo(() => missions.filter(isActiveRouteStop), [missions]);
  const referenceMissions = useMemo(
    () => missions.filter((mission) => !isActiveRouteStop(mission)),
    [missions],
  );
  const routeChunks = useMemo(
    () => buildGoogleMapsRouteChunks(ordered, currentPosition),
    [currentPosition, ordered],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (!open) return;
    if (dirty) {
      setOrdered((current) => reconcileRouteOrder(
        activeMissions,
        current.map((mission) => mission.building_id),
        mode,
      ));
      return;
    }
    const savedValue = preferences?.[ROUTE_PLAN_KEY];
    const saved = coerceSavedRoutePlan(savedValue);
    setOrdered(applySavedRouteOrder(activeMissions, date, savedValue));
    setMode(saved?.date === date ? saved.mode : "priority");
  }, [activeMissions, date, dirty, mode, open, preferences]);

  useEffect(() => {
    if (open) return;
    setOrdered([]);
    setMode("priority");
    setDirty(false);
    setCurrentPosition(null);
  }, [open]);

  const moveMission = (from: number, to: number) => {
    if (to < 0 || to >= ordered.length) return;
    setOrdered((current) => arrayMove(current, from, to));
    setMode("manual");
    setDirty(true);
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ordered.findIndex((mission) => mission.building_id === active.id);
    const to = ordered.findIndex((mission) => mission.building_id === over.id);
    if (from < 0 || to < 0) return;
    moveMission(from, to);
  };

  const handleOptimize = async () => {
    if (ordered.length < 2) {
      toast.info("Tuyến hiện tại đã gọn rồi");
      return;
    }
    setLocating(true);
    try {
      const position = await getCurrentPosition();
      setCurrentPosition(position);
      setOrdered((current) => optimizeActiveRouteByPriority(current, position));
      setMode("optimized");
      setDirty(true);
      const noGps = ordered.filter((mission) => !hasRouteCoordinates(mission)).length;
      toast.success("Đã xếp tuyến gần nhất trong từng nhóm ưu tiên", {
        description: noGps > 0 ? `${noGps} toà chưa có GPS được giữ ở cuối nhóm.` : undefined,
      });
    } catch (error) {
      const denied = (error as GeolocationPositionError | undefined)?.code === 1;
      toast.info(denied ? "Bạn cần cho phép vị trí để tối ưu tuyến" : "Chưa lấy được vị trí hiện tại");
    } finally {
      setLocating(false);
    }
  };

  const handleSave = async () => {
    if (!date) {
      toast.info("Chưa tải xong ngày làm việc · thử lại sau một chút nhé");
      return;
    }
    const value: V5SavedRoutePlan = {
      version: 1,
      date,
      building_ids: ordered.map((mission) => mission.building_id),
      mode,
      updated_at: new Date().toISOString(),
    };
    try {
      await setPreference.mutateAsync({ key: ROUTE_PLAN_KEY, value });
      setDirty(false);
      toast.success("Đã lưu tuyến hôm nay trên tài khoản của bạn");
    } catch (error: unknown) {
      toast.info(error instanceof Error ? error.message : "Chưa lưu được tuyến · thử lại nhé");
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto flex h-[92dvh] w-full max-w-[540px] flex-col gap-0 overflow-hidden rounded-t-[28px] p-0"
      >
        <SheetHeader className="border-b bg-gradient-to-br from-sky-50 via-white to-emerald-50 px-5 pb-4 pt-5 text-left">
          <div className="flex items-center gap-2 text-sky-700">
            <span className="rounded-xl bg-sky-100 p-2"><Route className="h-5 w-5" /></span>
            <div>
              <SheetTitle>Xếp tuyến hôm nay</SheetTitle>
              <SheetDescription>
                Kéo-thả hoặc dùng nút mũi tên. Máy gợi ý, bạn quyết định thứ tự.
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mb-4 grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 justify-start gap-2 whitespace-normal px-3 py-2 text-left"
              disabled={locating || ordered.length === 0}
              onClick={handleOptimize}
            >
              {locating ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <LocateFixed className="h-4 w-4 shrink-0 text-sky-600" />}
              <span><b className="block text-xs">Tối ưu từ vị trí này</b><span className="text-[10px] font-normal text-slate-500">Gần nhất + giữ ưu tiên</span></span>
            </Button>
            <div className="flex min-h-11 items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-emerald-800">
              <Sparkles className="h-4 w-4 shrink-0" />
              <span>
                <b className="block text-xs">{ordered.length} toà trong tuyến</b>
                <span className="text-[10px]">
                  {mode === "optimized" ? "Đã tối ưu GPS" : mode === "manual" ? "Thứ tự của bạn" : "Ưu tiên hệ thống"}
                </span>
              </span>
            </div>
          </div>

          {routeChunks.length > 0 && (
            <div className="mb-4 rounded-2xl border border-sky-100 bg-sky-50/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-sky-900">Mở Google Maps theo chặng</span>
                <span className="text-[10px] text-sky-700">Tối đa 4 toà/chặng</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {routeChunks.map((chunk, index) => (
                  <a
                    key={chunk.stop_ids.join("-")}
                    href={chunk.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-2.5 text-xs font-medium text-sky-700 shadow-sm ring-1 ring-sky-100 hover:bg-sky-100"
                  >
                    <Navigation className="h-3.5 w-3.5" /> Chặng {index + 1} · {chunk.stop_ids.length} toà
                  </a>
                ))}
              </div>
            </div>
          )}

          <section aria-labelledby="active-route-title">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="active-route-title" className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                Tuyến cần ghé
              </h2>
              <span className="text-[10px] text-slate-400">Thiếu GPS sẽ mở riêng</span>
            </div>
            {ordered.length === 0 ? (
              <div className="rounded-2xl border border-dashed p-5 text-center text-sm text-slate-500">
                Không có toà nào đang đến nhịp · hôm nay nhẹ nhàng nhé.
              </div>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
                accessibility={{
                  screenReaderInstructions: {
                    draggable: "Nhấn Space để nhấc toà, dùng phím mũi tên để đổi vị trí, rồi nhấn Space để thả.",
                  },
                }}
              >
                <SortableContext
                  items={ordered.map((mission) => mission.building_id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-2.5">
                    {ordered.map((mission, index) => {
                      const destinationLabel = addressLabel(mission) || mission.building_name;
                      const missionHasGps = hasRouteCoordinates({
                        latitude: mission.latitude,
                        longitude: mission.longitude,
                      });
                      const mapsUrl = !missionHasGps
                        ? mission.public_map_url || buildGoogleMapsLegUrl({ label: destinationLabel })
                        : null;
                      return (
                        <SortableMission
                          key={mission.building_id}
                          mission={mission}
                          index={index}
                          count={ordered.length}
                          mapsUrl={mapsUrl}
                          onMove={moveMission}
                          onStartInspection={onStartInspection}
                        />
                      );
                    })}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </section>

          {referenceMissions.length > 0 && (
            <section className="mt-5" aria-labelledby="reference-route-title">
              <h2 id="reference-route-title" className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                Tất cả toà còn lại
              </h2>
              <div className="space-y-2">
                {referenceMissions.map((mission) => <ReferenceMission key={mission.building_id} mission={mission} />)}
              </div>
            </section>
          )}
        </div>

        <div className="border-t bg-white px-4 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-3">
          <Button className="h-11 w-full" disabled={setPreference.isPending} onClick={handleSave}>
            {setPreference.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Lưu tuyến hôm nay
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
