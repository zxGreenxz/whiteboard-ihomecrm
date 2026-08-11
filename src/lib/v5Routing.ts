import { isValidLatLng } from "@/lib/geo";

export interface RouteCoordinates {
  latitude: number;
  longitude: number;
}

export interface V5RouteStop {
  building_id: string;
  priority_bucket: number | string | null;
  latitude: number | null;
  longitude: number | null;
  checked_today?: boolean;
}

export interface V5SavedRoutePlan {
  version: number;
  date: string;
  building_ids: string[];
  mode: "priority" | "manual" | "optimized";
  updated_at: string;
}

const EARTH_RADIUS_KM = 6_371;
const DISTANCE_EPSILON_KM = 1e-9;

const NAMED_BUCKETS: Record<string, number> = {
  FULL_OVERDUE: 0,
  NEVER_FULL: 0,
  TOUCH_OVERDUE: 1,
  VISIT_DUE: 1,
  DUE_SOON: 2,
  FRESH: 3,
  CHECKED_TODAY: 4,
  CHECKED_FULL_TODAY: 4,
  COMPLETED_TODAY: 4,
};

export function normalizePriorityBucket(bucket: V5RouteStop["priority_bucket"]): number {
  if (typeof bucket === "number" && Number.isFinite(bucket)) return bucket;
  if (typeof bucket !== "string") return Number.MAX_SAFE_INTEGER;

  const numeric = Number(bucket);
  if (Number.isFinite(numeric)) return numeric;
  return NAMED_BUCKETS[bucket.trim().toUpperCase()] ?? Number.MAX_SAFE_INTEGER;
}

export function isActiveRouteCandidate(stop: V5RouteStop): boolean {
  const bucket = normalizePriorityBucket(stop.priority_bucket);
  return !stop.checked_today && bucket >= 0 && bucket <= 2;
}

/**
 * Type guard GIỮ NGUYÊN kiểu đầu vào.
 *
 * Bản cũ khai `value is RouteCoordinates`, nên `stops.filter(hasRouteCoordinates)`
 * thu hẹp `T[]` xuống `RouteCoordinates[]` và ĐÁNH RƠI `T`. Hệ quả lan ra cả
 * module: `result.push(stop)` với `result: T[]` báo lỗi, `sort` mất kiểu phần
 * tử, hàm trả `T[]` không khớp. Tám lỗi `strictNullChecks` của file này đều là
 * một gốc đó chứ không phải tám chỗ khác nhau.
 *
 * `value is T & RouteCoordinates` giao kiểu gốc với ràng buộc toạ độ: sau khi
 * lọc, phần tử vẫn là `T` và toạ độ đã chắc chắn không null.
 */
export function hasRouteCoordinates<
  T extends Pick<V5RouteStop, "latitude" | "longitude"> | RouteCoordinates,
>(value: T | null | undefined): value is T & RouteCoordinates {
  return !!value && isValidLatLng(value.latitude, value.longitude);
}

export function haversineKm(a: RouteCoordinates, b: RouteCoordinates): number {
  const toRadians = (degrees: number) => degrees * (Math.PI / 180);
  const latDelta = toRadians(b.latitude - a.latitude);
  const lngDelta = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const sinLat = Math.sin(latDelta / 2);
  const sinLng = Math.sin(lngDelta / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function routeDistanceKm<T extends V5RouteStop>(route: readonly T[], origin: RouteCoordinates): number {
  let total = 0;
  let previous = origin;
  for (const stop of route) {
    if (!hasRouteCoordinates(stop)) continue;
    total += haversineKm(previous, stop);
    previous = stop;
  }
  return total;
}

export function nearestNeighborRoute<T extends V5RouteStop>(
  stops: readonly T[],
  origin: RouteCoordinates,
): T[] {
  const remaining = stops.filter(hasRouteCoordinates).map((stop, index) => ({ stop, index }));
  const result: T[] = [];
  let current = origin;

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = haversineKm(current, remaining[0].stop);
    for (let index = 1; index < remaining.length; index += 1) {
      const distance = haversineKm(current, remaining[index].stop);
      if (
        distance < bestDistance - DISTANCE_EPSILON_KM
        || (Math.abs(distance - bestDistance) <= DISTANCE_EPSILON_KM
          && remaining[index].index < remaining[bestIndex].index)
      ) {
        bestIndex = index;
        bestDistance = distance;
      }
    }

    const [{ stop }] = remaining.splice(bestIndex, 1);
    result.push(stop);
    current = stop;
  }

  return result;
}

export function improveRouteTwoOpt<T extends V5RouteStop>(
  route: readonly T[],
  origin: RouteCoordinates,
): T[] {
  if (route.length < 3) return [...route];

  let best = [...route];
  let bestDistance = routeDistanceKm(best, origin);
  let improved = true;

  while (improved) {
    improved = false;
    for (let start = 0; start < best.length - 1; start += 1) {
      for (let end = start + 1; end < best.length; end += 1) {
        const candidate = [
          ...best.slice(0, start),
          ...best.slice(start, end + 1).reverse(),
          ...best.slice(end + 1),
        ];
        const candidateDistance = routeDistanceKm(candidate, origin);
        if (candidateDistance < bestDistance - DISTANCE_EPSILON_KM) {
          best = candidate;
          bestDistance = candidateDistance;
          improved = true;
        }
      }
    }
  }

  return best;
}

function groupByPriority<T extends V5RouteStop>(stops: readonly T[]): Array<[number, T[]]> {
  const groups = new Map<number, T[]>();
  for (const stop of stops) {
    const bucket = normalizePriorityBucket(stop.priority_bucket);
    const group = groups.get(bucket);
    if (group) group.push(stop);
    else groups.set(bucket, [stop]);
  }
  return [...groups.entries()].sort(([left], [right]) => left - right);
}

/** Optimises distance inside each priority bucket without letting a lower bucket jump ahead. */
export function optimizeRouteByPriority<T extends V5RouteStop>(
  stops: readonly T[],
  origin: RouteCoordinates,
): T[] {
  const result: T[] = [];
  let currentOrigin = origin;

  for (const [, group] of groupByPriority(stops)) {
    const withCoordinates = group.filter(hasRouteCoordinates);
    const withoutCoordinates = group.filter((stop) => !hasRouteCoordinates(stop));
    const nearest = nearestNeighborRoute(withCoordinates, currentOrigin);
    const optimized = improveRouteTwoOpt(nearest, currentOrigin);
    result.push(...optimized, ...withoutCoordinates);

    const lastRoutable = optimized.at(-1);
    if (lastRoutable && hasRouteCoordinates(lastRoutable)) currentOrigin = lastRoutable;
  }

  return result;
}

export function optimizeActiveRouteByPriority<T extends V5RouteStop>(
  stops: readonly T[],
  origin: RouteCoordinates,
): T[] {
  return optimizeRouteByPriority(stops.filter(isActiveRouteCandidate), origin);
}

export function coerceSavedRoutePlan(value: unknown): V5SavedRoutePlan | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    version?: unknown;
    date?: unknown;
    building_ids?: unknown;
    mode?: unknown;
    updated_at?: unknown;
  };
  if (typeof candidate.date !== "string" || !Array.isArray(candidate.building_ids)) return null;

  const seen = new Set<string>();
  const buildingIds = candidate.building_ids.filter((id): id is string => {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return {
    version: typeof candidate.version === "number" && Number.isFinite(candidate.version)
      ? candidate.version
      : 1,
    date: candidate.date,
    building_ids: buildingIds,
    mode: candidate.mode === "manual" || candidate.mode === "optimized"
      ? candidate.mode
      : "priority",
    updated_at: typeof candidate.updated_at === "string" ? candidate.updated_at : "",
  };
}

/** Reconciles a route snapshot with fresh server stops using the selected mode. */
export function reconcileRouteOrder<T extends V5RouteStop>(
  stops: readonly T[],
  buildingIds: readonly string[],
  mode: V5SavedRoutePlan["mode"],
): T[] {
  const serverOrder = [...stops];
  if (mode === "priority") return serverOrder;

  if (mode === "optimized") {
    const savedRank = new Map<string, number>();
    for (const buildingId of buildingIds) {
      if (!savedRank.has(buildingId)) savedRank.set(buildingId, savedRank.size);
    }

    return groupByPriority(serverOrder).flatMap(([, group]) => {
      const savedStops = group
        .filter((stop) => savedRank.has(stop.building_id))
        .sort((left, right) => savedRank.get(left.building_id)! - savedRank.get(right.building_id)!);
      const newStops = group.filter((stop) => !savedRank.has(stop.building_id));
      return [...savedStops, ...newStops];
    });
  }

  const byId = new Map(serverOrder.map((stop) => [stop.building_id, stop]));
  const restored: T[] = [];
  const restoredIds = new Set<string>();
  for (const buildingId of buildingIds) {
    const stop = byId.get(buildingId);
    if (!stop || restoredIds.has(buildingId)) continue;
    restored.push(stop);
    restoredIds.add(buildingId);
  }
  for (const stop of serverOrder) {
    if (!restoredIds.has(stop.building_id)) restored.push(stop);
  }
  return restored;
}

/**
 * Applies today's persisted route semantics to the current server route.
 * Priority follows the exact server order, manual restores a global snapshot,
 * and optimized restores its snapshot inside each current priority bucket.
 */
export function applySavedRouteOrder<T extends V5RouteStop>(
  stops: readonly T[],
  date: string,
  savedValue: unknown,
): T[] {
  const saved = coerceSavedRoutePlan(savedValue);
  if (!saved || saved.date !== date) return [...stops];
  return reconcileRouteOrder(stops, saved.building_ids, saved.mode);
}

/**
 * Nơi có thể dựng link Google Maps: hoặc có toạ độ, hoặc có nhãn để tìm.
 *
 * KHÔNG dùng `Partial<RouteCoordinates>`: nó cho `number | undefined`, trong khi
 * điểm dừng thật (`V5RouteStop`) mang `number | null` — bảng DB để null khi chưa
 * có GPS. Khai bằng `Partial` nghĩa là mô tả một hình dạng không tồn tại trong
 * dữ liệu, và mọi lời gọi truyền stop thật đều phải ép kiểu để lọt qua.
 */
type MapsPlace = {
  latitude?: number | null;
  longitude?: number | null;
  label?: string | null;
};

function mapsCoordinates(place: RouteCoordinates): string {
  const latitude = Number(place.latitude.toFixed(6));
  const longitude = Number(place.longitude.toFixed(6));
  return `${latitude},${longitude}`;
}

function mapsPlaceValue(place: MapsPlace | null | undefined): string | null {
  if (hasRouteCoordinates(place as RouteCoordinates)) {
    return mapsCoordinates(place as RouteCoordinates);
  }
  const label = place?.label?.trim();
  return label || null;
}

export function buildGoogleMapsLegUrl(
  destination: MapsPlace,
  origin?: MapsPlace | null,
): string | null {
  const destinationValue = mapsPlaceValue(destination);
  if (!destinationValue) return null;

  const params = new URLSearchParams({
    api: "1",
    destination: destinationValue,
    travelmode: "driving",
  });
  const originValue = mapsPlaceValue(origin);
  if (originValue) params.set("origin", originValue);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export interface GoogleMapsRouteChunk {
  stop_ids: string[];
  url: string;
}

/** Builds bounded Google Maps routes; each URL contains at most four new stops. */
export function buildGoogleMapsRouteChunks<T extends V5RouteStop>(
  stops: readonly T[],
  currentPosition?: RouteCoordinates | null,
  maxStopsPerChunk = 4,
): GoogleMapsRouteChunk[] {
  const active = stops.filter(isActiveRouteCandidate).filter(hasRouteCoordinates);
  const chunkSize = Math.max(1, Math.floor(maxStopsPerChunk));
  const chunks: GoogleMapsRouteChunk[] = [];
  let previousDestination = currentPosition && hasRouteCoordinates(currentPosition)
    ? currentPosition
    : null;

  for (let index = 0; index < active.length; index += chunkSize) {
    const chunkStops = active.slice(index, index + chunkSize);
    const destination = chunkStops.at(-1);
    if (!destination) continue;

    const params = new URLSearchParams({
      api: "1",
      destination: mapsCoordinates(destination),
      travelmode: "driving",
    });
    if (previousDestination) {
      params.set("origin", mapsCoordinates(previousDestination));
    }
    const waypoints = chunkStops.slice(0, -1)
      .map(mapsCoordinates);
    if (waypoints.length > 0) params.set("waypoints", waypoints.join("|"));

    chunks.push({
      stop_ids: chunkStops.map((stop) => stop.building_id),
      url: `https://www.google.com/maps/dir/?${params.toString()}`,
    });
    previousDestination = destination;
  }
  return chunks;
}

export function findPreviousRouteCoordinates<T extends V5RouteStop>(
  route: readonly T[],
  index: number,
  currentPosition?: RouteCoordinates | null,
): RouteCoordinates | null {
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    // Buộc vào một `const` trước khi kiểm: TypeScript KHÔNG giữ được thu hẹp kiểu
    // qua `route[previous]` khi `previous` là biến thay đổi trong vòng lặp, nên
    // `route[previous].latitude` sau đó vẫn là `number | null`. Đây không phải
    // lỗi của guard mà là giới hạn của phân tích luồng trên truy cập chỉ số.
    const truoc = route[previous];
    if (hasRouteCoordinates(truoc)) {
      return { latitude: truoc.latitude, longitude: truoc.longitude };
    }
  }
  return currentPosition && hasRouteCoordinates(currentPosition) ? currentPosition : null;
}
