// Synthetic provider for E2E only. Never imported by the real lab launcher.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLabServer } from '../../tools/voice-task-lab/server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'voice-lab-e2e-'));
const provider = {
  capabilities: async () => ({chatModels:['test/chat'],sttModels:['test/stt'],defaultChatModel:'test/chat',defaultSttModel:'test/stt',providerReady:true}),
  transcribe: async () => ({transcript:'Sửa vòi nước phòng 201 tòa 1392QT, giao Nam, ngày mai lúc 17 giờ.',elapsedMs:120,model:'test/stt'}),
  extract: async ({referenceTime}) => ({draft:{title:'Sửa vòi nước',description:'Sửa vòi nước phòng 201.',building:'1392QT',room:'201',jobType:'Sửa',assignee:'Nam',deadline:'2026-09-27T17:00:00+07:00',priority:'NORMAL'},warnings:[],elapsedMs:350,model:'test/chat',referenceTime}),
};
const server = await createLabServer({provider,accessCode:'test-voice-lab-code',publicOrigin:'http://127.0.0.1:4187',dataDir:directory,port:4187});
server.listen(4187,'127.0.0.1');
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => server.close(async()=>{await rm(directory,{recursive:true,force:true});process.exit(0);}));
