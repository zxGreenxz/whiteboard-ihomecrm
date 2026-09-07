import {expect,it} from 'vitest';
import {readImageDimensions} from '../imageBounds';
it('reads PNG dimensions and rejects oversized pixels before image decode',()=>{
  const header=new Uint8Array(24);header.set([137,80,78,71,13,10,26,10]);header.set([73,72,68,82],12);
  const view=new DataView(header.buffer);view.setUint32(16,1000);view.setUint32(20,2000);
  expect(readImageDimensions(header)).toEqual({width:1000,height:2000});
  view.setUint32(20,25000);expect(readImageDimensions(header)).toBeNull();
});
it('rejects unknown/truncated image headers rather than asking decoder to allocate',()=>{
  expect(readImageDimensions(new Uint8Array([255,216,255,224,255,255]))).toBeNull();
  expect(readImageDimensions(new Uint8Array(30))).toBeNull();
});
it('reads JPEG frame dimensions across metadata and lossless WebP dimensions',()=>{
  const jpeg=new Uint8Array([255,216,255,224,0,4,0,0,255,192,0,11,8,1,0,2,0,1,1,17,0]);
  expect(readImageDimensions(jpeg)).toEqual({width:512,height:256});
  const webp=new Uint8Array(25);webp.set(new TextEncoder().encode('RIFF'),0);webp.set(new TextEncoder().encode('WEBPVP8L'),8);webp[20]=0x2f;new DataView(webp.buffer).setUint32(21,511|(255<<14),true);
  expect(readImageDimensions(webp)).toEqual({width:512,height:256});
});
