"""ESP UI history contract backed by HA's archive, never by per-browser ESP reads."""
import math
import sqlite3
import struct
from urllib.parse import urlsplit, parse_qs
from .device import json_response
from .store import ArchiveError


def summary(raw):
    energies = struct.unpack_from('<6f', raw, 8)
    exact = math.isfinite(energies[5])
    result = dict(zip(('pvWh', 'gridWh', 'loadWh', 'batteryChargeWh', 'batteryDischargeWh'), energies[:5]))
    result.update(timestamp=struct.unpack_from('<I', raw, 4)[0],
        autonomousLoadWh=energies[5] if exact else min(energies[2], energies[0] + energies[4] * .85),
        autonomyExact=exact)
    result.update(zip(('peakPvPower', 'peakLoadPower', 'peakPvTimestamp', 'peakLoadTimestamp',
                       'batteryRuntimeMinutes', 'validMinutes'), struct.unpack_from('<HH4I', raw, 32)))
    return result


def serve(app, paired, request):
    path = request.get('path', '')
    url = urlsplit(path)
    if url.path not in ('/api/history', '/api/history/today', '/api/daily-archive', '/api/history/status'):
        return None
    if request.get('method') != 'GET' or request.get('body'):
        raise ArchiveError('read-only server history')
    headers = {k.lower(): v for k, v in request.get('headers', {}).items()}
    if any(k not in ('accept', 'x-history-page-before', 'x-history-epoch', 'x-history-after',
                      'x-history-delta-only', 'x-daily-page-before') for k in headers):
        raise ArchiveError('invalid history headers')
    epoch = paired['generation'][:16]
    device, generation = paired['deviceId'], paired['generation']
    db = sqlite3.connect(app.database.as_uri() + '?mode=ro', uri=True, timeout=2)
    try:
        db.execute('PRAGMA query_only=ON')
        if url.path == '/api/history':
            query = parse_qs(url.query, keep_blank_values=True)
            if any(k != 'limit' for k in query) or query.get('limit', ['1440'])[0] not in ('64', '1440', 'all'):
                raise ArchiveError('invalid history limit')
            # Full records are served from HA. Force a fresh bounded DB snapshot
            # instead of accepting ESP boot-epoch caches from another device.
            if 'x-history-after' in headers:
                return json_response({'error': 'history_cache_expired'}, 409)
            before = headers.get('x-history-page-before', 'latest')
            if before != 'latest' and (not before.isdecimal() or int(before) > 0xffffffff):
                raise ArchiveError('invalid history cursor')
            rows = db.execute('''SELECT raw FROM variants
                WHERE device=? AND generation=? AND kind='minute' AND record_id<?
                GROUP BY record_id HAVING COUNT(*)=1 ORDER BY record_id DESC LIMIT 65''',
                (device, generation, 0x100000000 if before == 'latest' else int(before))).fetchall()
            samples = []
            for raw, in reversed(rows[:64]):
                values = struct.unpack('<III8H4bBBHH', raw)
                item = dict(zip(('sequence', 'timestamp', 'uptimeSeconds', 'pvPower', 'gridPower', 'loadPower',
                    'batteryChargePower', 'batteryDischargePower', 'battMv', 'gridDv', 'outDv',
                    't1', 't2', 'tMos', 'tInv', 'soc'), values[:16]))
                item.update(battMv=values[8] | values[17] << 16, pvDv=values[18],
                            available=bool(values[16] & 1), batteryAvailable=bool(values[16] & 2))
                samples.append(item)
            return json_response({'samples': samples, 'historyPage': True, 'historyPageMore': len(rows) > 64,
                'historyPageEpoch': epoch, 'historyEpoch': epoch, 'truncated': len(rows) > 64,
                'persistent': True, 'retentionHours': 168, 'sampleIntervalSeconds': 60, 'source': 'home_assistant'})
        rows = db.execute('''WITH versions AS (
            SELECT record_id,SUM(CASE WHEN provisional=0 THEN 1 ELSE 0 END) AS finals,
            MAX(CASE WHEN provisional=0 THEN rowid END) AS final_row,
            MAX(CASE WHEN provisional=1 THEN rowid END) AS provisional_row FROM variants
            WHERE device=? AND generation=? AND kind='daily' GROUP BY record_id
          ) SELECT a.raw,a.provisional FROM variants a JOIN versions v ON a.rowid=
            CASE WHEN finals=1 THEN final_row WHEN finals=0 THEN provisional_row END
            ORDER BY a.timestamp DESC LIMIT 367''', (device, generation)).fetchall()
        today = next((summary(raw) for raw, provisional in rows if provisional), None)
        if today is None:
            # A final day must never be presented as today's live counters.
            today = {'timestamp': 0, **{k: 0 for k in ('pvWh', 'gridWh', 'loadWh', 'batteryChargeWh',
                'batteryDischargeWh', 'autonomousLoadWh', 'peakPvPower', 'peakLoadPower',
                'peakPvTimestamp', 'peakLoadTimestamp', 'batteryRuntimeMinutes', 'validMinutes')}, 'autonomyExact': False}
        if url.path == '/api/history/today':
            return json_response(today)
        if url.path == '/api/history/status':
            return json_response({'source': 'home_assistant', 'ready': True, 'generation': generation})
        before = headers.get('x-daily-page-before', 'latest')
        if before != 'latest' and (not before.isdecimal() or int(before) > 0xffffffff):
            raise ArchiveError('invalid daily cursor')
        days = [summary(raw) for raw, provisional in rows if not provisional and
                (before == 'latest' or struct.unpack_from('<I', raw, 4)[0] < int(before))]
        return json_response({'days': list(reversed(days[:3])), 'today': today, 'more': len(days) > 3,
                              'pageEpoch': epoch, 'retentionDays': 366, 'source': 'home_assistant'})
    finally:
        db.close()
