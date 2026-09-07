import type { Candidate, Point, Roi } from './types';

/** Full image precedes overlapping tiles so a code larger than a tile survives. */
export function* buildRegions(width: number, height: number): Generator<Roi> {
  if (width <= 0 || height <= 0) return;
  yield { x: 0, y: 0, width, height };
  const tile = 1536;
  if (width <= tile && height <= tile) return;
  const positions = (length: number) => {
    const last = Math.max(0, length-tile), result = [0];
    for (let p = 1152; p < last; p += 1152) result.push(p);
    if (last) result.push(last);
    return result;
  };
  const seen=new Set<string>();
  function* coordinates(): Generator<[number,number]> {
    // Prioritize every corner before the bounded row sweep, even for panoramas.
    for(const y of [0,Math.max(0,height-tile)])for(const x of [0,Math.max(0,width-tile)])yield[x,y];
    for(const y of positions(height))for(const x of positions(width))yield[x,y];
  }
  for(const [x,y] of coordinates()) {
    const key=`${x}:${y}`;
    if(seen.has(key))continue;
    if(seen.size===24)return;
    seen.add(key);
    yield{x,y,width:Math.min(tile,width),height:Math.min(tile,height)};
  }
}

export function mapCorners(corners: [Point,Point,Point,Point], roi: Roi, width: number, height: number, border = 0): [Point,Point,Point,Point] {
  return corners.map(p => ({
    x: roi.x+(p.x-border)*roi.width/(width-2*border),
    y: roi.y+(p.y-border)*roi.height/(height-2*border),
  })) as [Point,Point,Point,Point];
}

export function mapCandidates(candidates: Candidate[], roi: Roi, width: number, height: number, border = 0): Candidate[] {
  return candidates.map(candidate => ({...candidate, corners: candidate.corners && mapCorners(candidate.corners,roi,width,height,border)}));
}

export function distinctCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Map<string,Candidate>();
  for (const candidate of candidates) if (candidate.text && !seen.has(candidate.text)) seen.set(candidate.text,candidate);
  return [...seen.values()];
}
