"""HA-owned folder archive. No host, mount, device or ESP-specific operations.

Only StorageWorker calls configure/step. Readers open bounded read-only
snapshots. Missing volumes never create a replacement database on the HA disk.
"""
from contextlib import contextmanager, closing
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import shutil
import sqlite3
import threading
import time
import uuid
from itertools import islice
import hashlib
import re

from .store import ArchiveError
from .external_history import TABLES, KEYS, read_delta, checked_row
from .jk_logbook import read_window_delta, insert_window_rows, verify_window_rows

GIB = 1024**3
LOCAL_RESERVE = 128 * 1024**2
DEFAULT_LIMIT = 10 * GIB
SETTINGS = 'storage-settings.json'
MARKER = '.power-monitor-volume.json'


def utc():
    return datetime.now(timezone.utc).isoformat()


def save_json(path, value):
    temporary = path.with_name(path.name + '.pmnew')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf8') as output:
            json.dump(value, output, separators=(',', ':'))
            output.flush(); os.fsync(output.fileno())
        os.replace(temporary, path)
        if os.name != 'nt':
            fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(fd)
            finally: os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)


def settings(value):
    if not isinstance(value, dict) or set(value) - {'mode', 'path', 'limitBytes', 'locationId'}:
        raise ArchiveError('invalid storage settings')
    mode = value.get('mode')
    limit = value.get('limitBytes', DEFAULT_LIMIT)
    path = value.get('path', '')
    location = value.get('locationId')
    if location is not None and (not isinstance(location, str) or not re.fullmatch('[0-9a-f]{32}', location)):
        raise ArchiveError('invalid storage location')
    if (mode not in ('local', 'folder', 'legacy') or type(limit) is not int or
            not 64 * 1024**2 <= limit <= 1024 * GIB or not isinstance(path, str) or len(path) > 512):
        raise ArchiveError('invalid storage limit or mode')
    if mode == 'folder' and not location and (not Path(path).is_absolute() or '..' in Path(path).parts or '\x00' in path):
        raise ArchiveError('absolute storage folder required')
    return {'mode': mode, 'path': path, 'limitBytes': limit, **({'locationId': location} if location else {})}


def _unescape_mount(value):
    return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), value)


def mount_records(text):
    """Kernel-visible mounts, including propagated mounts inside HA Container."""
    result = []
    for line in text.splitlines()[:2048]:
        before, separator, after = line.partition(' - ')
        left, right = before.split(), after.split()
        if separator and len(left) >= 6 and len(right) >= 2:
            result.append({'path': _unescape_mount(left[4]), 'filesystem': right[0],
                           'source': _unescape_mount(right[1]), 'writable': 'rw' in left[5].split(',')})
    return result


def archive_folder(root, current=''):
    if current:
        path = Path(current)
        if path == root or root in path.parents: return path
    for path in (root, root/'power-monitor', root/'history'):
        if (path/MARKER).is_file(): return path
    return root/'power-monitor'


def storage_locations(data, current='', mount_text=None):
    """Filesystem identity decides server/external; directory spelling does not."""
    server_device = Path(data).stat().st_dev
    usage = shutil.disk_usage(data)
    result = {'server': {'totalBytes': usage.total, 'freeBytes': usage.free}, 'locations': []}
    if mount_text is None:
        try: mount_text = Path('/proc/self/mountinfo').read_text(encoding='utf8')
        except OSError: mount_text = ''
    ignored = {'proc','sysfs','tmpfs','devtmpfs','devpts','cgroup','cgroup2','overlay','squashfs',
               'tracefs','debugfs','securityfs','pstore','mqueue','autofs','fusectl','configfs','hugetlbfs','nsfs','ramfs'}
    by_device = {}
    for record in mount_records(mount_text):
        root = Path(record['path'])
        if (record['filesystem'] in ignored or not record['writable'] or root == Path(root.anchor) or
                (os.name!='nt' and root.parts[1:2] in (('proc',),('sys',),('dev',),('etc',)))): continue
        try:
            if not root.is_dir() or root.is_symlink(): continue
            info = root.stat()
            if info.st_dev == server_device: continue
            # Prefer the mount containing the current archive. Otherwise expose
            # the shallowest visible path for each filesystem, not bind aliases.
            contains = bool(current and (Path(current) == root or root in Path(current).parents))
            rank = (not contains, len(root.parts), str(root))
            if info.st_dev in by_device and rank >= by_device[info.st_dev][0]: continue
            disk = shutil.disk_usage(root)
            if disk.total < 64*1024**2: continue
            identity = [str(root), info.st_dev, info.st_ino, record['source'], record['filesystem']]
            key = hashlib.sha256(json.dumps(identity, separators=(',', ':')).encode()).hexdigest()[:32]
            label = ''
            labels = Path('/dev/disk/by-label')
            if labels.is_dir():
                for candidate in islice(labels.iterdir(),64):
                    try:
                        if candidate.stat().st_rdev == info.st_dev: label = candidate.name; break
                    except OSError: continue
            item = {'id': key, 'path': str(root), 'archivePath': str(archive_folder(root,current)),
                    'label': label, 'kind': 'network' if record['filesystem'] in ('nfs','nfs4','cifs','smb3') or ':' in record['source'] or record['source'].startswith('//') else 'external',
                    'totalBytes': disk.total, 'freeBytes': disk.free, 'available': True}
            by_device[info.st_dev] = (rank, item)
            if len(by_device) >= 32: break
        except OSError:
            continue
    result['locations'] = sorted((item for _, item in by_device.values()), key=lambda item:item['path'])
    result['currentLocation'] = next((item['id'] for item in result['locations']
        if current and (Path(current) == Path(item['path']) or Path(item['path']) in Path(current).parents)), 'custom')
    if current:
        try: result['currentKind'] = 'server' if Path(current).stat().st_dev == server_device else 'external'
        except OSError: result['currentKind'] = 'unavailable'
    return result


def selected_folder(value, data, previous):
    """An explicit drive selection may create one dedicated archive directory."""
    selected = next((item for item in storage_locations(data, previous.config['path'] if isinstance(previous, ManagedHistory) else '')['locations']
                     if item['id'] == value['locationId']), None)
    if selected is None: raise ArchiveError('selected storage is no longer available')
    mount = Path(selected['path']);target = Path(selected['archivePath'])
    before = mount.stat();fd = None
    try:
        if os.name != 'nt':
            fd = os.open(mount, os.O_RDONLY|os.O_DIRECTORY)
            opened = os.fstat(fd)
            if (opened.st_dev,opened.st_ino)!=(before.st_dev,before.st_ino): raise ArchiveError('storage changed')
        if not target.exists():
            if target != mount/'power-monitor': raise ArchiveError('archive folder unavailable')
            if fd is not None: os.mkdir('power-monitor',0o700,dir_fd=fd)
            else: target.mkdir(mode=0o700)
        after = mount.stat()
        if (before.st_dev,before.st_ino)!=(after.st_dev,after.st_ino) or target.stat().st_dev!=before.st_dev:
            raise ArchiveError('storage changed during selection')
    finally:
        if fd is not None: os.close(fd)
    return {**{k:v for k,v in value.items() if k!='locationId'}, 'path': str(target)}


def load_settings(data):
    path = Path(data) / SETTINGS
    if not path.exists():
        return settings({'mode': 'legacy' if (Path(data) / 'external-history.json').exists() else 'local'})
    if path.stat().st_size > 4096:
        raise ArchiveError('invalid storage configuration')
    value = json.loads(path.read_text(encoding='utf8'))
    if value.get('schema') != 1:
        raise ArchiveError('unsupported storage configuration')
    return {**settings(value['settings']), **{k: value[k] for k in ('volumeId', 'sourceId') if k in value}}


def folder_choices():
    """Small directory inventory, not an arbitrary filesystem browser."""
    result = []
    for root in (Path('/media'), Path('/share')):
        if not root.is_dir(): continue
        result.append(str(root))
        try:
            for child in sorted(islice(root.iterdir(), 64)):
                if len(result) >= 32: return result
                if child.is_dir() and not child.is_symlink() and not child.name.startswith('.'):
                    result.append(str(child))
                    for nested in sorted(islice(child.iterdir(), 8)):
                        if len(result) >= 32: return result
                        if nested.is_dir() and not nested.is_symlink() and not nested.name.startswith('.'):
                            result.append(str(nested))
        except OSError:
            continue
    return result


def local_space(data):
    usage = shutil.disk_usage(data)
    reserve = min(LOCAL_RESERVE, max(16 * 1024**2, usage.total // 20))
    return {'recordingPaused': usage.free < reserve, 'reserveBytes': reserve}


def _lock_file(path):
    handle = path.open('a+b')
    try:
        if os.name == 'nt':
            import msvcrt
            if path.stat().st_size == 0: handle.write(b'0'); handle.flush()
            handle.seek(0); msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except BaseException:
        handle.close(); raise


def verify_rows(db, table, rows):
    fields = TABLES[table]
    where = ' AND '.join(key + '=?' for key in KEYS[table])
    for value in rows:
        row = checked_row(table, value)
        actual = db.execute(f'SELECT {",".join(fields)} FROM {table} WHERE {where}',
            [row[1 + fields.index(key)] for key in KEYS[table]]).fetchone()
        if actual != tuple(row[1:]):
            raise ArchiveError('committed archive content mismatch')


def replicate(db, config, paths, logbook_path, *, separate_filesystem=False):
    from .cold_storage import meta, put_meta, insert_rows
    previous = meta(db, 'replication', {'sourceId': config['sourceId'], 'checkpoints': {}})
    before_jk = meta(db, 'jk_replication', {'sourceId': config['sourceId'], 'checkpoint': {'rowid': 0, 'anchor': None}})
    if (not isinstance(previous, dict) or not isinstance(before_jk, dict) or
            previous.get('sourceId') != config['sourceId'] or before_jk.get('sourceId') != config['sourceId']):
        raise ArchiveError('archive belongs to a different HA source')
    pages = read_delta(paths, previous['checkpoints'], 512)
    page_jk = read_window_delta(logbook_path, before_jk['checkpoint']) if logbook_path.exists() else None
    state = {'schema': 1, 'sourceId': config['sourceId'], 'ready': not any(p['more'] for p in pages.values()),
             'checkpoints': {t: p['after'] for t, p in pages.items()}, 'updatedUtc': utc(), 'backend': 'folder',
             'separateFilesystem': separate_filesystem, 'localFloors': meta(db, 'local_clear_floors', {})}
    if page_jk:
        state['logbook'] = {'schema': 1, 'sourceId': config['sourceId'], 'ready': not page_jk['more'],
            'checkpoint': page_jk['after'], 'updatedUtc': state['updatedUtc']}
    # A manual clear also excludes the local backlog already present at that
    # moment. The local retention floor protects the rows we intentionally skip.
    floors = state['localFloors']
    batches = {table: [row for row in page['rows'] if row[0] > floors.get(table, 0)]
               for table, page in pages.items()}
    windows = [row for row in page_jk['rows'] if row[0] > floors.get('windows', 0)] if page_jk else []
    db.execute('BEGIN IMMEDIATE')
    try:
        for table, rows in batches.items(): insert_rows(db, table, rows)
        insert_window_rows(db, windows)
        db.execute('COMMIT')
    except BaseException:
        db.execute('ROLLBACK'); raise
    for table, rows in batches.items(): verify_rows(db, table, rows)
    verify_window_rows(db, windows)
    # Checkpoints follow committed byte readback, including after a crash/retry.
    db.execute('BEGIN IMMEDIATE')
    try:
        put_meta(db, 'replication', state)
        if page_jk: put_meta(db, 'jk_replication', state['logbook'])
        db.execute('COMMIT')
    except BaseException:
        db.execute('ROLLBACK'); raise
    if meta(db, 'replication') != state or (page_jk and meta(db, 'jk_replication') != state['logbook']):
        raise ArchiveError('archive checkpoint readback mismatch')
    return state


def evict_oldest(db, count=512):
    """Remove only owned archive rows, globally oldest first; preserve high rowids.

    Keeping each table's last row prevents reuse of export cursors. No local
    source, another application's file or HA Recorder can be touched here.
    """
    candidates = []
    for table, stamp in (('variants', 'timestamp'), ('battery', 'observed'), ('windows', 'observed')):
        last = db.execute(f'SELECT MAX(rowid) FROM {table}').fetchone()[0]
        candidates.extend((timestamp, table, rowid) for rowid, timestamp in db.execute(
            f'SELECT rowid,{stamp} FROM {table} WHERE rowid<? ORDER BY {stamp},rowid LIMIT ?', (last or 0, count)))
    selected = sorted(candidates)[:count]
    db.execute('BEGIN IMMEDIATE')
    try:
        for _, table, rowid in selected: db.execute(f'DELETE FROM {table} WHERE rowid=?', (rowid,))
        if selected:
            from .cold_storage import meta, put_meta
            revision = meta(db, 'retention_revision', 0)
            if type(revision) is not int or revision < 0: raise ArchiveError('invalid archive retention revision')
            put_meta(db, 'retention_revision', revision + 1)
        db.execute('COMMIT')
    except BaseException:
        db.execute('ROLLBACK'); raise
    # Incremental vacuum works without a second full-size database. Old adopted
    # archives remain valid and reuse free pages until explicitly migrated.
    reclaim_pages(db)
    return len(selected)


def reclaim_pages(db, count=64):
    if db.execute('PRAGMA freelist_count').fetchone()[0]:
        db.execute(f'PRAGMA incremental_vacuum({count})').fetchall()


class ManagedHistory:
    backend = 'folder'

    def __init__(self, config):
        self.config = dict(config)
        self.root = Path(config['path'])
        self.path = self.root / 'history.sqlite'
        self.lock = threading.Lock()
        self.owner_lock = None
        self.closed = False
        self.due = 0
        self.compacting = False
        self.ack = None
        self.state = {'configured': True, 'backend': self.backend, 'available': False, 'source': 'local', 'reason': 'starting'}

    def close(self):
        with self.lock:
            self.closed = True
            self.ack = None
            if self.owner_lock:
                self.owner_lock.close(); self.owner_lock = None

    def guard(self):
        if self.closed or not self.root.is_dir() or self.root.is_symlink():
            raise ArchiveError('archive folder unavailable')
        marker = self.root / MARKER
        if marker.is_symlink() or marker.stat().st_size > 4096:
            raise ArchiveError('archive identity unavailable')
        value = json.loads(marker.read_text(encoding='utf8'))
        if value != {'schema': 1, 'volumeId': self.config['volumeId']}:
            raise ArchiveError('archive volume changed')
        info = self.root.stat()
        if self.path.is_symlink() or not self.path.is_file():
            raise ArchiveError('archive database unavailable')
        return info.st_dev, info.st_ino, self.path.stat().st_ino

    @contextmanager
    def reading(self):
        if not self.lock.acquire(timeout=2): raise ArchiveError('archive busy')
        try:
            identity = self.guard()
            yield self.path
            if self.guard() != identity: raise ArchiveError('archive volume changed during read')
        finally: self.lock.release()

    def _open(self, seconds=2):
        # mode=rw is essential: loss of the mount never creates an empty DB.
        db = sqlite3.connect(self.path.absolute().as_uri() + '?mode=rw', uri=True, isolation_level=None, timeout=.5)
        db.execute('PRAGMA synchronous=FULL'); db.execute('PRAGMA cache_size=-2048')
        deadline = time.monotonic() + seconds
        db.set_progress_handler(lambda: time.monotonic() > deadline, 10000)
        return db

    def step(self, app):
        if self.closed or time.monotonic() < self.due or not self.lock.acquire(blocking=False): return None
        self.due = time.monotonic() + 30
        try:
            identity = self.guard()
            if self.owner_lock is None: self.owner_lock = _lock_file(self.root / '.power-monitor-writer.lock')
            with closing(self._open()) as db:
                usage = shutil.disk_usage(self.root)
                reserve = max(16 * 1024**2, min(GIB, usage.total // 100))
                separate = identity[0] != app.data.stat().st_dev
                if not separate:
                    reserve = max(reserve, local_space(app.data)['reserveBytes'])
                page_size = db.execute('PRAGMA page_size').fetchone()[0]
                allocated = db.execute('PRAGMA page_count').fetchone()[0] * page_size
                free_pages = db.execute('PRAGMA freelist_count').fetchone()[0] * page_size
                live = allocated - free_pages
                # A 5% headroom limits cleanup churn. Hard page bound applies
                # also to the transaction that imports the next source batch.
                pressure = live >= self.config['limitBytes'] * .95 or usage.free < reserve
                deleted = evict_oldest(db) if pressure else 0
                if not deleted and free_pages: reclaim_pages(db, 256 if self.compacting else 64)
                if self.compacting:
                    self.compacting = bool(db.execute('PRAGMA freelist_count').fetchone()[0])
                    if self.compacting: self.due = time.monotonic() + .2
                allocated = db.execute('PRAGMA page_count').fetchone()[0] * page_size
                live = allocated - db.execute('PRAGMA freelist_count').fetchone()[0] * page_size
                usage = shutil.disk_usage(self.root)
                if deleted or allocated >= self.config['limitBytes'] * .95: self.due = time.monotonic() + .2
                if usage.free < reserve or allocated >= self.config['limitBytes'] * .98:
                    self.ack = None
                    self.state = {**self.state, 'available': True, 'reason': 'reclaiming' if deleted else 'full',
                                  'deletedRows': self.state.get('deletedRows', 0) + deleted}
                    return None
                # Lowering a quota below an old file's allocation is handled
                # by incremental cleanup; max_page_count cannot shrink it.
                db.execute(f'PRAGMA max_page_count={max(allocated // page_size, self.config["limitBytes"] // page_size)}')
                state = replicate(db, self.config, {'variants': app.database, 'battery': app.analytics_database},
                                  app.logbook_database, separate_filesystem=separate)
            if self.guard() != identity: raise ArchiveError('archive changed before acknowledgement')
            self.ack = state
            self.state = {'configured': True, 'backend': self.backend, 'available': True, 'source': self.backend,
                'updatedUtc': state['updatedUtc'], 'reason': 'ready' if state['ready'] else 'syncing',
                'deletedRows': self.state.get('deletedRows', 0) + deleted, 'localDays': 0 if separate else 30}
            if not state['ready'] or (state.get('logbook') and not state['logbook']['ready']): self.due = time.monotonic() + .2
            return state
        except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
            self.ack = None
            if self.owner_lock:
                self.owner_lock.close(); self.owner_lock = None
            self.state = {'configured': True, 'backend': self.backend, 'available': False, 'source': 'local',
                          'reason': 'unavailable', 'errorType': type(error).__name__}
            return None
        finally:
            try:
                save_json(app.data / 'managed-storage-status.json', {'localDays': 30, **self.state, 'utc': utc(),
                    'limitBytes': self.config['limitBytes']})
            except OSError: pass
            self.lock.release()

    def clear(self, app, categories, expected_archive):
        from .cold_storage import meta, put_meta
        from .storage import CLEAR_TABLES, reader

        with self.reading():
            identity = self.guard()
            if self.owner_lock is None:
                self.owner_lock = _lock_file(self.root / '.power-monitor-writer.lock')
            paths = {'variants': app.database, 'battery': app.analytics_database, 'windows': app.logbook_database}
            with closing(self._open(15)) as db:
                revision = meta(db, 'retention_revision', 0)
                if expected_archive != f"{self.config['volumeId']}:{revision}":
                    raise ArchiveError('external archive changed; refresh before clearing')
                floors = meta(db, 'local_clear_floors', {})
                removed = {}
                for category in categories:
                    if category in CLEAR_TABLES:
                        table = CLEAR_TABLES[category]
                        if paths[table].exists():
                            with reader(paths[table]) as source:
                                last = source.execute(f'SELECT MAX(rowid) FROM {table}').fetchone()[0] or 0
                            floors[table] = max(last, floors.get(table, 0))
                db.execute('BEGIN IMMEDIATE')
                try:
                    for category in categories:
                        if category in CLEAR_TABLES:
                            removed[category] = db.execute(f'DELETE FROM {CLEAR_TABLES[category]}').rowcount
                    if removed:
                        put_meta(db, 'local_clear_floors', floors)
                        put_meta(db, 'retention_revision', revision + 1)
                    if self.guard() != identity:
                        raise ArchiveError('archive changed before clearing')
                    db.execute('COMMIT')
                except BaseException:
                    if db.in_transaction:
                        db.execute('ROLLBACK')
                    raise
                self.ack = None
                self.compacting = True
                self.due = 0
            if 'metadata' in categories:
                removed['metadata'] = 0  # Only unused SQLite pages can be reclaimed here.
            return removed

    def storage_request(self, paired, action, args):
        from .cold_storage import execute_query, meta
        with self.reading() as path:
            with closing(sqlite3.connect(path.absolute().as_uri()+'?mode=ro',uri=True,timeout=2)) as db:
                archive_id = self.config['volumeId'] + ':' + str(meta(db, 'retention_revision', 0))
            value = execute_query(path, {**self.config, 'querySeconds': 45}, {
                'schema': 1, 'sourceId': self.config['sourceId'], 'action': action, 'device': paired['deviceId'],
                'generation': paired['generation'], 'args': args, 'costSettings': None, 'tail': {t: [] for t in TABLES}})['result']
            if action == 'storage_info':
                value.update(policy={'localDays': 30, **self.state, 'path': str(self.root),
                                     'limitBytes': self.config['limitBytes'], 'oldestFirst': True})
            value['archiveId'] = archive_id
            return value

    def query(self, app, action, paired, args):
        from .cold_storage import execute_query, meta
        try:
            with self.reading() as path:
                with closing(sqlite3.connect(path.absolute().as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
                    state = meta(db, 'replication')
                    archive_id = self.config['volumeId'] + ':' + str(meta(db, 'retention_revision', 0))
                if not state or state['sourceId'] != self.config['sourceId']: raise ArchiveError('archive not ready')
                delta = read_delta({'variants': app.database, 'battery': app.analytics_database}, state['checkpoints'])
                if any(p['more'] for p in delta.values()):
                    return None, {**self.state, 'available': False, 'source': 'local', 'reason': 'syncing'}
                result = execute_query(path, {**self.config, 'querySeconds': 45}, {
                    'schema': 1, 'sourceId': self.config['sourceId'], 'action': action, 'device': paired['deviceId'],
                    'generation': paired['generation'], 'args': list(args), 'costSettings': paired.get('costSettings'),
                    'tail': {t: p['rows'] for t, p in delta.items()}})['result']
                return result, {**self.state, 'available': True, 'source': self.backend, 'archiveId': archive_id}
        except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
            return None, {**self.state, 'available': False, 'source': 'local', 'reason': 'unavailable'}


def prepare_folder(value, data, previous=None):
    """Explicit admin Save only. Never called automatically after a disconnect."""
    from .cold_storage import open_writer, meta, put_meta
    value = settings(value)
    if value.get('locationId'): value = selected_folder(value, data, previous)
    root = Path(value['path']).resolve(strict=True)
    if (not root.is_dir() or root == Path(root.anchor) or
            root == Path(data).resolve() or root.is_relative_to(Path(data).resolve()) or
            root.parts[1:2] in (('proc',), ('sys',), ('dev',))):
        raise ArchiveError('choose a separate existing archive folder')
    marker = root / MARKER
    if marker.exists():
        if marker.is_symlink() or marker.stat().st_size > 4096: raise ArchiveError('invalid archive marker')
        volume = json.loads(marker.read_text(encoding='utf8'))
        if set(volume) != {'schema', 'volumeId'} or volume['schema'] != 1 or len(volume['volumeId']) != 32:
            raise ArchiveError('invalid archive marker')
    else:
        volume = {'schema': 1, 'volumeId': uuid.uuid4().hex}
    path = root / 'history.sqlite'
    if path.is_symlink(): raise ArchiveError('archive database is a symlink')
    # The same active owner may change its quota without reacquiring its lock.
    same = isinstance(previous, ManagedHistory) and previous.root == root
    handle = None if same else _lock_file(root / '.power-monitor-writer.lock')
    try:
        new = not path.exists()
        if new:
            with closing(sqlite3.connect(path)) as db: db.execute('PRAGMA auto_vacuum=INCREMENTAL')
        db = open_writer(path)
        try:
            if db.execute('PRAGMA auto_vacuum').fetchone()[0] != 2:
                raise ArchiveError('legacy archive needs an offline incremental-vacuum migration')
            replication = meta(db, 'replication')
            source_id = replication['sourceId'] if replication else uuid.uuid4().hex
            if replication:
                # Explicit adoption on a replacement HA server preserves all
                # cold rows, but cannot trust checkpoints from its old local DB.
                # Rescan the new local source instead of deleting or rekeying it.
                try:
                    read_delta({'variants': Path(data)/'archive.sqlite', 'battery': Path(data)/'analytics.sqlite'},
                               replication['checkpoints'], 1)
                    old_jk = meta(db, 'jk_replication')
                    if old_jk: read_window_delta(Path(data)/'jk-logbook.sqlite', old_jk['checkpoint'], 1)
                except (OSError, ValueError, KeyError, sqlite3.Error):
                    source_id = uuid.uuid4().hex
                    db.execute('BEGIN IMMEDIATE')
                    try:
                        put_meta(db, 'replication', {'sourceId': source_id, 'checkpoints': {}})
                        db.execute("DELETE FROM bridge_meta WHERE name IN ('jk_replication', 'local_clear_floors')")
                        db.execute('COMMIT')
                    except BaseException:
                        db.execute('ROLLBACK'); raise
            # FULL rollback journal also permits mounted filesystems which
            # provide SQLite locking but cannot share a WAL memory segment.
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            db.execute('PRAGMA journal_mode=DELETE')
            for table, stamp in (('variants', 'timestamp'), ('battery', 'observed'), ('windows', 'observed')):
                db.execute(f'CREATE INDEX IF NOT EXISTS pm_retention_{table} ON {table}({stamp})')
        finally: db.close()
        save_json(marker, volume)
    finally:
        if handle: handle.close()
    return {**value, 'path': str(root), 'volumeId': volume['volumeId'], 'sourceId': source_id}


class StorageWorker:
    """One external writer/configuration owner; never opens an ESP connection.

    Slow filesystem calls cannot block the local archive/live/control owner.
    The one-slot configuration queue and read lock bound outstanding work. A
    stuck owner is never replaced by a second thread; shutdown joins it once.
    """
    def __init__(self, app):
        self.app = app
        self.thread = threading.Thread(target=self.run, name='power-monitor-storage', daemon=True)

    def run(self):
        app = self.app
        try:
            while not app.stop.is_set():
                app._storage_config_pass()
                reader = app.external_history
                if isinstance(reader, ManagedHistory) and time.monotonic() >= app.ota_quiet_until:
                    reader.step(app)
                app.storage_ready.clear()
                with app.lock:
                    pending = app.storage_command is not None and app.storage_command.get('scope') != 'local'
                if not pending: app.storage_ready.wait(.2)
        except Exception as error:
            app.storage_worker_error = type(error).__name__
            reader = app.external_history
            if isinstance(reader, ManagedHistory):
                reader.ack = None
                reader.state = {'configured': True, 'backend': 'folder', 'available': False,
                                'source': 'local', 'reason': 'writer_failed'}
        finally:
            reader = app.external_history
            if isinstance(reader, ManagedHistory): reader.close()
            with app.lock:
                command = app.storage_command
                app.storage_command = None
            if command:
                command['error'] = 'storage owner stopped'
                command['done'].set()
