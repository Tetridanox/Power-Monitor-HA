"""Bounded local retention, called only by the existing HA SQLite writer.

Never delete an unacknowledged row or the export anchor. The HDD worker issues
the acknowledgement only after a FULL commit and content readback. An absent,
stale or mismatched acknowledgement leaves all local data untouched.
"""
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import sqlite3
import time

from .external_history import TABLES, row_digest, wire_row
from .store import ArchiveError
from .jk_logbook import wire_window, window_anchor

LOCAL_DAYS = 30


def prune_confirmed(connections, ack, source_id, now):
    if (not isinstance(ack, dict) or ack.get('schema') != 1 or
            ack.get('sourceId') != source_id or ack.get('ready') is not True):
        raise ArchiveError('HDD acknowledgement not ready')
    stamp = datetime.fromisoformat(ack['updatedUtc'])
    if stamp.tzinfo is None or not 0 <= now - stamp.timestamp() <= 120:
        raise ArchiveError('HDD acknowledgement stale or clock changed')
    cutoff = int(now) - LOCAL_DAYS * 86400
    checkpoints = ack['checkpoints']
    if set(checkpoints) != set(TABLES):
        raise ArchiveError('incomplete HDD acknowledgement')
    connections=dict(connections);points=dict(checkpoints)
    if 'windows' in connections:
        logbook=ack.get('logbook',{})
        if logbook.get('ready') is True:
            if logbook.get('schema')!=1 or logbook.get('sourceId')!=source_id:
                raise ArchiveError('JK acknowledgement source changed')
            points['windows']=logbook['checkpoint']
        else:
            # Older readers still safely acknowledge PM/BMS, never native logs.
            connections.pop('windows')
    # Validate every source anchor before the first deletion. Keep that row
    # even when it is old, so rowid allocation and delta identity remain stable.
    for table, db in connections.items():
        point = points[table]
        cursor = point['rowid']
        if type(cursor) is not int or not 0 <= cursor < 2**63:
            raise ArchiveError('invalid HDD checkpoint')
        if cursor:
            row = db.execute(f'SELECT rowid,* FROM {table} WHERE rowid=?', (cursor,)).fetchone()
            digest=(window_anchor(wire_window(row)) if table=='windows' else row_digest(wire_row(table,row))) if row else None
            if row is None or digest != point['anchor']:
                raise ArchiveError('HDD checkpoint no longer matches source')
        elif point['anchor'] is not None:
            raise ArchiveError('invalid empty HDD checkpoint')
    counts = {}
    for table, db in connections.items():
        timestamp = 'timestamp' if table == 'variants' else 'observed'
        db.execute('BEGIN IMMEDIATE')
        try:
            db.execute(f'''DELETE FROM {table} WHERE rowid IN
                (SELECT rowid FROM {table} WHERE rowid<? AND {timestamp}<?
                 ORDER BY rowid LIMIT 1024)''', (points[table]['rowid'], cutoff))
            counts[table] = db.execute('SELECT changes()').fetchone()[0]
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise
    return counts


class LocalRetention:
    def __init__(self, data, reader):
        self.data, self.reader = Path(data), reader
        self.due = 0

    def step(self, store, analytics, logbook=None):
        if not self.reader or self.reader.backend not in ('hdd', 'folder') or analytics is None:
            return
        if time.monotonic() < self.due:
            return
        self.due = time.monotonic() + 60
        now = time.time()
        result = {'utc': datetime.now(timezone.utc).isoformat(), 'localDays': LOCAL_DAYS}
        try:
            if self.reader.backend == 'folder':
                # Only the external owner touches the mounted path. The same
                # 120s durable receipt rule applies as to the old HDD service;
                # disk loss must not stall live/control on the local owner.
                ack = self.reader.ack
            else:
                ack_path = self.data / 'hdd-ack.json'
                if ack_path.stat().st_size > 16384:
                    raise ArchiveError('oversized HDD acknowledgement')
                ack = json.loads(ack_path.read_text(encoding='utf8'))
            connections={'variants':store.connection,'battery':analytics.connection}
            if logbook is not None:connections['windows']=logbook.connection
            result['deleted'] = prune_confirmed(connections,ack,self.reader.config['sourceId'],now)
            result['ok'] = True
        except (OSError, ValueError, TypeError, KeyError, sqlite3.Error, ArchiveError) as error:
            result.update(ok=False, reason=type(error).__name__)
        try:
            target = self.data / 'retention-status.json'
            temporary = target.with_suffix('.json.new')
            with temporary.open('w', encoding='utf8') as handle:
                json.dump(result, handle); handle.flush(); os.fsync(handle.fileno())
            os.replace(temporary, target)
        except OSError:
            pass  # Failure to write telemetry must not stop the archive owner.
