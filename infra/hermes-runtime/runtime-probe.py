"""P1 synthetic probe in the pinned Hermes image; stdin is a trusted supervisor.

No CRM, real model, Zalo or host credential is used. The admission wrapper is
deliberately outside the agent: each turn checks the broker before using retained
context, and again before releasing the response. A revoked context is discarded.
This proves the wrapper's boundary; it is not a production session supervisor.
"""
import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import traceback
import urllib.error
import urllib.request

sys.path.insert(0, '/opt/hermes')
PREFIX = 'HERMES_RUNTIME_RESULT '
HOME = Path('/opt/data')
BOOT = json.loads(Path('/run/bootstrap.json').read_text())
ACTOR = os.environ['FIXTURE_ACTOR']
assert BOOT['actor'] == ACTOR
agent = None
history = None
generation = 1
admitted_identity = None


def rpc(method, params=None):
    payload = {'jsonrpc': '2.0', 'id': 99, 'method': method}
    if params is not None:
        payload['params'] = params
    request = urllib.request.Request('http://fixture:8080/mcp',
        data=json.dumps(payload).encode(), headers={
            'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
            'Authorization': 'Bearer ' + BOOT['token'], 'MCP-Protocol-Version': '2025-03-26'})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            body = json.load(error)
        except Exception:
            body = {'error': 'non-json response'}
        return error.code, body


def admission():
    status, response = rpc('tools/call', {'name': 'crm_auth_context', 'arguments': {}})
    result = response.get('result', {})
    if status != 200 or response.get('error') or result.get('isError'):
        return None
    texts = [c['text'] for c in result.get('content', []) if c.get('type') == 'text']
    identity = json.loads('\n'.join(texts))
    if identity.get('userId') != BOOT['userId'] or identity.get('organizationId') != BOOT['organizationId']:
        raise RuntimeError('Broker identity differs from trusted connection binding')
    return identity


def initialize(identity):
    global agent, history, admitted_identity
    config = {
        'model': {'default': 'fixture-model', 'provider': 'openai', 'base_url': 'http://fixture:8080/v1'},
        'security': {'allow_lazy_installs': False},
        'memory': {'memory_enabled': True, 'user_profile_enabled': False, 'nudge_interval': 0},
        'agent': {'max_turns': 4, 'disabled_toolsets': ['terminal', 'file', 'browser', 'web', 'cronjob', 'messaging', 'skills', 'delegation', 'session_search', 'catalog']},
        'mcp_servers': {'crm': {'url': 'http://fixture:8080/mcp',
            'headers': {'Authorization': 'Bearer ' + BOOT['token']},
            'strict_redirect_headers': True, 'connect_timeout': 10, 'tool_timeout': 10,
            'tools': {'include': ['crm_auth_context'], 'resources': False, 'prompts': False}}},
    }
    # JSON is valid YAML; no serializer dependency is needed for the fixture.
    (HOME / 'config.yaml').write_text(json.dumps(config))
    (HOME / 'memories').mkdir(exist_ok=True)
    memory_file = HOME / 'memories' / 'MEMORY.md'
    if not memory_file.exists():
        memory_file.write_text('Synthetic private note: ' + BOOT['sentinel'] + '\n')
    from run_agent import AIAgent
    from hermes_state import SessionDB
    from tools.mcp_tool_discovery import register_mcp_servers
    register_mcp_servers(config['mcp_servers'])
    db = SessionDB(HOME / 'state.db')
    sid = f'fixture-{ACTOR}-g{generation}'
    if not db.get_session(sid):
        db.create_session(sid, source='hermes-crm-fixture')
    agent = AIAgent(model='fixture-model', provider='openai', api_mode='chat_completions',
        base_url='http://fixture:8080/v1', api_key='fixture-model-' + ACTOR,
        enabled_toolsets=['mcp-crm'], disabled_toolsets=config['agent']['disabled_toolsets'],
        max_iterations=4, run_budget_seconds=45, max_tokens=512,
        session_id=sid, session_db=db, quiet_mode=True,
        skip_context_files=True, skip_background_review=True, skip_memory=False,
        user_id=BOOT['userId'], platform='api_server')
    names = sorted(agent.valid_tool_names)
    if names != ['mcp__crm__crm_auth_context']:
        raise RuntimeError('Unexpected agent tool surface: ' + repr(names))
    history = None
    admitted_identity = identity
    return names


def token_storage():
    from tools.mcp_oauth import HermesTokenStorage
    from mcp.shared.auth import OAuthToken
    store = HermesTokenStorage('fixture', hermes_home=HOME)
    asyncio.run(store.set_tokens(OAuthToken(access_token='synthetic-' + ACTOR, token_type='Bearer', expires_in=3600)))
    return str(store._tokens_path())


def snapshot():
    from hermes_state import SessionDB
    from tools.memory_tool import MemoryStore
    from tools.mcp_oauth import HermesTokenStorage
    store = MemoryStore()
    store.load_from_disk()
    db = SessionDB(HOME / 'state.db')
    other = 'b' if ACTOR == 'a' else 'a'
    token = asyncio.run(HermesTokenStorage('fixture', hermes_home=HOME).get_tokens())
    return {'memory': store.memory_entries, 'ownSession': bool(db.get_session(f'fixture-{ACTOR}-g1')),
        'otherSession': bool(db.get_session(f'fixture-{other}-g1')),
        'token': token.access_token if token else None,
        'forbiddenExecution': (HOME / 'forbidden-executed').exists(),
        'contextAlive': agent is not None, 'generation': generation}


def handle(command):
    global agent, history, generation, admitted_identity
    op = command['op']
    if op == 'turn':
        identity = admission()
        if identity is None:
            agent, history, admitted_identity = None, None, None
            generation += 1
            return {'denied': True, 'contextDiscarded': True, 'generation': generation}
        if admitted_identity is not None and identity != admitted_identity:
            agent, history = None, None
            generation += 1
        names = initialize(identity) if agent is None else sorted(agent.valid_tool_names)
        # Recheck after construction and before sending retained memory to the model.
        if admission() != identity:
            agent, history, admitted_identity = None, None, None
            generation += 1
            return {'denied': True, 'contextDiscarded': True, 'generation': generation}
        result = agent.run_conversation(command.get('text', 'FIXTURE_CONTEXT'), conversation_history=history)
        if admission() != identity:
            agent, history, admitted_identity = None, None, None
            generation += 1
            return {'denied': True, 'contextDiscarded': True, 'generation': generation}
        history = result.get('messages', [])
        if not result.get('completed', False):
            raise RuntimeError('Hermes turn incomplete: ' + str(result.get('error', result.get('final_response'))))
        return {'denied': False, 'toolNames': names, 'final': result['final_response'],
            'apiCalls': result.get('api_calls'), 'generation': generation}
    if op == 'seed_token':
        return {'path': token_storage()}
    if op == 'snapshot':
        return snapshot()
    if op == 'direct_rpc':
        status, body = rpc(command['method'], command.get('params'))
        return {'status': status, 'body': body}
    if op == 'egress':
        blocked = []
        for host, port in [('1.1.1.1', 443), ('fixture', 8081)]:
            try:
                with socket.create_connection((host, port), timeout=2):
                    blocked.append(False)
            except OSError:
                blocked.append(True)
        return {'externalIpBlocked': blocked[0], 'fixtureAdminBlocked': blocked[1],
            'dockerSocketAbsent': not Path('/var/run/docker.sock').exists(),
            'hostVaultAbsent': not Path('/host/CLAUDE.local.md').exists()}
    raise ValueError('Unknown supervisor command')


for line in sys.stdin:
    try:
        command = json.loads(line)
        result = {'id': command['id'], 'ok': True, 'result': handle(command)}
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        result = {'id': command.get('id'), 'ok': False, 'error': str(error)}
    print(PREFIX + json.dumps(result), flush=True)
