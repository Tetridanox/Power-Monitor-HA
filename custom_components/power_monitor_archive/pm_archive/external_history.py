"""Optional PC/HDD history reader. No device I/O or second archive writer.

The PC is reached only through an authenticated loopback SSH reverse forward.
Queries overlay a bounded unreplicated tail on a read-only PC database before
using the normal archive calculations. A failed reader leaves local HA usable.
"""
from functools import wraps
from pathlib import Path
import base64
import hashlib
import http.client
import inspect
import json
import re
import sqlite3
import threading
import time

from .store import ArchiveError, _record, resolve_minute_extensions

TABLES = {
    'variants': ('device', 'generation', 'kind', 'record_id', 'fingerprint',
                 'timestamp', 'raw', 'provisional', 'day_policy'),
    'battery': ('device', 'generation', 'slot', 'identity', 'bucket', 'observed', 'data'),
}
KEYS = {'variants': TABLES['variants'][:5] + ('provisional',),
        'battery': TABLES['battery'][:5]}
MAX_BODY = 2 * 1024 * 1024


def wire_row(table, row):
    value = list(row)
    if table == 'variants':
        value[7] = base64.b64encode(value[7]).decode('ascii')
    return value


def row_digest(row):
    return hashlib.sha256(json.dumps(row, ensure_ascii=True, separators=(',', ':'),
                                     allow_nan=False).encode()).hexdigest()


def checked_row(table, value):
    if (not isinstance(value, list) or len(value) != len(TABLES[table]) + 1 or
            type(value[0]) is not int or not 0 < value[0] < 2**63 or
            not isinstance(value[1], str) or not re.fullmatch('[0-9a-f]{12}', value[1]) or
            not isinstance(value[2], str) or not re.fullmatch('[0-9a-f]{32}', value[2])):
        raise ArchiveError('invalid historical row identity')
    row = list(value)
    if table == 'variants':
        raw = base64.b64decode(row[7], validate=True)
        identity, timestamp, fingerprint = _record(row[3], raw)
        if ((row[4], row[5], row[6]) != (identity, fingerprint, timestamp) or
                type(row[8]) is not int or row[8] not in (0, 1) or
                not isinstance(row[9], str) or len(row[9]) > 128):
            raise ArchiveError('historical record does not match its content')
        row[7] = raw
    else:
        if (type(row[3]) is not int or row[3] not in (0, 1) or
                not isinstance(row[4], str) or not re.fullmatch('[0-9a-f]{12}', row[4]) or
                type(row[5]) is not int or type(row[6]) is not int or
                row[5] != row[6] // 300 or not 1700000000 <= row[6] <= 0xffffffff or
                not isinstance(row[7], str) or len(row[7]) > 8192 or
                not isinstance(json.loads(row[7]), dict)):
            raise ArchiveError('invalid historical battery observation')
    return row


def read_delta(paths, checkpoints, limit=512):
    """Consistent append-only pages with an anchor to detect DB replacement.

    Each database has its own transaction; no cross-database atomicity claimed.
    Exporting never changes the archive writer's cursors or opens the ESP.
    """
    if type(limit) is not int or not 1 <= limit <= 2048:
        raise ArchiveError('invalid history export limit')
    result = {}
    for table, path in paths.items():
        if table not in TABLES:
            raise ArchiveError('invalid history table')
        before = checkpoints.get(table, {'rowid': 0, 'anchor': None})
        cursor, anchor = before.get('rowid'), before.get('anchor')
        if type(cursor) is not int or not 0 <= cursor < 2**63 or (cursor == 0) != (anchor is None):
            raise ArchiveError('invalid history checkpoint')
        if cursor and (not isinstance(anchor, str) or not re.fullmatch('[0-9a-f]{64}', anchor)):
            raise ArchiveError('invalid history anchor')
        db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
        try:
            db.execute('PRAGMA query_only=ON'); db.execute('PRAGMA cache_size=-512'); db.execute('BEGIN')
            if db.execute('PRAGMA user_version').fetchone()[0] != 1:
                raise ArchiveError('unsupported historical database')
            if cursor:
                previous = db.execute(f'SELECT rowid,* FROM {table} WHERE rowid=?', (cursor,)).fetchone()
                if previous is None or row_digest(wire_row(table, previous)) != anchor:
                    raise ArchiveError('history database incarnation or checkpoint changed')
            page = db.execute(f'SELECT rowid,* FROM {table} WHERE rowid>? ORDER BY rowid LIMIT ?',
                              (cursor, limit + 1)).fetchall()
            rows = [wire_row(table, row) for row in page[:limit]]
            after = {'rowid': rows[-1][0], 'anchor': row_digest(rows[-1])} if rows else dict(before)
            result[table] = {'before': dict(before), 'after': after, 'rows': rows, 'more': len(page) > limit}
        finally:
            db.close()
    return result


def overlay_connection(path, tail, query_seconds=8):
    """Read-only PC snapshot + deduplicated ephemeral HA tail, never a write RPC."""
    db = sqlite3.connect(':memory:', uri=True, isolation_level=None, timeout=2)
    if type(query_seconds) is not int or not 1 <= query_seconds <= 45:
        raise ArchiveError('invalid historical query deadline')
    deadline = time.monotonic() + query_seconds
    db.set_progress_handler(lambda: time.monotonic() > deadline, 10000)
    try:
        db.execute('PRAGMA cache_size=-2048')
        # Preserve /proc/self/fd directory anchors: resolving the symlink would
        # allow an unplugged mount to fall back to an internal directory.
        db.execute('ATTACH DATABASE ? AS cold', (Path(path).absolute().as_uri() + '?mode=ro',))
        for table, fields in TABLES.items():
            values = tail.get(table, [])
            if len(values) > 512:
                raise ArchiveError('historical tail exceeds bound')
            schema = db.execute("SELECT sql FROM cold.sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
            if schema is None:
                raise ArchiveError('missing historical table')
            if not values:
                # Preserve SQLite's native indexes and predicate pushdown for
                # fully replicated tables. An empty UNION arm still forces
                # expensive materialization on year-sized histories.
                db.execute(f'CREATE TEMP VIEW {"archive_variants" if table == "variants" else table} AS SELECT rowid,* FROM cold.{table}')
                continue
            # Fixed schema and names; neither SQL nor a path is supplied by HTTP.
            if table == 'variants':
                declaration = 'device TEXT,generation TEXT,kind TEXT,record_id INTEGER,fingerprint TEXT,timestamp INTEGER,raw BLOB,provisional INTEGER,day_policy TEXT'
            else:
                declaration = 'device TEXT,generation TEXT,slot INTEGER,identity TEXT,bucket INTEGER,observed INTEGER,data TEXT'
            db.execute(f'CREATE TEMP TABLE recent_{table}({declaration})')
            for value in values:
                row = checked_row(table, value)
                db.execute(f'INSERT INTO recent_{table} VALUES({",".join("?" for _ in fields)})', row[1:])
            if table == 'variants':
                db.execute('CREATE INDEX recent_minute_identity ON recent_variants(device,generation,kind,record_id,provisional)')
            match = ' AND '.join(f'c.{key}=r.{key}' for key in KEYS[table])
            db.execute(f'''CREATE TEMP VIEW {"archive_variants" if table == "variants" else table} AS
                SELECT c.rowid AS rowid,c.* FROM cold.{table} c UNION ALL
                SELECT (SELECT COALESCE(MAX(rowid),0) FROM cold.{table})+r.rowid AS rowid,r.*
                FROM recent_{table} r WHERE NOT EXISTS(SELECT 1 FROM cold.{table} c WHERE {match})''')
        tables = ('cold.variants', 'recent_variants') if tail.get('variants') else ('cold.variants',)
        resolve_minute_extensions(db, 'archive_variants', tables)
        db.execute('PRAGMA query_only=ON'); db.execute('BEGIN')
        return db
    except BaseException:
        db.close(); raise


class ExternalHistory:
    def __init__(self, path):
        value = json.loads(Path(path).read_text(encoding='utf8'))
        if (set(value) - {'schema', 'port', 'token', 'sourceId', 'backend'} or
                not {'schema', 'port', 'token', 'sourceId'} <= set(value) or value['schema'] != 1 or
                value.get('backend', 'pc') not in ('pc', 'hdd') or
                type(value['port']) is not int or not 1024 <= value['port'] <= 65535 or
                not re.fullmatch('[0-9a-f]{64}', value.get('token', '')) or
                not re.fullmatch('[0-9a-f]{32}', value.get('sourceId', ''))):
            raise ArchiveError('invalid external history configuration')
        self.config = value
        self.backend = value.get('backend', 'pc')
        self.lock = threading.Lock()
        self.retry_at = 0
        self.state = {'configured': True, 'backend': self.backend, 'available': False, 'source': 'local', 'reason': 'starting'}

    def request(self, route, value=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.config['port'],
                                                timeout=55 if self.backend == 'hdd' else 10)
        try:
            body = None if value is None else json.dumps(value, separators=(',', ':'), allow_nan=False).encode()
            if body is not None and len(body) > MAX_BODY:
                raise ArchiveError('historical request exceeds bound')
            headers = {'Authorization': 'Bearer ' + self.config['token'], 'Connection': 'close'}
            if body is not None:
                headers['Content-Type'] = 'application/json'
            connection.request('GET' if value is None else 'POST', route, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read(MAX_BODY + 1)
            if (response.status != 200 or len(raw) > MAX_BODY or
                    response.getheader('Content-Length') != str(len(raw))):
                raise ArchiveError('historical response incomplete or unavailable')
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ArchiveError('invalid historical response')
            return result
        finally:
            connection.close()

    def storage_request(self, paired, action, args):
        # Physical accounting/export does not overlay the live tail or change
        # the graph reader's retry/fallback state. No fallback during export.
        if action not in ('storage_info','storage_export'):
            raise ArchiveError('unsupported storage action')
        if not self.lock.acquire(timeout=2):
            raise ArchiveError('external reader busy')
        try:
            state=self.request('/v1/status')
            if state.get('sourceId')!=self.config['sourceId'] or not state.get('ready'):
                raise ArchiveError('external archive unavailable')
            value={'schema':1,'sourceId':self.config['sourceId'],'action':action,
                   'device':paired['deviceId'],'generation':paired['generation'],'args':args,
                   'costSettings':None,'tail':{name:[] for name in TABLES}}
            response=self.request('/v1/query',value)
            if response.get('sourceId')!=self.config['sourceId'] or not isinstance(response.get('result'),dict):
                raise ArchiveError('external archive changed')
            return {**response['result'], 'archiveId': self.config['sourceId']}
        finally:
            self.lock.release()

    def query(self, app, action, paired, args):
        if time.monotonic() < self.retry_at:
            return None, dict(self.state)
        if not self.lock.acquire(timeout=2):
            return None, {'configured': True, 'backend': self.backend, 'available': False, 'source': 'local', 'reason': 'busy'}
        try:
            state = self.request('/v1/status')
            if state.get('sourceId') != self.config['sourceId'] or not state.get('ready'):
                raise ArchiveError('historical replica is not ready')
            delta = read_delta({'variants': app.database, 'battery': app.analytics_database}, state['checkpoints'])
            if any(page['more'] for page in delta.values()):
                self.state = {'configured': True, 'backend': self.backend, 'available': False, 'source': 'local', 'reason': 'syncing'}
                return None, dict(self.state)
            value = {'schema': 1, 'sourceId': self.config['sourceId'], 'action': action,
                     'device': paired['deviceId'], 'generation': paired['generation'],
                     'args': list(args), 'costSettings': paired.get('costSettings'),
                     'tail': {key: page['rows'] for key, page in delta.items()}}
            response = self.request('/v1/query', value)
            if response.get('sourceId') != self.config['sourceId'] or not isinstance(response.get('result'), dict):
                raise ArchiveError('historical source identity mismatch')
            self.state = {'configured': True, 'backend': self.backend, 'available': True, 'source': self.backend,
                          'archiveId': self.config['sourceId'],
                          'updatedUtc': state.get('updatedUtc'),
                          'tailRows': sum(len(page['rows']) for page in delta.values())}
            return response['result'], dict(self.state)
        except (OSError, http.client.HTTPException, ValueError, TypeError, KeyError, sqlite3.Error):
            self.state = {'configured': True, 'backend': self.backend, 'available': False, 'source': 'local', 'reason': 'unavailable'}
            self.retry_at = time.monotonic() + 10
            return None, dict(self.state)
        finally:
            self.lock.release()


def archive_query(function):
    """Keep the local validated result as fallback and guard late pairing results."""
    @wraps(function)
    def query(app, device, *args, **kwargs):
        with app.lock:
            paired = next((dict(d) for d in app.devices if d['deviceId'] == device), None)
        local = function(app, device, *args, **kwargs)
        if local is None:
            return None
        reader = getattr(app, 'external_history', None)
        if reader is None or paired is None:
            if getattr(app, 'external_history_error', None):
                return {**local, 'externalArchive': {'configured': True, 'available': False,
                        'source': 'local', 'reason': app.external_history_error}}
            return local
        bound = inspect.signature(function).bind(app, device, *args, **kwargs)
        bound.apply_defaults()
        remote_args = list(bound.arguments.values())[2:]
        remote, state = reader.query(app, function.__name__, paired, remote_args)
        if remote is not None and function.__name__ == 'analytics':
            remote['error'] = local.get('error')
        with app.lock:
            if app.stop.is_set() or not any(d['deviceId'] == device and
                    all(d.get(key) == paired.get(key) for key in ('generation', 'address', 'token'))
                    for d in app.devices):
                raise ArchiveError('pairing changed during historical read')
        return {**(local if remote is None else remote), 'externalArchive': state}
    return query
