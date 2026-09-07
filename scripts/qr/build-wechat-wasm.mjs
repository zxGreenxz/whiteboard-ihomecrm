import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { patchBindings, sourceHashes, sha256 } from './csp-bindings.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Both build transforms enter the URL fingerprint. A new deployment can never
// reuse an older browser-cached module with a different wrapper contract.
const transformHash = sha256(Buffer.concat([
  await readFile(fileURLToPath(import.meta.url)),
  await readFile(resolve(root,'scripts/qr/csp-bindings.mjs')),
]));
const assetRoot = resolve(root,'public/qr-assets');
const output = resolve(assetRoot,transformHash.slice(0,16));
const notice = '// Modified by iHomeCRM: CSP static binding factories, external self-hosted WASM, ESM worker entry. Sources/licenses: manifest.json.\n';
const packages = {
  wechat: { package: 'qr-scanner-wechat', version: '0.1.3', artifact: 'dist/wasm.mjs', source: 'https://github.com/antfu/qr-scanner-wechat', license: 'MIT + Apache-2.0 (OpenCV/WeChat models)' },
  opencv: { package: '@techstark/opencv-js', version: '4.12.0-release.1', artifact: 'dist/opencv.js', source: 'https://github.com/TechStark/opencv-js', license: 'Apache-2.0' },
};

function replaceOnce(source, match, replacement) {
  const hits = [...source.matchAll(match)];
  if (hits.length !== 1) throw Error('Unexpected pinned asset structure');
  return { source: source.replace(match, () => replacement(hits[0])), match: hits[0] };
}
await mkdir(output, { recursive: true });
const manifest = { schema: 1, transform: 'csp-static-bindings-v1', transformSha256:transformHash, packages, files: {} };
async function emit(name, bytes) {
  const buffer = Buffer.from(bytes);
  manifest.files[name] = { sha256: sha256(buffer), bytes: buffer.length, gzipBytes: gzipSync(buffer).length, brotliBytes: brotliCompressSync(buffer).length };
  await writeFile(resolve(output, name), buffer);
}
for (const [kind, spec] of Object.entries(packages)) {
  const directory = resolve(root, 'node_modules', spec.package);
  const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  if (metadata.version !== spec.version) throw Error(`${kind} package version mismatch`);
  let source = patchBindings(kind, await readFile(resolve(directory, spec.artifact), 'utf8'));
  spec.sourceSha256 = sourceHashes[kind];
  if (kind === 'wechat') {
    const wasm = replaceOnce(source, /const \$C="([A-Za-z0-9+/=]+)"/g, () => 'const $C=new Uint8Array(await (async()=>{const response=await fetch(new URL("./wechat.wasm",import.meta.url));if(!response.ok)throw Error("WeChat WASM unavailable");return response.arrayBuffer()})())');
    await emit('wechat.wasm', Buffer.from(wasm.match[1], 'base64'));
    source = replaceOnce(wasm.source, /mC\(\$C\)/g, () => '$C').source;
    // Models remain in the pinned small JS entry; record each model separately
    // for provenance without evaluating the upstream module at build time.
    const models = [...source.matchAll(/([A-Za-z]+)=Uint8Array.from\(atob\("([A-Za-z0-9+/=]+)"\)/g)];
    if (models.length !== 4) throw Error('Unexpected embedded model count');
    spec.models = models.map(([_, symbol, base64]) => ({ symbol, sha256: sha256(Buffer.from(base64, 'base64')), bytes: Buffer.from(base64, 'base64').length }));
  } else {
    const wasm = replaceOnce(source, /var wasmBinaryFile="data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/g, () => 'var wasmBinaryFile=new URL("./opencv.wasm",import.meta.url).href');
    await emit('opencv.wasm', Buffer.from(wasm.match[1], 'base64'));
    source = wasm.source;
    // The upstream factory has its own hoisted Module. Supplying locateFile here
    // prevents it prefixing the worker URL to the already absolute asset URL.
    source = replaceOnce(source, /var Module = \{\};/g, () => 'var Module = {locateFile:function(path){return path},onAbort:function(){rejectOpenCv(Error("OpenCV initialization failed"))}};').source;
    source = 'const module={exports:{}};const exports=module.exports;let rejectOpenCv;const failure=new Promise((_,reject)=>{rejectOpenCv=reject});\n' + source + '\nexport const ready=Promise.race([new Promise(resolve=>module.exports.then(cv=>resolve({cv}))),failure]);\n';
  }
  await emit(`${kind}.mjs`, notice + source);
  const license = await readFile(resolve(directory, 'LICENSE'));
  await emit(`${kind}-LICENSE.txt`, license);
}
const modelLicense=await readFile(resolve(root,'scripts/qr/licenses/wechat-models-LICENSE.txt'));
if(sha256(modelLicense)!=='f8549a71cfb8bfa34e6b7d6491fbfac8034673294e2fd80493389e460a496cb5')throw Error('WeChat model license hash mismatch');
await emit('wechat-models-LICENSE.txt',modelLicense);
manifest.modelLicenseSource='https://github.com/opencv/opencv_contrib/blob/4.5.5/modules/wechat_qrcode/LICENSE';
await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(resolve(root,'src/lib/qr/assets.json'),JSON.stringify({directory:`/qr-assets/${transformHash.slice(0,16)}`},null,2)+'\n');
// Only remove this generator's older output, within the verified asset root.
// Unrecognized files/directories are preserved rather than deleted recursively.
for(const entry of await readdir(assetRoot,{withFileTypes:true})){
  if(!entry.isDirectory()||!/^([a-f0-9]{16}|v1)$/.test(entry.name))continue;
  const target=resolve(assetRoot,entry.name);
  if(target===output||!target.startsWith(assetRoot+sep))continue;
  try{
    const previous=JSON.parse(await readFile(resolve(target,'manifest.json'),'utf8'));
    if(previous.transform==='csp-static-bindings-v1')await rm(target,{recursive:true});
  }catch(error){if(error.code!=='ENOENT')throw error;}
}
console.log(JSON.stringify({ directory:`/qr-assets/${transformHash.slice(0,16)}`, files: manifest.files }));
