"""Reproducible research quantization with generated nonpersonal text only."""
from pathlib import Path
import sys,json,hashlib,gzip,math
import argparse,importlib.metadata
parser=argparse.ArgumentParser()
parser.add_argument('directory',type=Path,help='Public model preparation directory OUTSIDE the repository')
folder=parser.parse_args().directory.resolve()
repo=Path(__file__).resolve().parents[2]
if folder.is_relative_to(repo): raise ValueError('Use an external preparation directory')
manifest=json.loads((repo/'vendor/cccd-ocr/manifest.json').read_text())
for package,version in manifest['quantization']['versions'].items():
    if importlib.metadata.version(package)!=version: raise ValueError('Version mismatch: '+package)
for name,spec in manifest['quantization']['originals'].items():
    if hashlib.sha256((folder/name).read_bytes()).hexdigest()!=spec['sha256']: raise ValueError('Source hash mismatch: '+name)
import numpy as np,onnx
from PIL import Image,ImageDraw,ImageFont,ImageFilter
from onnxruntime.quantization import quantize_static,quantize_dynamic,QuantType,QuantFormat,CalibrationDataReader
texts=['NGUYỄN MINH AN','TRẦN THỊ BÌNH','LÊ QUỐC DŨNG','PHẠM THỊ HỒNG','ĐẶNG VĂN KHÁNH','Số 123, Đường Hoa Sen, Phường An Bình','Quận Bình Thạnh, Thành phố Hồ Chí Minh','Nơi thường trú / Place of residence:','Hà Nội, Đà Nẵng, Đồng Nai, Trà Vinh','Ắ Ằ Ặ Ẳ Ẵ Ấ Ầ Ẩ Ẫ Ậ Ế Ề Ể Ễ Ệ','Ư Ứ Ừ Ử Ữ Ự Ơ Ớ Ờ Ở Ỡ Ợ','0123456789 / 01/01/2000']
class Synthetic(CalibrationDataReader):
    def __init__(self):
        self.rows=[]
        for i,text in enumerate(texts):
            font=ImageFont.truetype(str(folder/'NotoSans.ttf'),22+(i%3)*4)
            box=font.getbbox(text)
            image=Image.new('RGB',(box[2]+12,box[3]-box[1]+12),(235,239,216) if i%2 else 'white')
            ImageDraw.Draw(image).text((6,6-box[1]),text,font=font,fill=(15,25,20))
            if i%3==1:image=image.filter(ImageFilter.GaussianBlur(.4))
            w=max(32,min(512,math.ceil(32*image.width/image.height/10)*10))
            arr=np.asarray(image.resize((w,32),Image.Resampling.LANCZOS),np.float32).transpose(2,0,1)[None]/255
            self.rows.append({'img':arr})
        self.iterator=iter(self.rows)
    def get_next(self):return next(self.iterator,None)
encoder=onnx.load(str(folder/'vgg_encoder.onnx'))
onnx.save_model(encoder,str(folder/'encoder_merged.onnx'),save_as_external_data=False)
quantize_static(str(folder/'encoder_merged.onnx'),str(folder/'encoder_qdq.onnx'),Synthetic(),quant_format=QuantFormat.QDQ,op_types_to_quantize=['Conv','MatMul','Gemm'],per_channel=True,activation_type=QuantType.QUInt8,weight_type=QuantType.QInt8)
quantize_dynamic(str(folder/'vgg_decoder.onnx'),str(folder/'decoder_int8.onnx'),op_types_to_quantize=['MatMul','Gemm'],weight_type=QuantType.QInt8,per_channel=True)
for name in ['encoder_qdq.onnx','decoder_int8.onnx']:
    data=(folder/name).read_bytes()
    if hashlib.sha256(data).hexdigest()!=manifest['files'][name]['sha256']: raise ValueError('Derived hash mismatch: '+name)
    print(json.dumps({'file':name,'bytes':len(data),'gzipBytes':len(gzip.compress(data)),'sha256':hashlib.sha256(data).hexdigest()}),flush=True)
