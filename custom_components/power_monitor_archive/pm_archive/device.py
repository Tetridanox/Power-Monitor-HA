"""Bounded device commands, executed by the existing source I/O owner."""
import base64
import http.client
import json
import logging
from urllib.parse import urlsplit, parse_qsl

from .store import ArchiveError
from .transport import connected_http

_LOGGER = logging.getLogger(__name__)

# No destination, arbitrary URL, cookies, credentials or redirects from JS.
ROUTES = frozenset((
    'archive bms bms/bank bms/bank/result bms/connect bms/connect/result '
    'bms/devices bms/disconnect bms/refresh-settings bms/scan bms/settings '
    'bms/settings/result bms/settings/unlock bms/stop-scan events events/clear '
    'inverter/ble-setup inverter/expert inverter/link inverter/settings '
    'inverter/settings/refresh inverter/stop-detection inverter/stop-wifi-scan '
    'home-assistant/retry home-assistant/settings forecast/config settings settings/full '
    'wifi/networks wifi/scan system system/summary system/crash-journal/clear system/restart '
    'relays relays/control relays/settings tariff tariff/mode tariff/settings '
    'telegram telegram/clear telegram/settings telegram/test telemetry '
    'update/session update/session/cancel update/session/data update/session/finish '
    'update/session/result update/session/status dbg/inv-sniff'
).split())
HEADERS = frozenset(('content-type', 'accept', 'x-bms-ticket', 'x-archive-command', 'x-inverter-token',
    'x-ota-ticket', 'x-ota-upload', 'x-ota-offset', 'x-ota-size', 'x-pm-ota'))


def validate_request(request):
    if not isinstance(request, dict) or request.get('method') not in ('GET', 'POST'):
        raise ArchiveError('invalid device method')
    path = request.get('path', '')
    if not isinstance(path, str) or len(path) > 256 or any(ord(c) < 32 or ord(c) > 126 for c in path):
        raise ArchiveError('invalid device path')
    url = urlsplit(path)
    if url.scheme or url.netloc or url.fragment or not url.path.startswith('/api/') or url.path[5:] not in ROUTES:
        raise ArchiveError('unsupported device path')
    if url.path == '/api/events' and url.query.startswith('_=') and url.query[2:].isdecimal():
        path = url.path
        url = urlsplit(path)
    if url.query and (url.path not in ('/api/bms', '/api/bms/settings', '/api/telemetry') or any(
            k not in ('slot', 'channel') or not v or len(v) > 16 or not v.replace('_', '').isalnum()
            for k, v in parse_qsl(url.query, keep_blank_values=True))):
        raise ArchiveError('invalid device query')
    headers = request.get('headers', {})
    if not isinstance(headers, dict) or len(headers) > 10:
        raise ArchiveError('invalid device headers')
    for key, value in headers.items():
        if not isinstance(key, str) or key.lower() not in HEADERS or not isinstance(value, str) or len(value) > 192 or any(ord(c) < 32 or ord(c) > 126 for c in value):
            raise ArchiveError('invalid device header')
    encoded = request.get('body', '')
    if not isinstance(encoded, str) or len(encoded) > 90000:
        raise ArchiveError('device body too large')
    try:
        body = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as error:
        raise ArchiveError('invalid device body') from error
    if len(body) > 65536 or request['method'] == 'GET' and body:
        raise ArchiveError('invalid device body size')
    return path, headers, body


def execute(source, request, *, guard=lambda: None):
    path, headers, body = validate_request(request)
    ota = path.startswith('/api/update/session')
    source.request_count += 1
    phase = 'connect'
    try:
        with connected_http(source.address, _LOGGER, path) as connection:
            guard()
            phase = 'send'
            connection.request(request['method'], path, body=body or None, headers={
                **headers, 'Authorization': 'Bearer ' + source._token, 'Connection': 'close'})
            phase = 'response'
            response = connection.getresponse()
            raw = response.read(65537)
            source.response_bytes += len(raw)
            if len(raw) > 65536:
                raise ArchiveError('device response too large')
            length = response.getheader('Content-Length')
            if length is not None and (not length.isdecimal() or int(length) != len(raw)):
                raise ArchiveError('incomplete device response')
            # HTTPConnection checks incomplete chunked bodies. Never follow Location.
            return {'status': response.status, 'body': base64.b64encode(raw).decode(),
                    'headers': {k: v for k, v in response.getheaders()
                                if k.lower() in ('content-type', 'retry-after')}}
    except (OSError, http.client.HTTPException, ArchiveError) as error:
        if ota:
            # Exception text, credentials, headers and image bytes stay private.
            _LOGGER.warning('OTA HTTP request failed; method=%s path=%s phase=%s error=%s',
                            request['method'], path, phase, type(error).__name__)
        raise


def json_response(value, status=200):
    return {'status': status, 'headers': {'Content-Type': 'application/json'},
            'body': base64.b64encode(json.dumps(value, separators=(',', ':'), allow_nan=False).encode()).decode()}
