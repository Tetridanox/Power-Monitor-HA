"""Bounded TCP recovery before HTTP starts; one owner, no write replay."""
from contextlib import contextmanager
import http.client


@contextmanager
def connected_http(address, logger, path):
    # ESP may retain a reused 4-tuple in TIME_WAIT. Only connect timeouts
    # are retryable: once request() starts, delivery can be ambiguous.
    for attempt in range(1, 4):
        connection = http.client.HTTPConnection(address, 80, timeout=2)
        try:
            connection.connect()
        except TimeoutError:
            connection.close()
            if attempt == 3:
                raise
            logger.warning('TCP connect timed out before HTTP; path=%s attempt=%d/3; opening a new connection',
                           path, attempt)
        except BaseException:
            connection.close()
            raise
        else:
            break
    try:
        connection.timeout = 8
        connection.sock.settimeout(8)
        connection.auto_open = 0  # request() must never reconnect implicitly.
        yield connection
    finally:
        connection.close()
