"""Accepts every TCP connection, logs what the peer sends, answers HTTP 404.

Answering (rather than holding the connection open) matters for WebSockets:
a browser keeps at most one connection per IP in the CONNECTING state, so an
unanswered one would block every later WebSocket to the same address.
"""

import asyncio
import sys

LOG = open(sys.argv[2], "ab", buffering=0)


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    peer = writer.get_extra_info("peername")
    LOG.write(f"\n=== connection from {peer}\n".encode())
    try:
        data = await asyncio.wait_for(reader.read(65536), timeout=5)
        LOG.write(data)
        writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        await writer.drain()
    except (asyncio.TimeoutError, ConnectionError):
        pass
    finally:
        writer.close()


async def main() -> None:
    server = await asyncio.start_server(handle, host=None, port=int(sys.argv[1]))
    async with server:
        await server.serve_forever()


asyncio.run(main())
