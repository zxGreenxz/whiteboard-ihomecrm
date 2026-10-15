"""Supported Hermes platform plugin; no model/provider/CRM runtime wrapper."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from gateway.config import Platform
from gateway.delivery_ledger import FLOOD_MARKER, RECONNECTED_MARKER, RECOVERED_MARKER
from gateway.platforms._shared import get_scoped_secret
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent
from gateway.session import SessionSource
from hermes_constants import get_hermes_home, profile_name_for_home

log = logging.getLogger(__name__)
_ENV = ("HERMES_ZALO_BRIDGE_URL", "HERMES_ZALO_BRIDGE_TOKEN", "HERMES_ZALO_PROFILE",
        "HERMES_ZALO_PAIRED_UID", "HERMES_ZALO_GENERATION")
# The bridge answers /v1/receive immediately (no long-poll): a short idle sleep bounds inbound latency.
_IDLE_POLL_SECONDS = 0.25


def _settings():
    url, token, profile, paired_uid, generation = [str(get_scoped_secret(key, "")) for key in _ENV]
    parsed = urlsplit(url)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port
            or parsed.username or parsed.password or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment
            or not re.fullmatch(r"hzn_[a-f0-9]{64}", token)
            or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", profile)
            or not re.fullmatch(r"[1-9][0-9]{0,39}", paired_uid)
            or str(uuid.UUID(generation)) != generation):
        raise ValueError("invalid_native_zalo_configuration")
    return url.rstrip("/"), token, profile, paired_uid, generation


def check_requirements():
    try:
        _settings()
        return True
    except (ValueError, TypeError):
        return False


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("native_zalo_redirect_rejected")


class ZaloNativeAdapter(BasePlatformAdapter):
    def __init__(self, config):
        super().__init__(config=config, platform=Platform("zalo_personal"))
        self._url, self._token, self._profile, self._paired_uid, self._generation = _settings()
        if profile_name_for_home(get_hermes_home()) != self._profile:
            raise ValueError("native_zalo_wrong_profile_home")
        self._client = None
        self._poll_task = None
        self._channel = None

    async def _request(self, route, body):
        # Stdlib transport: no second provider SDK or optional messaging extra.
        # Explicitly disable proxies and redirects for this loopback capability.
        client = self._client
        def request():
            req = Request(self._url + route, data=json.dumps(body).encode(), method="POST", headers={
                "Authorization": "Bearer " + self._token, "Content-Type": "application/json"})
            with client.open(req, timeout=65) as response:
                if response.status != 200:
                    raise RuntimeError("native_zalo_transport_rejected")
                # Inbound text is bounded to 8 KiB before JSON escaping.
                payload = response.read(65537)
                if len(payload) > 65536:
                    raise RuntimeError("native_zalo_response_too_large")
                value = json.loads(payload)
                if not isinstance(value, dict):
                    raise RuntimeError("native_zalo_response_invalid")
                return value
        return await asyncio.to_thread(request)

    async def connect(self, *, is_reconnect=False):
        # Lock is a Hermes gateway consumer lock, not ownership of the Zalo login.
        if not self._acquire_platform_lock("zalo_personal", self._profile, "Zalo personal profile"):
            return False
        self._client = build_opener(ProxyHandler({}), _NoRedirect())
        try:
            channel = await self._request("/v1/channel", {})
            if (channel.get("profile") != self._profile or channel.get("pairedUid") != self._paired_uid
                    or channel.get("mainUid") != self._paired_uid or channel.get("generation") != self._generation):
                raise ValueError("native_zalo_identity_mismatch")
            self._channel = {key: channel[key] for key in
                             ("accountId", "ownUid", "pairedUid", "mainUid", "profile", "generation")}
            self._mark_connected()
            self._poll_task = asyncio.create_task(self._poll())
            return True
        except Exception:
            await self.disconnect()
            self._set_fatal_error("channel_unavailable", "Zalo worker channel unavailable", retryable=True)
            return False

    async def disconnect(self):
        self._mark_disconnected()
        if self._poll_task:
            self._poll_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._poll_task
            self._poll_task = None
        if self._client:
            self._client.close()
            self._client = None
        self._release_platform_lock()

    async def _poll(self):
        failed = False
        while self._running:
            delay = _IDLE_POLL_SECONDS
            try:
                envelope = await self._request("/v1/receive", {"generation": self._generation})
                if envelope.get("status") == "message":
                    await self._accept(envelope)
                    delay = 0  # Drain the queue without waiting.
                elif envelope.get("status") not in ("empty", "unavailable"):
                    raise ValueError("native_zalo_receive_invalid")
                failed = False
            except asyncio.CancelledError:
                raise
            except Exception:
                if not failed:
                    log.warning("Zalo personal transport unavailable; no message or provider call is replayed")
                failed = True
            await asyncio.sleep(5 if failed else delay)

    async def _accept(self, envelope):
        if any(envelope.get(key) != value for key, value in self._channel.items()):
            raise ValueError("native_zalo_envelope_scope_mismatch")
        raw = envelope["event"]
        if (raw.get("senderUid") != self._paired_uid
                or not re.fullmatch(r"[a-f0-9]{64}", raw.get("id", ""))
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", raw.get("messageId", ""))
                or not isinstance(raw.get("text"), str) or not 0 < len(raw["text"].encode()) <= 8192):
            raise ValueError("native_zalo_event_invalid")
        event = MessageEvent(
            text=raw["text"], user_id=self._paired_uid, message_id=raw["messageId"],
            timestamp=datetime.fromtimestamp(raw["sentAt"] / 1000, timezone.utc),
            source=SessionSource(platform=self.platform, chat_id=self._paired_uid, chat_type="dm",
                                 user_id=self._paired_uid, profile=self._profile,
                                 scope_id=self._channel["accountId"], message_id=raw["messageId"]),
            allow_gateway_control=raw["senderUid"] == self._channel["mainUid"], reply_expected=True)
        status = "dispatch_unknown"
        try:
            await self.handle_message(event)
            status = "accepted" if event._gateway_accepted else "rejected"
        finally:
            await self._request("/v1/ack", {"generation": self._generation, "eventId": raw["id"], "status": status})

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        if (chat_id != self._paired_uid or not self._client or not isinstance(content, str)
                or not content.strip() or "\0" in content or len(content.encode()) > 32768):
            return SendResult(success=False, error="Personal destination or text rejected", retryable=False)
        # Pinned upstream recovery prepends these reserved markers but drops both
        # reply_to and obligation_id. Its changed text cannot reuse the bridge's
        # original request ID. Quarantine instead of creating another delivery,
        # including crash-left replies adopted without the adapter ledger hooks.
        # Never-attempted pending rows have no marker and can still send once.
        if content.startswith((RECOVERED_MARKER, RECONNECTED_MARKER, FLOOD_MARKER)):
            error = "Zalo recovery quarantined: original delivery identity unavailable; reconcile before resend"
            log.warning(error)
            return SendResult(success=False, error=error, retryable=False)
        # Anchored retries share one durable provider obligation. Unanchored cron
        # sends get a new obligation, and are never automatically retried here.
        request_id = hashlib.sha256(json.dumps([self._generation, str(reply_to), content],
                                             ensure_ascii=False).encode()).hexdigest() if reply_to else uuid.uuid4().hex
        try:
            result = await self._request("/v1/send", {
                "generation": self._generation, "requestId": request_id, "text": content})
            if result.get("status") == "sent" and result.get("messageId"):
                return SendResult(success=True, message_id=result["messageId"])
            return SendResult(success=False, error="Zalo delivery " + str(result.get("status", "unknown")), retryable=False)
        except Exception:
            return SendResult(success=False, error="Zalo delivery outcome unknown; reconcile before resend", retryable=False)

    def _send_retry_is_final(self, result):
        # retryable=False alone still reaches upstream's plain-text fallback.
        # Native text has no markup repair path; a different payload/ID could
        # duplicate a delivery whose provider ACK was lost. Keep the failure.
        return not result.success

    async def get_chat_info(self, chat_id):
        if chat_id != self._paired_uid:
            raise ValueError("personal_destination_rejected")
        return {"name": "Zalo personal", "type": "dm"}


def reject_uncorrelated_send(args, chat_id, platform_name, config):
    # Supported whole-request hook, before upstream's generic adapter route.
    # Cron standalone fallback drops the live attempt's identity; even a bridge
    # SENT receipt cannot prove the caller saw its HTTP response. Do not mint a
    # second obligation here. Gateway replies and live cron use DeliveryRouter
    # / adapter.send directly and remain available.
    return {"error": "native_zalo_generic_send_unsupported: use gateway replies or live cron; "
                     "generic send_message and standalone delivery lack a stable original delivery identity"}


def register(ctx):
    ctx.register_platform(
        name="zalo_personal", label="Zalo personal", adapter_factory=ZaloNativeAdapter,
        check_fn=check_requirements, validate_config=lambda config: check_requirements(),
        is_connected=lambda config: check_requirements(), required_env=list(_ENV),
        env_enablement_fn=lambda: {} if check_requirements() else None,
        allowed_users_env="HERMES_ZALO_PAIRED_UID", max_message_length=4000,
        send_message_handler=reject_uncorrelated_send,
        platform_hint="This is a private Zalo DM with the paired user. Group actions use the CRM connector. "
                      "Zalo sends use gateway replies or live cron; generic send_message and standalone delivery are unsupported.")
