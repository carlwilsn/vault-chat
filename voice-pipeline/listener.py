"""Exclusive loopback bind, reused from ports-on-reset-startup-1031; no model imports."""
import os
import socket


def bind_listener():
    port = int(os.environ["VC_VOICE_PORT"])
    http = int(os.environ["VC_VOICE_HTTP_PORT"])
    if not 1 <= http <= 65535 or not 1 <= port <= 65535 or port == http or port == 8848 or (port == 8857 and http != 8848):
        raise ValueError("invalid instance voice port")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    # Deliberately no SO_REUSEADDR / SO_REUSEPORT. Retain this exact socket into aiohttp.
    try:
        sock.bind(("127.0.0.1", port))
        sock.listen(128)
        sock.setblocking(False)
        return sock
    except BaseException:
        sock.close()
        raise
