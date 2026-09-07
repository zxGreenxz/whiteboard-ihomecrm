import { describe, expect, it, beforeAll } from 'vitest';
import { buildRegions, mapCorners } from '../candidates';
import { adaptiveThreshold, makeVariants, rasterizeRegion } from '../preprocess';

beforeAll(() => { if (!globalThis.ImageData) globalThis.ImageData = class {
  constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
} as typeof ImageData; });
describe('source coordinate and bounded raster queue', () => {
  it('covers all corners and tile seams without duplicate regions', () => {
    const regions = [...buildRegions(4000,3000)];
    expect(regions[0]).toEqual({x:0,y:0,width:4000,height:3000});
    expect(new Set(regions.map(r => JSON.stringify(r))).size).toBe(regions.length);
    for(const [x,y] of [[0,0],[3999,0],[0,2999],[3999,2999],[1100,1100]]) {
      expect(regions.slice(1).some(r=>x>=r.x&&y>=r.y&&x<r.x+r.width&&y<r.y+r.height)).toBe(true);
    }
    expect(regions.length).toBeLessThanOrEqual(25);
    expect([...buildRegions(120,100)]).toHaveLength(1);
    const panorama=[...buildRegions(100000,100)].slice(1);
    expect(panorama.some(r=>r.x+r.width===100000)).toBe(true);
  });
  it('maps all four corners after crop, anisotropic rounding and quiet-zone padding', () => {
    expect(mapCorners([{x:10,y:10},{x:210,y:10},{x:210,y:110},{x:10,y:110}],{x:500,y:300,width:100,height:50},220,120,10))
      .toEqual([{x:500,y:300},{x:600,y:300},{x:600,y:350},{x:500,y:350}]);
  });
  it('retains black in a two-level zero/255 histogram', () => {
    const pixels=new Uint8ClampedArray(64*4).fill(255);
    for(let x=0;x<32;x++)pixels[x*4]=pixels[x*4+1]=pixels[x*4+2]=0;
    const source=new ImageData(pixels,64,1);
    expect([...adaptiveThreshold(source).data]).toEqual([...source.data]);
  });
  it('always yields original first and composites alpha over white', () => {
    const source=new ImageData(new Uint8ClampedArray([0,0,0,0,0,0,0,255]),2,1);
    expect(makeVariants(source).next().value).toBe(source);
    expect([...rasterizeRegion(source,{x:0,y:0,width:2,height:1}).data]).toEqual([255,255,255,255,0,0,0,255]);
  });
});
