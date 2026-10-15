import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.environ['PROBE_UPSTREAM'])
from hermes_cli.plugins import PluginManager, PluginContext, PluginManifest
from gateway.platform_registry import platform_registry
from gateway.config import PlatformConfig
from gateway.platforms.base import BasePlatformAdapter
from gateway.platforms.event import MessageEvent
from gateway.session import SessionSource

plugin_path = Path(os.environ['PROBE_PLUGIN'])
spec = importlib.util.spec_from_file_location('ihome_native_probe', plugin_path / '__init__.py', submodule_search_locations=[str(plugin_path)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
manager = PluginManager()
manifest = PluginManifest(name='ihome-zalo-native', kind='platform', source='user', path=str(plugin_path))
module.register(PluginContext(manifest, manager))
entry = platform_registry.get('zalo_personal')
assert entry is not None and entry.check_fn()

async def composition_probe():
    adapter = entry.adapter_factory(PlatformConfig(enabled=True))
    assert isinstance(adapter, BasePlatformAdapter)
    received = asyncio.Event()
    async def handler(event):
        assert isinstance(event, MessageEvent)
        assert event.text == 'personal native fixture'
        assert event.source.profile == 'native-fixture'
        assert event.source.user_id == '200'
        assert event.allow_gateway_control is True
        received.set()
        return None  # No model is configured or called in this probe.
    adapter.set_message_handler(handler)
    assert await adapter.connect()
    try:
        await asyncio.wait_for(received.wait(), 10)
        result = await adapter.send('200', 'Phòng trống – native reply', reply_to='m1')
        assert result.success and result.message_id == '987654'
        duplicate = await adapter.send('200', 'Phòng trống – native reply', reply_to='m1')
        assert duplicate.success and duplicate.message_id == result.message_id
        denied = await adapter.send('300', 'wrong destination')
        assert not denied.success and not denied.retryable
        proactive = await adapter.send('200', 'Fresh proactive reply')
        assert proactive.success
    finally:
        await adapter.disconnect()
    print(json.dumps({'registration': True, 'upstreamBaseAdmission': True, 'receive': True, 'send': True, 'dedup': True, 'foreignDenied': True}))


async def delivery_probe(mode):
    from gateway import delivery_ledger as ledger
    from gateway.run_startup import GatewayStartupMixin

    adapter = entry.adapter_factory(PlatformConfig(enabled=True))
    adapter.set_owner_profile('native-fixture')
    assert await adapter.connect()
    requests = []
    request = adapter._request

    async def observed_request(route, body):
        if route == '/v1/send':
            requests.append(body)
        result = await request(route, body)
        if route == '/v1/send' and len(requests) == 1:
            if mode == 'cron-http-loss':
                assert result.get('status') == 'sent'
                raise TimeoutError('fixture HTTP response lost after bridge persisted SENT')
            if mode == 'cron-late-ack':
                assert result.get('status') == 'outcome_unknown'

                async def wait_for_late_receipt():
                    # Same-ID status reads have no provider effect. Return the
                    # original failure only once the late ACK has cleared the latch.
                    while (await request(route, body)).get('status') != 'sent':
                        await asyncio.sleep(0.01)

                await asyncio.wait_for(wait_for_late_receipt(), 5)
        return result

    adapter._request = observed_request

    class RecoveryHarness(GatewayStartupMixin):
        async def _obligation_adapter(self, row):
            assert row['platform'] == 'zalo_personal' and row['profile'] == 'native-fixture'
            return adapter

        async def _arm_flood_timers_for_waiting_rows(self):
            pass  # Drive the real ledger sweeps explicitly; no background gateway/model.

    def event(label):
        return MessageEvent(text='fixture input', user_id='200', message_id=label,
            timestamp=datetime.now(timezone.utc), source=SessionSource(
                platform=adapter.platform, chat_id='200', chat_type='dm', user_id='200',
                profile='native-fixture', message_id=label))

    async def owe(label, *, finalize):
        incoming = event(label)
        content = 'ambiguous ' + label
        oid = await adapter._record_delivery_obligation(incoming, label, content, adapter, False)
        assert oid, 'The real upstream ledger must remain enabled'
        result = await adapter.send('200', content, reply_to=label)
        assert not result.success and not result.retryable
        if finalize:
            await adapter._finalize_delivery_obligation(oid, result, incoming, adapter)
        return oid

    try:
        assert ledger.ledger_enabled()
        if mode == 'retry':
            for anchor in ('retry-anchor', None):
                before = len(requests)
                text = 'ambiguous retry ' + ('anchored ' if anchor else 'proactive ') + 'A' * 4001
                result = await adapter._send_with_retry('200', text,
                    reply_to=anchor)
                assert not result.success and not result.retryable, 'Ambiguous delivery must remain a failure'
                assert len(requests) == before + 1, 'Upstream retry/fallback minted another provider obligation'
            # HTTP response loss is also terminal even if the error classifier changes.
            lost_calls = []

            async def response_lost(route, body):
                lost_calls.append(body)
                raise TimeoutError('fixture response lost')

            adapter._request = response_lost
            result = await adapter._send_with_retry('200', 'ambiguous HTTP reply', reply_to='lost')
            assert not result.success and not result.retryable and len(lost_calls) == 1
            adapter._request = observed_request
            result = await adapter._send_with_retry('300', 'wrong destination')
            assert not result.success and len(requests) == 2
            print(json.dumps({'retryAndFallbackSuppressed': True, 'responseLossTerminal': True}))
        elif mode in ('cron', 'cron-long', 'cron-http-loss', 'cron-late-ack', 'cron-success', 'generic'):
            from types import SimpleNamespace
            from unittest.mock import patch
            from cron import scheduler_delivery
            from gateway.config import GatewayConfig
            from tools import send_message_tool

            loop = asyncio.get_running_loop()
            config = GatewayConfig(platforms={adapter.platform: PlatformConfig(enabled=True)})
            runner = SimpleNamespace(_gateway_loop=loop)
            job = {'id': 'native-cron-fixture', 'deliver': 'zalo_personal:200'}
            content = ('successful native cron result' if mode == 'cron-success' else 'ambiguous native cron result')
            content += ' ' + 'A' * 5000 if mode == 'cron-long' else ''
            # Replace only config/runtime lookup: target resolution, live lane,
            # false -> standalone fallback and the plugin handler are upstream code.
            with patch('gateway.config.load_gateway_config', return_value=config), \
                    patch.object(scheduler_delivery._sched, 'load_config', return_value={'cron': {'wrap_response': False}}), \
                    patch.object(send_message_tool, '_live_adapter', return_value=(runner, adapter)):
                if mode == 'generic':
                    result = await send_message_tool._send_to_platform(adapter.platform,
                        config.platforms[adapter.platform], '200', 'Fresh generic tool text',
                        args={'action': 'send', 'message': 'Fresh generic tool text'})
                    assert 'native_zalo_generic_send_unsupported' in result.get('error', '')
                    assert not requests, 'The generic hook must reject before any adapter send'
                    print(json.dumps({'genericRouteRejected': True, 'adapterNotCalled': True}))
                    return
                error = await asyncio.to_thread(scheduler_delivery._deliver_result, job,
                    content, {adapter.platform: adapter}, loop)
                if mode == 'cron-success':
                    assert error is None and len(requests) == 1
                    error = await asyncio.to_thread(scheduler_delivery._deliver_result, job,
                        content, {adapter.platform: adapter}, loop)
                    assert error is None and len(requests) == 2
                    assert requests[0]['requestId'] != requests[1]['requestId']
                    print(json.dumps({'liveCronDelivered': True, 'freshRepeatDelivered': True}))
                    return
            assert error and 'native_zalo_generic_send_unsupported' in error, 'Standalone must return an explicit route failure'
            assert len(requests) == 1, 'The standalone fallback must not call the adapter again'
            if mode == 'cron-long':
                assert 0 < len(requests[0]['text']) < len(content)
            print(json.dumps({'liveAttemptOnly': True, 'standaloneRejected': True, 'ambiguousFailure': True}))
        elif mode == 'runtime':
            # Supply only the OS process-start seam on platforms without the reader;
            # retain the actual SQLite ledger, ownership checks, sweep and replay code.
            if ledger._owner_stamp()[1] is None:
                ledger._owner_stamp = lambda: (os.getpid(), 123456)
            await owe('runtime', finalize=True)
            claimed = ledger.sweep_failed_for_runtime('zalo_personal', now=time.time() + 180,
                profile='native-fixture')
            assert len(claimed) == 1 and claimed[0]['marker'] == ledger.RECONNECTED_MARKER
            assert await RecoveryHarness()._redeliver_claimed_obligations(claimed) == 0
            assert len(requests) == 1, 'Runtime recovery resent an ambiguous delivery'
            print(json.dumps({'runtimeRecoveryQuarantined': True}))
        elif mode == 'seed-restart':
            await owe('failed', finalize=True)
            await owe('attempting', finalize=False)  # Process exits before its ACK reaches the ledger.
            flood_id = await owe('flood', finalize=False)
            ledger.mark_failed(flood_id, 'flood_control:1')
            # Crash-left transcript adoption bypasses adapter record/finalize hooks.
            result = await adapter.send('200', 'ambiguous crash-left', reply_to='crash-left')
            assert not result.success
            ledger.record_crash_left_reply(obligation_id='crash-left', session_key='crash-left',
                platform='zalo_personal', chat_id='200', thread_id=None, content='ambiguous crash-left',
                since=time.time() - 60, adapter_profile='native-fixture')
            ledger.record_obligation(obligation_id='pending', session_key='pending', platform='zalo_personal',
                chat_id='200', thread_id=None, content='never attempted pending reply', adapter_profile='native-fixture')
            assert len(requests) == 4
            print(json.dumps({'durableSeed': True, 'attempts': len(requests)}))
        elif mode == 'recover-restart':
            claimed = ledger.sweep_recoverable(now=time.time() + 180,
                deliverable_targets={('zalo_personal', 'native-fixture')})
            assert len(claimed) == 5, 'New Python process must adopt all exited-owner and crash-left rows'
            assert sum(bool(row['needs_marker']) for row in claimed) == 4
            assert await RecoveryHarness()._redeliver_claimed_obligations(claimed) == 0
            assert len(requests) == 1 and requests[0]['text'] == 'never attempted pending reply'
            with ledger._connect() as conn:
                states = conn.execute('SELECT session_key, state, last_error FROM delivery_obligations').fetchall()
            for key, state, error in states:
                if key == 'pending':
                    assert state == 'failed' and 'outcome_unknown' in error
                else:
                    assert state == 'failed' and 'quarantined' in error, 'Quarantine must not fake delivery'
            for text, anchor in (('fresh anchored reply', 'new-turn'), ('fresh proactive reply', None)):
                result = await adapter._send_with_retry('200', text, reply_to=anchor)
                assert not result.success and 'outcome_unknown' in result.error
            print(json.dumps({'restartRecoveryQuarantined': True, 'crashLeftQuarantined': True,
                'pendingHeldByChannelQuarantine': True, 'freshHeldByChannelQuarantine': True}))
        else:
            raise AssertionError('Unknown probe mode')
    finally:
        adapter._request = request
        await adapter.disconnect()


mode = os.environ.get('PROBE_MODE', 'composition')
asyncio.run(composition_probe() if mode == 'composition' else delivery_probe(mode))
