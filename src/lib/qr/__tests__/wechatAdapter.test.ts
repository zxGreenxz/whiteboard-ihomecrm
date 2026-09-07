import { describe, expect, it, vi } from 'vitest';
import { decodeWechatMat } from '../wechatAdapter';
import type { CvMat, WechatDetector, QrCv } from '../opencvRuntime';

describe('WeChat owned bindings', () => {
  it('returns all distinct payloads/corners and deletes each points mat and vectors', () => {
    const deleted: string[]=[];
    const points=[0,1,2].map(i=>({data32F:new Float32Array([i,0,10,0,10,10,i,10]),delete:()=>deleted.push('point'+i)}));
    const vector={get:(i:number)=>points[i],size:()=>3,delete:()=>deleted.push('points')};
    const codes={get:(i:number)=>['one','two','one'][i],size:()=>3,delete:()=>deleted.push('codes')};
    const cv={MatVector:class { constructor(){return vector;} }} as unknown as QrCv;
    const detector={detectAndDecode:()=>codes,delete:()=>{}} satisfies WechatDetector;
    const found=decodeWechatMat(cv,detector,{} as CvMat);
    expect(found.map(c=>c.text)).toEqual(['one','two']);
    expect(found[1].corners?.[0]).toEqual({x:1,y:0});
    expect(deleted.sort()).toEqual(['codes','point0','point1','point2','points']);
  });
  it('releases vectors and already acquired point when decoding or reading throws', () => {
    const deleted=vi.fn(),vector={get:()=>{throw Error('point read');},size:()=>1,delete:deleted};
    const cv={MatVector:class {constructor(){return vector;}}} as unknown as QrCv;
    const codes={get:()=> 'one',size:()=>1,delete:deleted};
    expect(()=>decodeWechatMat(cv,{detectAndDecode:()=>codes,delete:()=>{}},{} as CvMat)).toThrow('point read');
    expect(deleted).toHaveBeenCalledTimes(2);
    expect(()=>decodeWechatMat(cv,{detectAndDecode:()=>{throw Error('decode');},delete:()=>{}},{} as CvMat)).toThrow('decode');
    expect(deleted).toHaveBeenCalledTimes(3);
  });
});
