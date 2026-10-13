"""Use the pinned upstream Hermes MCP client on synthetic loopback fixtures.

This is transport compatibility only, with no AIAgent/model or OS isolation claim.
The launcher supplies a clean environment and a private HERMES_HOME.
"""
import json
import os
from pathlib import Path
import sys
import traceback

boot = json.loads(Path(sys.argv[1]).read_text())
url = sys.argv[2]
home = Path(os.environ['HERMES_HOME'])
home.mkdir(parents=True, exist_ok=True)
(home / 'config.yaml').write_text(json.dumps({'security': {'allow_lazy_installs': False}, 'mcp_servers': {}}))
from tools.mcp_tool_discovery import register_mcp_servers
from tools.mcp_tool_lifecycle import shutdown_mcp_servers
from tools.registry import registry

config = {'crm': {'url': url, 'headers': {'Authorization': 'Bearer ' + boot['token']},
    'strict_redirect_headers': True, 'connect_timeout': 10, 'tool_timeout': 10,
    'tools': {'include': ['crm_auth_context'], 'resources': False, 'prompts': False}}}
names = register_mcp_servers(config)
if names != ['mcp__crm__crm_auth_context']:
    raise RuntimeError('Hermes MCP registration failed or tool surface differs: ' + repr(names))
print('HERMES_RUNTIME_RESULT ' + json.dumps({'id': 0, 'ok': True, 'result': {'tools': names}}), flush=True)
try:
    for line in sys.stdin:
        try:
            command = json.loads(line)
            result = registry.dispatch(command.get('name', names[0]), command.get('arguments', {}))
            reply = {'id': command['id'], 'ok': True, 'result': result}
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            reply = {'id': command.get('id'), 'ok': False, 'error': str(error)}
        print('HERMES_RUNTIME_RESULT ' + json.dumps(reply), flush=True)
finally:
    shutdown_mcp_servers()
