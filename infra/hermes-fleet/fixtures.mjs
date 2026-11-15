// Dữ liệu GIẢ dùng chung cho test của infra/hermes-fleet. Mọi ID, UID, đường dẫn và mã ở đây là bịa; không lấy từ máy chủ thật.
import { readFileSync } from 'node:fs';
import { validateFleetConfig, sidecarView } from './fleet-plan.mjs';

export const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
export const WORKER_ID = 'a'.repeat(64), NEW_WORKER_ID = 'b'.repeat(64);
export const IMAGE = `sha256:${'c'.repeat(64)}`;
export const exampleConfig = () => JSON.parse(readFileSync(new URL('./fleet-config.example.json', import.meta.url), 'utf8'));
export const config = (change = {}) => validateFleetConfig({ ...exampleConfig(), image: IMAGE, ...change });
export const PERSON = Object.freeze({ assistantId: id('1'), userId: id('2'), organizationId: id('3') });
export const BINDING_ID = id('4'), CONNECTION_ID = id('5'), ACCOUNT_ID = id('6');
export const CREDENTIAL = `hc_${'S'.repeat(43)}`, CHANNEL_TOKEN = `hzn_${'e'.repeat(64)}`, PROVIDER_KEY = 'provider-key-SECRET-0001';

/** `docker inspect` của một sidecar đúng bộ cờ khoá (dạng của container dựng tay hiện có: volume /opt/data cũ, không nhãn fleet). */
export function sidecarInspect({ name = 'hermes-owner', profile = 'owner', home = '/var/lib/ihome-hermes-profiles/owner', uid = 10003,
  workerId = WORKER_ID, running = true, labels = {}, containerId = 'd'.repeat(64) } = {}) {
  return { Id: containerId, Name: `/${name}`, Image: IMAGE, RestartCount: 0,
    State: { Running: running, StartedAt: '2026-01-02T03:00:00.000Z' },
    Config: { User: `${uid}:${uid}`, Entrypoint: ['hermes'], Cmd: ['--profile', profile, 'gateway', 'run'], WorkingDir: '/opt/hermes',
      Env: ['HOME=/home/hermes', 'HERMES_HOME=/home/hermes/.hermes', 'HERMES_WRITE_SAFE_ROOT=/home/hermes/.hermes', 'PATH=/opt/hermes/bin:/usr/bin'],
      Labels: { 'com.ihomecrm.component': 'hermes-sidecar', ...labels } },
    Mounts: [{ Type: 'bind', Source: home, Destination: '/home/hermes', RW: true },
      { Type: 'volume', Name: 'f'.repeat(64), Source: '/var/lib/docker/volumes/x/_data', Destination: '/opt/data', RW: true }],
    HostConfig: { NetworkMode: `container:${workerId}`, Memory: 943718400, MemorySwap: 1887436800, NanoCpus: 1e9, PidsLimit: 256, ReadonlyRootfs: true,
      CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges:true'], Init: true, RestartPolicy: { Name: 'unless-stopped' },
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=64m,uid=10003,gid=10003,mode=0700' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      Binds: null, PortBindings: {}, Privileged: false, PidMode: '', IpcMode: 'private', Devices: [] } };
}
export const workerInspect = (workerId = WORKER_ID) => ({ Id: workerId, Name: '/ihome-zalo-worker', Image: `sha256:${'9'.repeat(64)}`,
  State: { Running: true, StartedAt: '2026-01-02T02:00:00.000Z', Pid: 4321 }, Config: { Env: ['HERMES_ZALO_NATIVE_CONFIG=/opt/ihome-zalo-worker/native-config/config.json'], Labels: {} },
  HostConfig: { NetworkMode: 'bridge' }, Mounts: [] });
export const IMAGE_CONFIG = Object.freeze({ Env: ['PATH=/opt/hermes/bin:/usr/bin'], Labels: {}, WorkingDir: '/opt/hermes' });

/** Facts của một máy chủ khoẻ: worker chạy, một sidecar dựng tay, một kênh `owner`, người mới có liên kết Zalo hoạt động. */
export function addFacts(change = {}) {
  return { memAvailableMb: 635, passwdUids: [0, 1000, 10004], homeUids: [10003], home: { exists: false }, imagePresent: true,
    containers: [sidecarView(sidecarInspect())], worker: { running: true, id: WORKER_ID, image: `sha256:${'9'.repeat(64)}`, startedAt: '2026-01-02T02:00:00.000Z', native: true },
    template: { soul: true, envKeys: ['NINEROUTER_API_KEY'] },
    native: { ok: true, listenPort: 8991, revision: 'r1', newerThanWorker: false,
      channels: [{ profile: 'owner', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '200', unissued: false }] },
    binding: { bindingId: BINDING_ID, bindingEpoch: 1, ...PERSON, accountId: ACCOUNT_ID, ownUid: '100', senderUid: '300', connectionId: CONNECTION_ID, status: 'active' },
    handoff: { ok: true, records: [{ connectionId: CONNECTION_ID, ...PERSON }] }, connectionAlive: true, audit: { registered: false },
    route: { reachable: true }, ...change };
}
export const realRequest = (change = {}) => ({ name: 'lan', connector: 'prod', ...PERSON, bindingId: BINDING_ID, ...change });
export const trialRequest = (change = {}) => ({ name: 'thu1', connector: 'test', ...PERSON, trial: true, connectionId: CONNECTION_ID, ...change });
