"""Portable cold archive schema and bounded query protocol; no ESP I/O."""
from pathlib import Path
from contextlib import closing
import json,re,sqlite3
from .external_history import TABLES,KEYS,checked_row,overlay_connection
from .runtime import Application
from .storage import cold_storage, export_page
from .jk_logbook import ensure_windows_table

def open_writer(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, isolation_level=None, timeout=5)
    version = db.execute('PRAGMA user_version').fetchone()[0]
    if version == 0 and db.execute("SELECT 1 FROM sqlite_master WHERE type='table'").fetchone():
        db.close(); raise ValueError('unrelated history database')
    if version not in (0, 1):
        db.close(); raise ValueError('unsupported history database')
    if version == 0:
        db.executescript('''BEGIN IMMEDIATE;
            CREATE TABLE variants(device TEXT NOT NULL,generation TEXT NOT NULL,kind TEXT NOT NULL,
                record_id INTEGER NOT NULL,fingerprint TEXT NOT NULL,timestamp INTEGER NOT NULL,raw BLOB NOT NULL,
                provisional INTEGER NOT NULL,day_policy TEXT NOT NULL,
                PRIMARY KEY(device,generation,kind,record_id,fingerprint,provisional));
            CREATE INDEX variants_time ON variants(device,generation,kind,timestamp);
            CREATE TABLE battery(device TEXT NOT NULL,generation TEXT NOT NULL,slot INTEGER NOT NULL,
                identity TEXT NOT NULL,bucket INTEGER NOT NULL,observed INTEGER NOT NULL,data TEXT NOT NULL,
                PRIMARY KEY(device,generation,slot,identity,bucket));
            CREATE INDEX battery_time ON battery(device,generation,slot,observed);
            CREATE TABLE bridge_meta(name TEXT PRIMARY KEY,value TEXT NOT NULL);
            PRAGMA user_version=1; COMMIT;''')
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='bridge_meta'").fetchone():
        db.close(); raise ValueError('not an owned history materialization')
    try:
        ensure_windows_table(db)
    except BaseException:
        db.close();raise
    db.execute('PRAGMA journal_mode=WAL'); db.execute('PRAGMA synchronous=FULL')
    db.execute('PRAGMA cache_size=-2048'); db.execute('PRAGMA wal_autocheckpoint=128')
    return db

def meta(db, name, default=None):
    row = db.execute('SELECT value FROM bridge_meta WHERE name=?', (name,)).fetchone()
    return json.loads(row[0]) if row else default

def put_meta(db, name, value):
    db.execute('INSERT OR REPLACE INTO bridge_meta VALUES(?,?)', (name, json.dumps(value, separators=(',', ':'))))

def insert_rows(db, table, rows):
    fields = TABLES[table]
    for value in rows:
        row = checked_row(table, value)
        match = ' AND '.join(key + '=?' for key in KEYS[table])
        old = db.execute(f'SELECT {",".join(fields)} FROM {table} WHERE {match}',
                         [row[1 + fields.index(key)] for key in KEYS[table]]).fetchone()
        if old is not None and tuple(row[1:]) != old:
            raise ValueError('historical identity has different immutable content')
        db.execute(f'INSERT OR IGNORE INTO {table} VALUES({",".join("?" for _ in fields)})', row[1:])

def execute_query(path, config, value):
    required = {'schema', 'sourceId', 'action', 'device', 'generation', 'args', 'costSettings', 'tail'}
    if (not isinstance(value, dict) or set(value) != required or value['schema'] != 1 or
            value['sourceId'] != config['sourceId'] or
            not re.fullmatch('[0-9a-f]{12}', value.get('device', '')) or
            not re.fullmatch('[0-9a-f]{32}', value.get('generation', '')) or
            not isinstance(value['tail'], dict) or set(value['tail']) != set(TABLES)):
        raise ValueError('invalid historical query')
    counts = {'coverage': (0,), 'history': (3,), 'days': (3,), 'costs': (3,),
              'analytics': (3, 4), 'archived_device_request': (1,)}
    action, args = value['action'], value['args']
    if action in ('storage_info','storage_export'):
        if any(value['tail'].values()):
            raise ValueError('physical storage query cannot overlay a tail')
        if action=='storage_info' and args==[]:
            result=cold_storage(path,value['device'],value['generation'],config.get('querySeconds',8))
        elif action=='storage_export' and isinstance(args,list) and len(args) in (5,6) and args[0] in ('minute','daily','battery','jk_logbook'):
            result=export_page(path,value['device'],value['generation'],*args,seconds=config.get('querySeconds',8))
        else:
            raise ValueError('invalid storage query')
        return {'sourceId':config['sourceId'],'result':result}
    if action not in counts or not isinstance(args, list) or len(args) not in counts[action]:
        raise ValueError('unsupported historical query')
    if action != 'archived_device_request' and any(type(v) is not int for v in args):
        raise ValueError('invalid historical query arguments')
    if action == 'archived_device_request':
        if not isinstance(args[0], dict) or args[0].get('method') != 'GET':
            raise ValueError('historical device endpoint is read-only')
    for table, rows in value['tail'].items():
        if not isinstance(rows, list) or len(rows) > 512:
            raise ValueError('historical query tail exceeds bound')
        ids = [checked_row(table, row)[0] for row in rows]
        if ids != sorted(set(ids)):
            raise ValueError('historical query tail is not ordered')
    # The worker may have committed the supplied tail since /status. Omit
    # exact overlaps so ordinary indexed queries remain fast at year scale.
    tail = {}
    with closing(sqlite3.connect(path.absolute().as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
        for table, rows in value['tail'].items():
            fields = TABLES[table]
            where = ' AND '.join(key + '=?' for key in KEYS[table])
            tail[table] = []
            for value_row in rows:
                row = checked_row(table, value_row)
                actual = db.execute(f'SELECT {",".join(fields)} FROM {table} WHERE {where}',
                    [row[1 + fields.index(key)] for key in KEYS[table]]).fetchone()
                if actual is None: tail[table].append(value_row)
                elif actual != tuple(row[1:]): raise ValueError('historical overlap content mismatch')
    paired = {'deviceId': value['device'], 'generation': value['generation'],
              'address': '127.0.0.1', 'token': '0' * 64, 'costSettings': value['costSettings']}
    app = Application({'dataDirectory': str(path.parent), 'devices': [paired],
                       'externalHistory': False, 'createDataDirectory': False})
    app.database = app.analytics_database = path
    app._archive_connection = app._analytics_connection = lambda: overlay_connection(
        path, tail, config.get('querySeconds', 8))
    result = getattr(app, action)(value['device'], *args)
    if not isinstance(result, dict):
        raise ValueError('unsupported device history endpoint')
    return {'sourceId': config['sourceId'], 'result': result}
