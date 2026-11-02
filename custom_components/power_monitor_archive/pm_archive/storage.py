"""Read-only storage accounting and lossless, bounded archive export pages."""
import base64
from contextlib import contextmanager
import math
from pathlib import Path
import shutil
import sqlite3
import struct
import time

from .store import ArchiveError
from .jk_logbook import latest_windows_connection

DATASETS = ('minute', 'daily', 'battery', 'jk_logbook')


@contextmanager
def reader(path, seconds=8):
    # Do not resolve /proc/self/fd anchors used by the HDD service.
    db = sqlite3.connect(Path(path).absolute().as_uri() + '?mode=ro', uri=True, timeout=2)
    try:
        deadline = time.monotonic() + seconds
        db.set_progress_handler(lambda: time.monotonic() > deadline, 10000)
        db.execute('PRAGMA query_only=ON')
        db.execute('PRAGMA cache_size=-512')
        db.execute('BEGIN')
        yield db
    finally:
        db.close()


def file_bytes(path):
    try:
        if path.is_symlink():
            raise ArchiveError('storage file is a symlink')
        return path.stat().st_size
    except FileNotFoundError:
        return 0


def database_bytes(path):
    return sum(file_bytes(Path(str(path) + suffix)) for suffix in ('', '-wal', '-shm'))


def dataset_counts(db, device, generation):
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    result = {}
    if 'variants' in tables:
        for kind, count, size in db.execute('''SELECT kind,COUNT(*),COALESCE(SUM(length(raw)),0)
            FROM variants WHERE device=? AND generation=? GROUP BY kind''', (device, generation)):
            if kind in ('minute', 'daily'):
                result[kind] = {'rows': count, 'payloadBytes': size}
        for kind in ('minute', 'daily'):
            result.setdefault(kind, {'rows': 0, 'payloadBytes': 0})
    for table, dataset, column in (('battery', 'battery', 'data'), ('windows', 'jk_logbook', 'raw')):
        if table in tables:
            count, size = db.execute(f'''SELECT COUNT(*),COALESCE(SUM(length(CAST({column} AS BLOB))),0)
                FROM {table} WHERE device=? AND generation=?''', (device, generation)).fetchone()
            result[dataset] = {'rows': count, 'payloadBytes': size}
    return result


def filesystem(path):
    usage = shutil.disk_usage(path)
    return {'totalBytes': usage.total, 'freeBytes': usage.free, 'usedBytes': usage.used}


def local_storage(data, device, generation):
    categories, datasets = [], {}
    for filename, key in (('archive.sqlite', 'history'), ('analytics.sqlite', 'battery'),
                          ('jk-logbook.sqlite', 'jk_logbook')):
        path = data / filename
        categories.append({'key': key, 'bytes': database_bytes(path)})
        if path.exists():
            with reader(path) as db:
                datasets.update(dataset_counts(db, device, generation))
    # Count private metadata by size only. Never read or export credentials.
    metadata = sum(file_bytes(path) for path in data.iterdir()
                   if path.is_file() and path.suffix == '.json')
    categories.append({'key': 'metadata', 'bytes': metadata})
    return {'available': True, 'categories': categories, 'datasets': datasets,
            'totalBytes': sum(item['bytes'] for item in categories),
            'filesystem': filesystem(data), 'scope': 'integration_files_all_devices',
            'accounting': 'file_lengths_including_wal_shm'}


def cold_storage(path, device, generation, seconds=8):
    """Physical HDD file; category sizes are actual B-tree pages, not row estimates."""
    total = database_bytes(path)
    with reader(path, seconds) as db:
        datasets = dataset_counts(db, device, generation)
        windows=latest_windows_connection(db,device,generation) if 'jk_logbook' in datasets else []
        try:
            rows = db.execute('''SELECT m.tbl_name,SUM(s.pgsize) FROM dbstat s
                LEFT JOIN sqlite_master m ON m.name=s.name GROUP BY m.tbl_name''').fetchall()
            categories = []
            for table, size in rows:
                if table in ('variants', 'battery','windows'):
                    categories.append({'key': {'variants':'history','battery':'battery','windows':'jk_logbook'}[table], 'bytes': size})
            categories.append({'key': 'metadata', 'bytes': max(0, total - sum(c['bytes'] for c in categories))})
            order=('history','battery','jk_logbook','metadata')
            categories.sort(key=lambda c:order.index(c['key']))
            accounting = 'sqlite_pages_including_indexes_plus_wal_shm'
        except sqlite3.OperationalError:
            categories = [{'key': 'combined_archive', 'bytes': total}]
            accounting = 'file_lengths_including_wal_shm'
    return {'available': True, 'categories': categories, 'datasets': datasets,
            'totalBytes': sum(c['bytes'] for c in categories), 'filesystem': filesystem(path.parent),
            'scope': 'integration_files_all_devices', 'accounting': accounting,'logbookWindows':windows}


def export_page(path, device, generation, dataset, start, end, after=0, upper=0, total=0, seconds=8):
    if (dataset not in DATASETS or any(type(v) is not int for v in (start, end, after, upper, total))
            or not 0 <= start < end <= 0xffffffff or not 0 <= after <= upper < 2**53 or not 0 <= total < 2**53):
        raise ArchiveError('invalid storage export range')
    if dataset in ('minute', 'daily'):
        table, stamp, extra = 'variants', 'timestamp', ' AND kind=?'
        params = [device, generation, start, end, dataset]
        columns = ['sequence_or_day', 'timestamp_utc', 'fingerprint', 'provisional', 'raw_base64']
    elif dataset == 'battery':
        table, stamp, extra = 'battery', 'observed', ''
        params = [device, generation, start, end]
        columns = ['slot', 'bms_mac', 'observed_utc', 'measurements_json']
    else:
        table, stamp, extra = 'windows', 'observed', ''
        params = [device, generation, start, end]
        columns = ['slot', 'bms_mac', 'first_observed_utc', 'window_sha256', 'reported_count',
                   'entry_index', 'device_time_seconds', 'event_code', 'entry_raw_hex']
    if not path.exists():
        return {'columns': columns, 'rows': [], 'total': 0, 'upper': 0, 'after': 0, 'more': False}
    with reader(path, seconds) as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
            raise ArchiveError('dataset unavailable in this storage')
        if not upper:
            upper = db.execute(f'SELECT COALESCE(MAX(rowid),0) FROM {table}').fetchone()[0]
        where = f'device=? AND generation=? AND {stamp}>=? AND {stamp}<=?{extra} AND rowid<=?'
        # Keyset traversal avoids offsets and keeps memory bounded. Rowids are
        # append-only in the owned stores; freeze the upper bound on page one.
        limit = 64 if dataset == 'battery' else (32 if dataset == 'jk_logbook' else 256)
        selected = db.execute(f'''SELECT rowid,* FROM {table} NOT INDEXED
            WHERE {where} AND rowid>? ORDER BY rowid LIMIT ?''', (*params, upper, after, limit + 1)).fetchall()
        page, more = selected[:limit], len(selected) > limit
        if not after or not more or not total:
            aggregate = 'COALESCE(SUM(CASE WHEN length(raw)=0 THEN 1 ELSE length(raw)/5 END),0)' if dataset=='jk_logbook' else 'COUNT(*)'
            total = db.execute(f'SELECT {aggregate} FROM {table} WHERE {where}', (*params, upper)).fetchone()[0]
        rows = []
        for row in page:
            if dataset in ('minute', 'daily'):
                _, _, _, _, record_id, fingerprint, timestamp, raw, provisional, _ = row
                values = [record_id, timestamp, fingerprint, provisional, base64.b64encode(raw).decode('ascii')]
                if dataset == 'minute':
                    from .runtime import minute_measurements
                    from .store import unpack_minute
                    measured = minute_measurements(unpack_minute(raw))
                    if len(columns) == 5:
                        columns.extend(measured)
                    values.extend(measured.values())
                else:
                    names = ('pv_Wh', 'grid_Wh', 'load_Wh', 'battery_charge_Wh', 'battery_discharge_Wh', 'autonomous_Wh')
                    if len(columns) == 5:
                        columns.extend(names)
                    values.extend(v if math.isfinite(v) else None for v in struct.unpack_from('<6f', raw, 8))
            elif dataset == 'battery':
                _, _, _, slot, identity, _, observed, raw = row
                values = [slot, identity, observed, raw]
            else:
                _, _, _, slot, identity, digest, observed, reported, raw = row
                entries = list(struct.iter_unpack('<IB', raw))
                for index, (stamp, code) in enumerate(entries):
                    rows.append([slot, identity, observed, digest, reported, index, stamp, code,
                                 raw[index*5:index*5+5].hex()])
                if not entries:
                    rows.append([slot, identity, observed, digest, reported, None, None, None, ''])
                continue
            rows.append(values)
        return {'columns': columns, 'rows': rows, 'total': total, 'upper': upper,
                'after': page[-1][0] if page else after, 'more': more}
