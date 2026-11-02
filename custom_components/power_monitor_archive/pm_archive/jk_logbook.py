"""Native JK A1/05 windows, persisted only by the existing HA writer.

Keep source windows verbatim: overlapping windows are not unique events, and
the JK clock is not UTC. No inference from telemetry, MOS bits or HA events.
"""
from contextlib import closing
import hashlib
import base64
import json
import re
import sqlite3
import struct
import time

from .store import ArchiveError

WINDOW_FIELDS = ('device', 'generation', 'slot', 'identity', 'digest', 'observed', 'reported_count', 'raw')


def ensure_windows_table(db):
    """Additive HDD schema; older PM/BMS readers keep their version-1 contract."""
    db.execute('''CREATE TABLE IF NOT EXISTS windows(device TEXT NOT NULL,generation TEXT NOT NULL,
        slot INTEGER NOT NULL,identity TEXT NOT NULL,digest TEXT NOT NULL,observed INTEGER NOT NULL,
        reported_count INTEGER NOT NULL,raw BLOB NOT NULL,
        PRIMARY KEY(device,generation,slot,identity,observed,digest))''')
    if tuple(row[1] for row in db.execute('PRAGMA table_info(windows)')) != WINDOW_FIELDS:
        raise ArchiveError('incompatible JK window table')
    db.execute('CREATE INDEX IF NOT EXISTS windows_time ON windows(device,generation,slot,observed)')


def wire_window(row):
    return [*row[:-1], base64.b64encode(row[-1]).decode('ascii')]


def window_anchor(row):
    return hashlib.sha256(json.dumps(row,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def checked_window(value):
    if (not isinstance(value,list) or len(value)!=9 or type(value[0]) is not int or not 0<value[0]<2**63
            or not isinstance(value[1],str) or not re.fullmatch('[0-9a-f]{12}',value[1])
            or not isinstance(value[2],str) or not re.fullmatch('[0-9a-f]{32}',value[2])
            or type(value[3]) is not int or value[3] not in (0,1)
            or not isinstance(value[4],str) or not re.fullmatch('[0-9a-f]{12}',value[4])
            or not isinstance(value[5],str) or not re.fullmatch('[0-9a-f]{64}',value[5])
            or type(value[6]) is not int or not 1700000000<=value[6]<=0xffffffff
            or type(value[7]) is not int or not 0<=value[7]<=0xffffffff
            or not isinstance(value[8],str) or len(value[8])>336):
        raise ArchiveError('invalid JK window identity')
    row=list(value);raw=base64.b64decode(row[8],validate=True)
    if (len(raw)!=min(value[7],50)*5 or
            hashlib.sha256(struct.pack('<I',value[7])+raw).hexdigest()!=value[5]):
        raise ArchiveError('JK window does not match its content')
    row[8]=raw
    return row


def read_window_delta(path,checkpoint,limit=32):
    if type(limit) is not int or not 1<=limit<=256:
        raise ArchiveError('invalid JK delta limit')
    cursor=checkpoint.get('rowid');anchor=checkpoint.get('anchor')
    if (type(cursor) is not int or not 0<=cursor<2**63 or (cursor==0)!=(anchor is None)
            or (cursor and (not isinstance(anchor,str) or not re.fullmatch('[0-9a-f]{64}',anchor)))):
        raise ArchiveError('invalid JK checkpoint')
    with closing(sqlite3.connect(path.absolute().as_uri()+'?mode=ro',uri=True,timeout=2)) as db:
        deadline=time.monotonic()+8
        db.set_progress_handler(lambda:time.monotonic()>deadline,10000)
        db.execute('PRAGMA query_only=ON');db.execute('PRAGMA cache_size=-256');db.execute('BEGIN')
        if db.execute('PRAGMA user_version').fetchone()[0]!=1:
            raise ArchiveError('unsupported JK logbook schema')
        if cursor:
            row=db.execute('SELECT rowid,* FROM windows WHERE rowid=?',(cursor,)).fetchone()
            if row is None or window_anchor(wire_window(row))!=anchor:
                raise ArchiveError('JK checkpoint no longer matches source')
        page=db.execute('SELECT rowid,* FROM windows WHERE rowid>? ORDER BY rowid LIMIT ?',
                        (cursor,limit+1)).fetchall()
        rows=[wire_window(row) for row in page[:limit]]
        for row in rows:checked_window(row)
        after={'rowid':rows[-1][0],'anchor':window_anchor(rows[-1])} if rows else dict(checkpoint)
        return {'rows':rows,'after':after,'more':len(page)>limit}


def insert_window_rows(db,rows):
    for value in rows:
        row=checked_window(value)
        old=db.execute('''SELECT * FROM windows WHERE device=? AND generation=? AND slot=?
            AND identity=? AND digest=? AND observed=?''',row[1:7]).fetchone()
        if old is not None and old!=tuple(row[1:]):
            raise ArchiveError('historical JK window changed')
        db.execute('INSERT OR IGNORE INTO windows VALUES(?,?,?,?,?,?,?,?)',row[1:])


def verify_window_rows(db,rows):
    for value in rows:
        row=checked_window(value)
        old=db.execute('''SELECT * FROM windows WHERE device=? AND generation=? AND slot=?
            AND identity=? AND digest=? AND observed=?''',row[1:7]).fetchone()
        if old!=tuple(row[1:]):
            raise ArchiveError('committed JK window readback mismatch')


class JkLogbookStore:
    def __init__(self, path):
        self.connection = sqlite3.connect(path, isolation_level=None, timeout=2)
        try:
            version = self.connection.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1):
                raise ArchiveError('unsupported JK logbook schema')
            if version == 0 and self.connection.execute("SELECT 1 FROM sqlite_master WHERE type='table'").fetchone():
                raise ArchiveError('unrelated JK logbook database')
            self.connection.execute('PRAGMA journal_mode=WAL')
            self.connection.execute('PRAGMA synchronous=FULL')
            self.connection.execute('PRAGMA cache_size=-256')
            self.connection.execute('PRAGMA wal_autocheckpoint=64')
            self.connection.execute('PRAGMA journal_size_limit=4194304')
            if version == 0:
                self.connection.executescript('''BEGIN IMMEDIATE;
                    CREATE TABLE windows(device TEXT NOT NULL,generation TEXT NOT NULL,
                        slot INTEGER NOT NULL,identity TEXT NOT NULL,digest TEXT NOT NULL,
                        observed INTEGER NOT NULL,reported_count INTEGER NOT NULL,
                        raw BLOB NOT NULL,
                        PRIMARY KEY(device,generation,slot,identity,observed,digest));
                    CREATE INDEX windows_time ON windows(device,generation,slot,observed);
                    PRAGMA user_version=1; COMMIT;''')
        except BaseException:
            self.connection.close()
            raise

    def close(self):
        self.connection.close()

    def observe(self, device, generation, slot, observed, snapshot):
        value = snapshot.get('logbook')
        if value is None:
            return {'state': 'firmware_required'}
        if not isinstance(value, dict) or value.get('schema') != 1 or value.get('source') != 'jk_a1_05':
            raise ArchiveError('unknown JK logbook format')
        if value.get('received') is not True:
            return {'state': 'waiting' if not value.get('requestedAt') else 'no_response'}
        identity = re.sub(':', '', snapshot.get('macAddress', '')).lower()
        if (not re.fullmatch('[0-9a-f]{12}', identity) or type(slot) is not int or slot not in (0, 1)
                or type(observed) is not int or not 1700000000 <= observed <= 0xffffffff
                or not re.fullmatch('[0-9a-f]{12}', device)
                or not re.fullmatch('[0-9a-f]{32}', generation)):
            raise ArchiveError('invalid JK logbook identity')
        count, reported = value.get('count'), value.get('reportedCount')
        raw_hex, age = value.get('recordsHex'), value.get('ageMs')
        if (type(count) is not int or not 0 <= count <= 50 or type(reported) is not int
                or not 0 <= reported <= 0xffffffff or count != min(50, reported)
                or not isinstance(raw_hex, str) or len(raw_hex) != count * 10
                or not re.fullmatch('[0-9a-f]*', raw_hex)
                or type(age) is not int or not 0 <= age <= 0xffffffff):
            raise ArchiveError('invalid JK logbook window')
        if snapshot.get('connected') is not True or snapshot.get('available') is not True or age > 600000:
            return {'state': 'stale'}
        raw = bytes.fromhex(raw_hex)
        digest = hashlib.sha256(struct.pack('<I', reported) + raw).hexdigest()
        previous = self.connection.execute('''SELECT digest FROM windows
            WHERE device=? AND generation=? AND slot=? AND identity=?
            ORDER BY observed DESC,rowid DESC LIMIT 1''', (device, generation, slot, identity)).fetchone()
        if previous != (digest,):
            self.connection.execute('INSERT OR IGNORE INTO windows VALUES(?,?,?,?,?,?,?,?)',
                (device, generation, slot, identity, digest, observed, reported, raw))
        return {'state': 'recording', 'observed': observed, 'identity': identity, 'count': count}


def latest_windows(path, device, generation):
    if not path.exists():
        return []
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('PRAGMA cache_size=-256')
        return latest_windows_connection(db,device,generation)


def latest_windows_connection(db,device,generation):
    result=[]
    for slot in (0,1):
        row=db.execute('''SELECT identity,observed,reported_count,raw FROM windows
            WHERE device=? AND generation=? AND slot=? ORDER BY observed DESC,rowid DESC LIMIT 1''',
            (device,generation,slot)).fetchone()
        if row:
            identity,observed,reported,raw=row
            result.append({'slot':slot,'identity':identity,'observed':observed,'reportedCount':reported,
                'entries':[{'deviceTimeSeconds':stamp,'code':code} for stamp,code in struct.iter_unpack('<IB',raw)]})
    return result
