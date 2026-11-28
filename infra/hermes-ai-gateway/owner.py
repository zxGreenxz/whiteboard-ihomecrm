"""Serve only the installed Hermes Nous adapter on a Unix socket shared with the CRM gateway."""
import asyncio
import os
import signal
from pathlib import Path
from aiohttp import web
from hermes_cli.proxy.adapters import get_adapter
from hermes_cli.proxy.server import create_app

async def serve():
    socket = Path("/run/ihome-hermes-models/nous.sock")
    # A single named sidecar owns this directory and the socket across restarts.
    socket.unlink(missing_ok=True)
    os.umask(0o117)
    app = web.AppRunner(create_app(get_adapter("nous")), access_log=None)
    await app.setup()
    try:
        await web.UnixSite(app, str(socket)).start()
        stopped = asyncio.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            asyncio.get_running_loop().add_signal_handler(sig, stopped.set)
        await stopped.wait()
    finally:
        await app.cleanup()

if __name__ == "__main__":
    asyncio.run(serve())
