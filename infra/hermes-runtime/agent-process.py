"""Pinned Hermes process adapter, controlled by a trusted container driver.

Upstream: 818c13be1dc4fd28987e1e881a9408224afd4535 (v0.21.6).
No credential belongs in bootstrap, model prompts, protocol or this process.
The private gateway injects broker/provider authentication outside this process.
HERMES_HOME must be an isolated profile; /tmp must be private tmpfs. SessionDB
is ephemeral, persistent memory/context files are disabled, and only explicitly
retained history with an unchanged broker context fingerprint is reused.
Shutdown is cooperative: the driver MUST await actual process/container exit,
hard-kill when needed, and retain the profile lease until that is proven.
"""
import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import threading
import urllib.parse
import urllib.request
import uuid

UPSTREAM_COMMIT = '818c13be1dc4fd28987e1e881a9408224afd4535'
FRAME_BYTES = 65536
MAX_COMMANDS = 1024
MODEL_MESSAGE_LIMIT = 64
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
OWNER = ('assistantId', 'userId', 'organizationId')
BOOT_KEYS = (*OWNER, 'version', 'mcpUrl', 'modelBaseUrl', 'model', 'maxTokens', 'maxIterations')
TOOLS = ('crm_auth_context', 'crm_available_rooms')
DISABLED = ['terminal', 'file', 'browser', 'web', 'cronjob', 'messaging', 'skills', 'delegation', 'session_search', 'catalog', 'memory']
CODES = {'invalid_bootstrap', 'invalid_frame', 'invalid_command', 'duplicate_command', 'command_capacity', 'busy',
         'authority_denied', 'authority_changed', 'unexpected_tools', 'runtime_failed', 'invalid_result', 'shutdown_failed'}


class Denied(Exception):
    def __init__(self, code):
        self.code = code if code in CODES else 'runtime_failed'


def exact(value, keys, code='invalid_command'):
    if type(value) is not dict or set(value) != set(keys):
        raise Denied(code)
    return value


def pairs(values):
    result = {}
    for key, value in values:
        if key in result:
            raise Denied('invalid_frame')
        result[key] = value
    return result


def parse(raw):
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                          parse_constant=lambda _value: (_ for _ in ()).throw(Denied('invalid_frame')))
    except Exception:
        raise Denied('invalid_frame') from None


def valid_id(value):
    return type(value) is str and UUID.fullmatch(value) is not None


def valid_text(value, limit):
    try:
        return type(value) is str and bool(value.strip()) and '\0' not in value and len(value.encode('utf-8')) <= limit
    except UnicodeError:
        return False


def gateway_url(value, expected_path):
    if type(value) is not str or len(value) > 256 or any(c in value for c in ('%', '\\', '\r', '\n', '\t')):
        raise Denied('invalid_bootstrap')
    try:
        url = urllib.parse.urlsplit(value)
        if url.scheme != 'http' or url.username is not None or url.password is not None or url.query or url.fragment or url.path != expected_path:
            raise ValueError()
        if not url.hostname or (url.port is not None and not 1 <= url.port <= 65535):
            raise ValueError()
        if url.hostname != 'hermes-gateway':
            address = ipaddress.ip_address(url.hostname)
            networks = ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', 'fc00::/7', '::1/128')
            if not any(address in ipaddress.ip_network(network) for network in networks):
                raise ValueError()
    except Exception:
        raise Denied('invalid_bootstrap') from None
    return value


def load_bootstrap(file):
    try:
        with open(file, 'rb') as source:
            raw = source.read(8193)
        if len(raw) > 8192:
            raise ValueError()
        boot = exact(parse(raw), BOOT_KEYS, 'invalid_bootstrap')
        if type(boot['version']) is not int or boot['version'] != 1 or not all(valid_id(boot[key]) for key in OWNER):
            raise ValueError()
        if type(boot['model']) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}', boot['model']):
            raise ValueError()
        for key, cap in [('maxTokens', 4096), ('maxIterations', 16)]:
            if type(boot[key]) is not int or not 1 <= boot[key] <= cap:
                raise ValueError()
        gateway_url(boot['mcpUrl'], '/mcp')
        gateway_url(boot['modelBaseUrl'], '/v1')
        return boot
    except Exception:
        raise Denied('invalid_bootstrap') from None


def private_file(file, data, exclusive=False):
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC) | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(file, flags, 0o600)
    with os.fdopen(descriptor, 'wb') as target:
        target.write(data)


def prepare_home(boot):
    try:
        home = Path(os.environ['HERMES_HOME'])
        if not home.is_absolute() or home.is_symlink() or not home.is_dir():
            raise ValueError()
        expected = {key: boot[key] for key in OWNER}
        marker = home / '.ihome-owner.json'
        try:
            private_file(marker, json.dumps(expected).encode('utf-8'), exclusive=True)
        except FileExistsError:
            info = marker.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > 1024 or parse(marker.read_bytes()) != expected:
                raise ValueError()
        return home
    except Exception:
        raise Denied('invalid_bootstrap') from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Denied('authority_denied')


class AgentProcess:
    def __init__(self, boot, emit):
        self.boot, self.emit = boot, emit
        self.home = prepare_home(boot)
        self.agent, self.db, self.temporary, self.history, self.context = None, None, None, None, None
        self.worker = None
        self.lock = threading.RLock()
        self.stopping = threading.Event()
        self.seen = set()
        self.rpc_id = 0
        self.shutdown_mcp = None
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        # The driver sanitizes the complete environment. Never let ambient proxy
        # variables redirect these credential-free gateway requests.
        for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
            os.environ.pop(name, None)

    def admission(self):
        try:
            self.rpc_id += 1
            payload = {'jsonrpc': '2.0', 'id': self.rpc_id, 'method': 'tools/call', 'params': {'name': 'crm_auth_context', 'arguments': {}}}
            request = urllib.request.Request(self.boot['mcpUrl'], data=json.dumps(payload).encode('utf-8'), method='POST',
                headers={'Content-Type': 'application/json', 'Accept': 'application/json', 'MCP-Protocol-Version': '2025-03-26'})
            with self.opener.open(request, timeout=10) as response:
                raw = response.read(FRAME_BYTES + 1)
                if response.status != 200 or len(raw) > FRAME_BYTES:
                    raise ValueError()
            rpc = exact(parse(raw), ('jsonrpc', 'id', 'result'), 'authority_denied')
            if rpc['jsonrpc'] != '2.0' or type(rpc['id']) is not int or rpc['id'] != self.rpc_id:
                raise ValueError()
            result = exact(rpc['result'], ('content', 'isError'), 'authority_denied')
            if result['isError'] is not False or type(result['content']) is not list or len(result['content']) != 1:
                raise ValueError()
            content = exact(result['content'][0], ('type', 'text'), 'authority_denied')
            if content['type'] != 'text' or not valid_text(content['text'], FRAME_BYTES):
                raise ValueError()
            identity = exact(parse(content['text'].encode('utf-8')), (*OWNER, 'permissions', 'contextVersion'), 'authority_denied')
            if any(identity[key] != self.boot[key] for key in OWNER):
                raise ValueError()
            grants = exact(identity['permissions'], ('read', 'action'), 'authority_denied')
            for kind in ('read', 'action'):
                values = grants[kind]
                if type(values) is not list or len(values) > 256 or any(type(key) is not str or not re.fullmatch(r'[a-z][a-z0-9_.:-]{0,127}', key) for key in values) or len(set(values)) != len(values):
                    raise ValueError()
                grants[kind] = sorted(values)
            if 'assistant.context.read' not in grants['read'] or type(identity['contextVersion']) is not str or not re.fullmatch(r'[a-f0-9]{64}', identity['contextVersion']):
                raise ValueError()
            # Broker contextVersion fingerprints live scopes as well as grants.
            return identity
        except Exception:
            raise Denied('authority_denied') from None

    def discard(self):
        self.history, self.context = None, None
        agent, db, temporary = self.agent, self.db, self.temporary
        self.agent, self.db, self.temporary = None, None, None
        failed = False
        for operation in (agent.close if agent else None, self.shutdown_mcp, db.close if db else None,
                          temporary.cleanup if temporary else None):
            if operation:
                try:
                    operation()
                except Exception:
                    failed = True
        if failed:
            raise Denied('shutdown_failed')

    def initialize(self, identity):
        self.discard()
        config = {'model': {'default': self.boot['model'], 'provider': 'openai', 'base_url': self.boot['modelBaseUrl'], 'streaming': False},
            'fallback_providers': [], 'fallback_model': [],
            'security': {'allow_lazy_installs': False}, 'tools': {'tool_search': {'enabled': 'off'}},
            'memory': {'memory_enabled': False, 'user_profile_enabled': False, 'nudge_interval': 0},
            'agent': {'disabled_toolsets': DISABLED, 'environment_probe': False, 'api_max_retries': 1, 'auto_recovery_cycles': 0},
            'mcp_servers': {'crm': {'url': self.boot['mcpUrl'], 'strict_redirect_headers': True, 'connect_timeout': 10, 'tool_timeout': 10,
                'tools': {'include': list(TOOLS), 'resources': False, 'prompts': False}}}}
        private_file(self.home / 'config.yaml', json.dumps(config).encode('utf-8'))
        # The container driver pins the image/source; never accept an import path
        # or arbitrary executable from a command or bootstrap field.
        if '/opt/hermes' not in sys.path:
            sys.path.insert(0, '/opt/hermes')
        from run_agent import AIAgent
        from hermes_state import SessionDB
        from tools.mcp_tool_discovery import register_mcp_servers
        from tools.mcp_tool_lifecycle import shutdown_mcp_servers
        self.shutdown_mcp = shutdown_mcp_servers
        names = register_mcp_servers(config['mcp_servers'])
        self.validate_tools(names)
        self.temporary = tempfile.TemporaryDirectory(prefix='hermes-crm-session-')
        self.db = SessionDB(Path(self.temporary.name) / 'state.db')
        session_id = f'crm-{uuid.uuid4()}'
        self.db.create_session(session_id, source='ihome-private-command')
        self.agent = AIAgent(model=self.boot['model'], provider='openai', api_mode='chat_completions',
            base_url=self.boot['modelBaseUrl'], api_key='gateway-no-credential',
            fallback_model=[],
            enabled_toolsets=['mcp-crm'], disabled_toolsets=DISABLED, max_iterations=self.boot['maxIterations'],
            run_budget_seconds=110, max_tokens=self.boot['maxTokens'], session_id=session_id, session_db=self.db,
            quiet_mode=True, save_trajectories=False, verbose_logging=False, skip_context_files=True,
            load_soul_identity=False, skip_background_review=True, skip_memory=True,
            user_id=self.boot['userId'], platform='api_server', checkpoints_enabled=False)
        self.validate_tools(sorted(self.agent.valid_tool_names))
        if set(names) != set(self.agent.valid_tool_names):
            raise Denied('unexpected_tools')
        if self.admission() != identity:
            raise Denied('authority_changed')
        self.context = identity

    @staticmethod
    def validate_tools(names):
        allowed = {'mcp__crm__' + name for name in TOOLS}
        if type(names) is not list or not all(type(name) is str for name in names) or len(names) != len(set(names)) or not set(names) <= allowed or 'mcp__crm__crm_auth_context' not in names:
            raise Denied('unexpected_tools')

    def turn(self, command):
        try:
            identity = self.admission()
            if self.context != identity or self.agent is None:
                self.initialize(identity)
            if self.stopping.is_set() or self.admission() != identity:
                raise Denied('authority_changed')
            result = self.agent.run_conversation(command['text'], conversation_history=self.history)
            if self.stopping.is_set() or self.admission() != identity:
                raise Denied('authority_changed')
            if type(result) is not dict or result.get('completed') is not True or not valid_text(result.get('final_response'), 32768):
                raise Denied('invalid_result')
            response = {'event': 'result', 'commandId': command['commandId'], 'text': result['final_response']}
            if len((json.dumps(response, ensure_ascii=False) + '\n').encode('utf-8')) > FRAME_BYTES:
                raise Denied('invalid_result')
            messages = result.get('messages')
            if type(messages) is not list or len(messages) > 256 or len(json.dumps(messages, allow_nan=False).encode('utf-8')) > 262144:
                raise Denied('invalid_result')
            # Reserve system + new user, then one assistant tool-call envelope
            # and one result for each of the two advertised tools per iteration.
            # Repeated calls to the same tool or extra upstream messages still
            # require the gateway's exact 64-message wire limit, not truncation.
            history_limit = MODEL_MESSAGE_LIMIT - 2 - self.boot['maxIterations'] * (1 + len(TOOLS))
            if len(messages) > history_limit:
                # None alone does not reset an upstream agent or SessionDB.
                # Clearing the context forces initialize() to close the old
                # agent and create a fresh ephemeral DB/session next turn.
                self.history, self.context = None, None
            else:
                self.history = json.loads(json.dumps(messages, allow_nan=False))
        except Exception as error:
            code = error.code if isinstance(error, Denied) else 'runtime_failed'
            try:
                self.discard()
            except Exception:
                self.stopping.set()
                code = 'shutdown_failed'
            response = {'event': 'error', 'commandId': command['commandId'], 'code': code}
        with self.lock:
            self.worker = None
            if not self.stopping.is_set() or response.get('code') == 'shutdown_failed':
                self.emit(response)

    def accept(self, command):
        exact(command, ('op', 'commandId', 'bindingId', 'bindingEpoch', 'text'))
        if command['op'] != 'turn' or not valid_id(command['commandId']) or not valid_id(command['bindingId']) or type(command['bindingEpoch']) is not int or command['bindingEpoch'] < 1 or command['bindingEpoch'] > 9007199254740991 or not valid_text(command['text'], 8192):
            raise Denied('invalid_command')
        with self.lock:
            if self.stopping.is_set():
                raise Denied('runtime_failed')
            if command['commandId'] in self.seen:
                raise Denied('duplicate_command')
            if self.worker is not None:
                raise Denied('busy')
            if len(self.seen) >= MAX_COMMANDS:
                raise Denied('command_capacity')
            self.seen.add(command['commandId'])
            self.worker = threading.Thread(target=self.turn, args=(command,), daemon=False)
            self.worker.start()

    def shutdown(self):
        self.stopping.set()
        with self.lock:
            worker, agent = self.worker, self.agent
        if worker and agent:
            try:
                agent.interrupt(hard_cancel=True, tool_reason='runtime_shutdown')
            except Exception:
                pass  # Driver must hard-kill if the process cannot exit.
        if worker:
            worker.join()
        self.discard()


def main():
    # Keep a private protocol FD, then suppress ALL incidental upstream output,
    # including direct os.write(), sys.__stdout__ and background-thread logging.
    protocol = os.dup(sys.stdout.fileno())
    with open(os.devnull, 'w') as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
    logging.disable(logging.CRITICAL)
    emit_lock = threading.Lock()
    def emit(value):
        encoded = (json.dumps(value, ensure_ascii=False, allow_nan=False) + '\n').encode('utf-8')
        with emit_lock:
            remaining = memoryview(encoded)
            while remaining:
                remaining = remaining[os.write(protocol, remaining):]
    process = None
    exit_code = 0
    try:
        if len(sys.argv) != 2:
            raise Denied('invalid_bootstrap')
        process = AgentProcess(load_bootstrap(sys.argv[1]), emit)
        process.initialize(process.admission())
        emit({'event': 'ready', 'version': 1})
        while not process.stopping.is_set():
            raw = sys.stdin.buffer.readline(FRAME_BYTES + 1)
            if not raw:
                break
            command_id = None
            try:
                if len(raw) > FRAME_BYTES or not raw.endswith(b'\n'):
                    raise Denied('invalid_frame')
                command = parse(raw)
                if type(command) is dict and valid_id(command.get('commandId')):
                    command_id = command['commandId']
                if type(command) is dict and command.get('op') == 'shutdown':
                    exact(command, ('op',))
                    break
                process.accept(command)
            except Exception as error:
                emit({'event': 'error', 'commandId': command_id, 'code': error.code if isinstance(error, Denied) else 'invalid_frame'})
                if len(raw) > FRAME_BYTES or not raw.endswith(b'\n'):
                    exit_code = 1
                    break
    except Exception as error:
        emit({'event': 'error', 'commandId': None, 'code': error.code if isinstance(error, Denied) else 'runtime_failed'})
        exit_code = 1
    finally:
        if process:
            try:
                process.shutdown()
            except Exception:
                emit({'event': 'error', 'commandId': None, 'code': 'shutdown_failed'})
                exit_code = 1
        os.close(protocol)
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
