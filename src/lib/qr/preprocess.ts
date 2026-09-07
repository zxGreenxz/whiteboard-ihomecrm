import type { Roi } from './types';

export type VariantKind = 'raw' | 'nearest' | 'smooth' | 'contrast' | 'threshold' | 'unsharp' | 'border';
export const MAX_VARIANT_PIXELS = 4_000_000;

/** Crop directly from the original, allocating only the requested bounded raster.
 * Alpha is always composited over white, including already rasterized callers. */
export function rasterizeRegion(source: ImageData, roi: Roi, scale = 1, smooth = false, maxPixels = MAX_VARIANT_PIXELS): ImageData {
  const boundedScale = Math.min(scale,Math.sqrt(maxPixels/(roi.width*roi.height)));
  const width = Math.max(1,Math.round(roi.width*boundedScale)), height = Math.max(1,Math.round(roi.height*boundedScale));
  const output = new Uint8ClampedArray(width*height*4);
  const channel = (x: number,y: number,c: number) => {
    const i=(Math.min(source.height-1,Math.max(0,y))*source.width+Math.min(source.width-1,Math.max(0,x)))*4;
    const alpha=source.data[i+3]/255;
    return source.data[i+c]*alpha+255*(1-alpha);
  };
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const sx=roi.x+(x+.5)*roi.width/width-.5, sy=roi.y+(y+.5)*roi.height/height-.5;
    const ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy, offset=(y*width+x)*4;
    for(let c=0;c<3;c++) output[offset+c]=smooth
      ? channel(ix,iy,c)*(1-fx)*(1-fy)+channel(ix+1,iy,c)*fx*(1-fy)+channel(ix,iy+1,c)*(1-fx)*fy+channel(ix+1,iy+1,c)*fx*fy
      : channel(Math.round(sx),Math.round(sy),c);
    output[offset+3]=255;
  }
  return new ImageData(output,width,height);
}

function localFilter(source: ImageData, kind: 'contrast'|'threshold'|'unsharp'): ImageData {
  const {width,height}=source, stride=width+1;
  const gray=new Uint8Array(width*height), integral=new Float64Array((width+1)*(height+1));
  for(let y=0;y<height;y++) {
    let sum=0;
    for(let x=0;x<width;x++) {
      const i=y*width+x, p=i*4;
      gray[i]=Math.round(source.data[p]*.299+source.data[p+1]*.587+source.data[p+2]*.114);
      sum+=gray[i]; integral[(y+1)*stride+x+1]=integral[y*stride+x+1]+sum;
    }
  }
  const output=new Uint8ClampedArray(source.data.length), radius=kind==='unsharp'?1:15;
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const left=Math.max(0,x-radius),right=Math.min(width,x+radius+1),top=Math.max(0,y-radius),bottom=Math.min(height,y+radius+1);
    const mean=(integral[bottom*stride+right]-integral[top*stride+right]-integral[bottom*stride+left]+integral[top*stride+left])/((right-left)*(bottom-top));
    const i=y*width+x,value=gray[i];
    // <= is essential: a threshold of zero must preserve black modules.
    const filtered=kind==='threshold'?(value<=Math.max(0,mean-5)?0:255):kind==='contrast'?128+(value-mean)*2:value+(value-mean)*.4;
    output[i*4]=output[i*4+1]=output[i*4+2]=filtered;output[i*4+3]=255;
  }
  return new ImageData(output,width,height);
}
export const adaptiveThreshold = (image: ImageData): ImageData => localFilter(image,'threshold');

export function whiteBorder(image: ImageData, border = 12): ImageData {
  const width=image.width+2*border,height=image.height+2*border;
  const data=new Uint8ClampedArray(width*height*4).fill(255);
  for(let y=0;y<image.height;y++) data.set(image.data.subarray(y*image.width*4,(y+1)*image.width*4),((y+border)*width+border)*4);
  return new ImageData(data,width,height);
}

export function* makeVariants(image: ImageData, kinds: readonly VariantKind[] = ['raw','nearest']): Generator<ImageData> {
  const roi={x:0,y:0,width:image.width,height:image.height};
  for(const kind of kinds) {
    if(kind==='raw') yield image;
    else if(image.width*image.height>MAX_VARIANT_PIXELS) continue;
    else if(kind==='nearest'||kind==='smooth') {
      if(image.width*image.height*4<=MAX_VARIANT_PIXELS) yield rasterizeRegion(image,roi,2,kind==='smooth');
    } else if(kind==='border') {
      if((image.width+24)*(image.height+24)<=MAX_VARIANT_PIXELS) yield whiteBorder(image);
    } else yield localFilter(image,kind);
  }
}
