// Disposable, nonrecursive synthetic TCP/DNS endpoints. No Internet forwarding.
import net from 'node:net';
import dgram from 'node:dgram';
import { writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANARY_REPLY = 'HERMES_EGRESS_CANARY';
export const DNS_V4 = '198.18.0.10';
export const DNS_V6 = '2001:db8::10';
const listen = (server, options) => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(options, () => { server.removeListener('error', reject); resolve(); });
});
const bind = (server, options) => new Promise((resolve, reject) => {
  server.once('error', reject); server.bind(options, () => { server.removeListener('error', reject); resolve(); });
});
const LOOPBACK = Object.freeze({ ipv4: '127.0.0.1', ipv6: '::1' });
function bindAddresses(value, allowWildcard = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['ipv4', 'ipv6'].includes(key)) ||
      net.isIP(value.ipv4) !== 4 || net.isIP(value.ipv6) !== 6 ||
      (!allowWildcard && (value.ipv4 === '0.0.0.0' || /^[0:]+$/.test(value.ipv6)))) {
    throw new Error('Invalid fixture bind addresses');
  }
  return { ipv4: value.ipv4, ipv6: value.ipv6 };
}

// Only ordinary uncompressed single-question A/AAAA packets from this fixture.
export function dnsReply(packet, name) {
  if (!Buffer.isBuffer(packet) || packet.length < 17 || packet.length > 512 || packet.readUInt16BE(4) !== 1 ||
      packet.readUInt16BE(2) & 0xf800) throw new Error('Invalid fixture DNS request');
  let cursor = 12; const labels = [];
  while (true) {
    if (cursor >= packet.length) throw new Error('Invalid fixture DNS request');
    const length = packet[cursor++];
    if (length === 0) break;
    if (length > 63 || cursor + length > packet.length) throw new Error('Invalid fixture DNS request');
    labels.push(packet.subarray(cursor, cursor + length).toString('ascii')); cursor += length;
  }
  if (cursor + 4 !== packet.length || packet.readUInt16BE(cursor + 2) !== 1) throw new Error('Invalid fixture DNS request');
  const type = packet.readUInt16BE(cursor), exists = labels.join('.').toLowerCase() === name && [1, 28].includes(type);
  const header = Buffer.alloc(12); packet.copy(header, 0, 0, 2);
  header.writeUInt16BE(exists ? 0x8180 : 0x8183, 2); header.writeUInt16BE(1, 4); header.writeUInt16BE(exists ? 1 : 0, 6);
  if (!exists) return Buffer.concat([header, packet.subarray(12)]);
  const data = type === 1 ? Buffer.from([198, 18, 0, 10]) : Buffer.from('20010db8000000000000000000000010', 'hex');
  const answer = Buffer.alloc(12); answer.writeUInt16BE(0xc00c, 0); answer.writeUInt16BE(type, 2);
  answer.writeUInt16BE(1, 4); answer.writeUInt32BE(0, 6); answer.writeUInt16BE(data.length, 10);
  return Buffer.concat([header, packet.subarray(12), answer, data]);
}

export async function startHostCanary(addresses = LOOPBACK) {
  const hosts = bindAddresses(addresses);
  const counts = { ipv4: 0, ipv6: 0 }, servers = [];
  try {
    for (const [family, host] of Object.entries(hosts)) {
      const server = net.createServer(socket => {
        socket.on('error', () => socket.destroy()); socket.setTimeout(2000, () => socket.destroy());
        counts[family]++; socket.end(CANARY_REPLY);
      }); servers.push(server);
      await listen(server, { host, port: 0, ipv6Only: family === 'ipv6' });
    }
    return { ports: { ipv4: servers[0].address().port, ipv6: servers[1].address().port },
      addresses: { ipv4: servers[0].address().address, ipv6: servers[1].address().address },
      counts: () => ({ ...counts }), close: async () => { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); } };
  } catch (error) { for (const server of servers) server.close(); throw error; }
}

export async function startEgressCanary({ name, output, tcpPort = 19090, dnsPort = 53, addresses = LOOPBACK }) {
  if (!/^canary\.hermes-p1-[a-z0-9-]{1,40}\.test$/.test(name) || !path.isAbsolute(output)) throw new Error('Invalid fixture canary config');
  // Wildcards are explicit only in the disposable container CLI below. Host
  // callers/tests default to loopback and may inject exact literal addresses.
  const hosts = bindAddresses(addresses, true);
  const counts = { tcp4: 0, tcp6: 0, udpDns4: 0, udpDns6: 0, tcpDns4: 0, tcpDns6: 0 }, servers = [], sockets = [], endpoints = {}, boundAddresses = {};
  const save = () => { const target = path.join(output, 'egress-counts.json');
    writeFileSync(`${target}.tmp`, JSON.stringify(counts)); renameSync(`${target}.tmp`, target); };
  const hit = key => { counts[key]++; save(); };
  try {
    for (const [suffix, host] of [['4', hosts.ipv4], ['6', hosts.ipv6]]) {
      const ipv6Only = suffix === '6';
      const tcp = net.createServer(socket => {
        socket.on('error', () => socket.destroy()); socket.setTimeout(2000, () => socket.destroy());
        hit(`tcp${suffix}`); socket.end(CANARY_REPLY);
      }); servers.push(tcp);
      await listen(tcp, { host, port: tcpPort, ipv6Only });
      endpoints[`tcp${suffix}`] = tcp.address().port;
      boundAddresses[`tcp${suffix}`] = tcp.address().address;
      const udp = dgram.createSocket({ type: `udp${suffix}`, ipv6Only }); sockets.push(udp);
      udp.on('message', (packet, remote) => { hit(`udpDns${suffix}`);
        try { udp.send(dnsReply(packet, name), remote.port, remote.address); } catch { /* no forwarding */ } });
      await bind(udp, { address: host, port: dnsPort });
      endpoints[`udpDns${suffix}`] = udp.address().port;
      boundAddresses[`udpDns${suffix}`] = udp.address().address;
      const dns = net.createServer(socket => {
        socket.on('error', () => socket.destroy());
        hit(`tcpDns${suffix}`); let data = Buffer.alloc(0); socket.setTimeout(2000, () => socket.destroy());
        socket.on('data', chunk => {
          data = Buffer.concat([data, chunk]); if (data.length > 514) { socket.destroy(); return; }
          if (data.length < 2 || data.length < data.readUInt16BE(0) + 2) return;
          try { const response = dnsReply(data.subarray(2), name), size = Buffer.alloc(2); size.writeUInt16BE(response.length);
            socket.end(Buffer.concat([size, response])); } catch { socket.destroy(); }
        });
      }); servers.push(dns); await listen(dns, { host, port: dnsPort, ipv6Only });
      endpoints[`tcpDns${suffix}`] = dns.address().port;
      boundAddresses[`tcpDns${suffix}`] = dns.address().address;
    }
    save(); return { counts, endpoints, addresses: boundAddresses, close: async () => {
      for (const socket of sockets) socket.close(); await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    } };
  } catch (error) {
    // A failed IPv6/port bind must not leave earlier IPv4 listeners alive.
    for (const socket of sockets) { try { socket.close(); } catch { /* bind never completed */ } }
    for (const server of servers) server.close();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Expected canary name and output directory');
  await startEgressCanary({ name: process.argv[2], output: process.argv[3], addresses: { ipv4: '0.0.0.0', ipv6: '::' } });
}
