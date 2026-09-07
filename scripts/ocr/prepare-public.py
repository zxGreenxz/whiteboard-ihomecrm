"""Fetch pinned public source models into an external preparation directory.
No image input, credential, customer data or production Python dependency.
"""
import argparse,hashlib,json,urllib.request
from pathlib import Path
import onnx
parser=argparse.ArgumentParser()
parser.add_argument('directory',type=Path)
folder=parser.parse_args().directory.resolve()
repo=Path(__file__).resolve().parents[2]
if folder.is_relative_to(repo):raise ValueError('Use a preparation directory outside the repository')
manifest=json.loads((repo/'vendor/cccd-ocr/manifest.json').read_text())
folder.mkdir(parents=True,exist_ok=True)
sources={**manifest['quantization']['originals'],**{k:v for k,v in manifest['files'].items() if v['source'].startswith('https://')}}
for name,spec in sources.items():
    path=folder/name
    if not path.exists():
        with urllib.request.urlopen(spec['source'],timeout=120) as response: data=response.read()
    else:data=path.read_bytes()
    if len(data)!=spec['bytes'] or hashlib.sha256(data).hexdigest()!=spec['sha256']:raise ValueError('Source verification failed: '+name)
    path.write_bytes(data)
model=onnx.load(str(folder/'latin_PP-OCRv5_rec_mobile.onnx'),load_external_data=False)
metadata={entry.key:entry.value for entry in model.metadata_props}
dictionary=['blank']+metadata['character'].splitlines()+[' ']
if len(dictionary)!=504:raise ValueError('Unexpected dictionary shape')
data=json.dumps(dictionary,ensure_ascii=False).encode('utf-8')
if hashlib.sha256(data).hexdigest()!=manifest['files']['latin-dict.json']['sha256']:raise ValueError('Dictionary digest mismatch')
(folder/'latin-dict.json').write_bytes(data)
print(json.dumps({'verifiedSources':len(sources),'dictionaryEntries':len(dictionary)}))
