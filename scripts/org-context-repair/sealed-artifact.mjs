import { createCipheriv, createDecipheriv, createHash, createPublicKey, constants, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const validSha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
export function recipientKey(encoded){
  const key=createPublicKey(Buffer.from(encoded,'base64'));
  if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<3072)throw new Error('RSA recipient key of at least 3072 bits required');
  return key;
}
export function assertContext({sha,expectedSha,ref,repository,isPrivate}){
  if(!validSha(sha)||sha!==expectedSha||ref!=='refs/heads/main'||repository!=='zxGreenxz/whiteboard-ihomecrm'||isPrivate!=='true'){
    throw new Error('Maintenance requires the pinned main commit of the private project');
  }
}
export function sealFiles(files,publicKey,{sha,projectRef}){
  if(!validSha(sha)||projectRef!=='tryymsxyyckgbrmmvozx')throw new Error('Invalid snapshot identity');
  const key=randomBytes(32),iv=randomBytes(12);
  const aad=Buffer.from(JSON.stringify({format:'ihomecrm-sealed-backup-v1',sha,projectRef}));
  const names=new Set();
  const payload=files.map(file=>{
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file.name)||names.has(file.name))throw new Error('Invalid or duplicate artifact name');
    names.add(file.name);
    const bytes=Buffer.from(file.bytes);
    return {name:file.name,sha256:digest(bytes),data:bytes.toString('base64')};
  });
  const cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(aad);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
  const envelope={aad:aad.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),
    wrappedKey:publicEncrypt({key:publicKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},key).toString('base64'),ciphertextSha256:digest(ciphertext)};
  key.fill(0);
  return {ciphertext,envelope};
}
export function unsealFiles(ciphertext,envelope,privateKey,expectedSha){
  if(digest(ciphertext)!==envelope.ciphertextSha256)throw new Error('Encrypted backup digest mismatch');
  const aad=Buffer.from(envelope.aad,'base64');
  const identity=JSON.parse(aad.toString());
  if(identity.format!=='ihomecrm-sealed-backup-v1'||identity.sha!==expectedSha||!validSha(expectedSha)||identity.projectRef!=='tryymsxyyckgbrmmvozx')throw new Error('Snapshot identity mismatch');
  const key=privateDecrypt({key:privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(envelope.wrappedKey,'base64'));
  try{
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
    decipher.setAAD(aad);decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
    const payload=JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString());
    const names=new Set();
    return payload.map(file=>{
      if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file.name)||names.has(file.name))throw new Error('Invalid or duplicate artifact name');
      names.add(file.name);
      const bytes=Buffer.from(file.data,'base64');
      if(digest(bytes)!==file.sha256)throw new Error('Decrypted file digest mismatch');
      return {name:file.name,sha256:file.sha256,bytes};
    });
  }finally{key.fill(0);}
}
