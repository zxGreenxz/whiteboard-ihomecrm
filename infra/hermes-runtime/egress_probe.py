"""Trusted supervisor probe; never registered as a Hermes/model tool.

All destinations are disposable fixture addresses. No public DNS/Internet is used.
Reachability requires a verified sentinel/answer; negatives also require unchanged
server counters, and the harness repeats positive controls after the negatives.
"""
import ipaddress
import json
import socket
import struct
import sys

SENTINEL = b'HERMES_EGRESS_CANARY'


def checked_target(value, family):
    if not isinstance(value, dict) or set(value) != {'host', 'port'}:
        raise ValueError('Invalid fixture target')
    ip = ipaddress.ip_address(value['host'])
    if ip.version != family or not ip.is_private or not isinstance(value['port'], int) or not 1 <= value['port'] <= 65535:
        raise ValueError('Invalid fixture address')
    return value['host'], value['port']


def receive(client, length):
    data = b''
    while len(data) < length:
        chunk = client.recv(length - len(data))
        if not chunk:
            raise ValueError('Incomplete fixture response')
        data += chunk
    return data


def tcp(target):
    try:
        with socket.create_connection(target, timeout=0.8) as client:
            client.settimeout(0.8)
            return {'connected': True, 'verified': receive(client, len(SENTINEL)) == SENTINEL}
    except OSError:
        return {'connected': False, 'verified': False}


def dns(host, family, protocol, name):
    question = b''.join(bytes([len(label)]) + label.encode('ascii') for label in name.split('.')) + b'\x00'
    query_id = 0x6412
    packet = struct.pack('!6H', query_id, 0x0100, 1, 0, 0, 0) + question + struct.pack('!2H', 1 if family == 4 else 28, 1)
    expected = ipaddress.ip_address('198.18.0.10' if family == 4 else '2001:db8::10').packed
    try:
        with socket.socket(socket.AF_INET if family == 4 else socket.AF_INET6,
                           socket.SOCK_DGRAM if protocol == 'udp' else socket.SOCK_STREAM) as client:
            client.settimeout(0.8); client.connect((host, 53))
            if protocol == 'udp':
                client.send(packet); answer = client.recv(512)
            else:
                client.sendall(struct.pack('!H', len(packet)) + packet)
                answer = receive(client, struct.unpack('!H', receive(client, 2))[0])
        good = len(answer) >= 12 and struct.unpack('!H', answer[:2])[0] == query_id and answer[3] & 15 == 0
        return {'answered': True, 'verified': good and answer.endswith(expected)}
    except OSError:
        return {'answered': False, 'verified': False}


def probe(spec):
    if set(spec) != {'external4', 'external6', 'host4', 'host6', 'name'}:
        raise ValueError('Invalid egress probe')
    import re
    if not isinstance(spec['name'], str) or not re.fullmatch(r'canary\.hermes-p1-[a-z0-9-]{1,40}\.test', spec['name']):
        raise ValueError('Invalid fixture DNS name')
    targets = {key: checked_target(spec[key], 4 if key.endswith('4') else 6) for key in ['external4', 'external6', 'host4', 'host6']}
    result = {key: tcp(target) for key, target in targets.items()}
    for family in [4, 6]:
        for protocol in ['udp', 'tcp']:
            result[f'{protocol}Dns{family}'] = dns(targets[f'external{family}'][0], family, protocol, spec['name'])
    # Test Docker's configured resolver too, not only an explicitly addressed DNS server.
    try:
        addresses = sorted({row[4][0] for row in socket.getaddrinfo(spec['name'], 19090, type=socket.SOCK_STREAM)})
        result['systemDns'] = {'resolved': True, 'verified': addresses == ['198.18.0.10', '2001:db8::10']}
    except socket.gaierror:
        result['systemDns'] = {'resolved': False, 'verified': False}
    return result


if __name__ == '__main__':
    print(json.dumps(probe(json.loads(sys.argv[1]))))
