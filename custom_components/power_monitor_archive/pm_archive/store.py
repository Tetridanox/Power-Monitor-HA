"""Version 1 bounded archive ingestion, using only the Python standard library.

This is the storage boundary, not a network service. A future scoped reader
must authenticate the device and validate its manifest before constructing Page.
"""
from dataclasses import dataclass
import hashlib
import math
from pathlib import Path
import re
import sqlite3
import struct


class ArchiveError(ValueError):
    pass


class CursorConflict(ArchiveError):
    pass


@dataclass(frozen=True)
class Page:
    device: str
    generation: str
    kind: str
    boot_epoch: str
    lane: str
    previous_cursor: str | None
    next_cursor: str
    records: tuple[bytes, ...]
    # Daily finality is source metadata, never inferred from the PC's date.
    provisional: bool = False
    # Existing flash records do not retain historical timezone rules.
    day_policy: str = "unknown"


def _hex(value: str, size: int) -> bool:
    return isinstance(value, str) and re.fullmatch(f"[0-9a-f]{{{size}}}", value) is not None


def _cursor(value: str | None) -> bool:
    return value is None or (isinstance(value, str) and 1 <= len(value) <= 128
                             and value.isascii() and value.isprintable())


def _fnv(data: bytes) -> int:
    value = 2166136261
    for byte in data:
        value = ((value ^ byte) * 16777619) & 0xffffffff
    return value


def _record(kind: str, raw: bytes) -> tuple[int, int, str]:
    if not isinstance(raw, bytes):
        raise ArchiveError("record must be immutable bytes")
    if kind == "minute":
        if len(raw) != 38 or raw[33] & ~3 or raw[32] > 100:
            raise ArchiveError("invalid pmh3-38 record")
        # V2/V3 preserve 24-bit battery voltage in a 32-bit wire field.
        if struct.unpack_from("<H", raw, 34)[0] > 255:
            raise ArchiveError("battery voltage exceeds source precision")
        identity, timestamp = struct.unpack_from("<II", raw)
    elif kind == "daily":
        if len(raw) != 56 or raw[:4] != struct.pack("<I", 0x44415932) or _fnv(raw[:52]) != struct.unpack_from("<I", raw, 52)[0]:
            raise ArchiveError("invalid day2-56 record")
        energy = struct.unpack_from("<6f", raw, 8)
        # Legacy autonomous energy may be NaN (unknown), never turn it into 0.
        if any(not math.isfinite(v) or v < 0 for v in energy[:5]):
            raise ArchiveError("invalid daily energy")
        if not (math.isnan(energy[5]) or math.isfinite(energy[5]) and energy[5] >= 0):
            raise ArchiveError("invalid autonomous energy")
        identity = timestamp = struct.unpack_from("<I", raw, 4)[0]
        if timestamp < 1700000000:
            raise ArchiveError("daily date unavailable")
    else:
        raise ArchiveError("unsupported record schema")
    fingerprint = hashlib.sha256(f"pm.archive.{kind}.v1\0".encode() + raw).hexdigest()
    return identity, timestamp, fingerprint


def validate(page: Page) -> list[tuple[int, int, str, bytes]]:
    if not _hex(page.device, 12) or not _hex(page.generation, 32) or int(page.generation, 16) == 0:
        raise ArchiveError("invalid source identity")
    if not _hex(page.boot_epoch, 16) or page.lane not in ("backfill", "tail", "today"):
        raise ArchiveError("invalid cursor namespace")
    if not _cursor(page.previous_cursor) or not _cursor(page.next_cursor) or page.next_cursor is None:
        raise ArchiveError("invalid cursor")
    if not isinstance(page.provisional, bool) or page.day_policy != "unknown":
        raise ArchiveError("unsupported day policy")
    limit = 64 if page.kind == "minute" else 3
    if not isinstance(page.records, tuple) or len(page.records) > limit:
        raise ArchiveError("page exceeds bounded contract")
    if page.kind == "minute" and page.provisional:
        raise ArchiveError("minute samples are immutable")
    if page.kind == "daily" and page.provisional and len(page.records) > 1:
        raise ArchiveError("today contains at most one record")
    if (page.lane == "today") != (page.kind == "daily" and page.provisional):
        raise ArchiveError("today requires its own cursor lane")
    rows = [(*_record(page.kind, raw), raw) for raw in page.records]
    if page.kind not in ("minute", "daily"):
        raise ArchiveError("unsupported record schema")
    # Source pages are oldest-to-newest within each bounded page. U32 sequence
    # rollover is allowed; backwards wall clocks do not change sequence order.
    for left, right in zip(rows, rows[1:]):
        distance = (right[0] - left[0]) & 0xffffffff
        if not 0 < distance < 0x80000000:
            raise ArchiveError("unordered or duplicate source records")
    if rows and page.previous_cursor == page.next_cursor:
        raise ArchiveError("nonempty page made no progress")
    return rows


class ArchiveStore:
    """One SQLite writer. Caller serializes imports; no threads created here."""

    def __init__(self, path: str | Path, *, read_only: bool = False):
        self.path = Path(path).resolve()
        self.connection = sqlite3.connect(self.path.as_uri() + ("?mode=ro" if read_only else "?mode=rwc"),
                                          uri=True, isolation_level=None, timeout=5)
        try:
            self.connection.execute("PRAGMA foreign_keys=ON")
            self.connection.execute("PRAGMA cache_size=-2048")
            self.connection.execute("PRAGMA busy_timeout=5000")
            version = self.connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1) or read_only and version != 1:
                raise ArchiveError("unsupported database schema")
            if not read_only:
                if version == 0:
                    if self.connection.execute("SELECT 1 FROM sqlite_master WHERE type='table'").fetchone():
                        raise ArchiveError("refusing to adopt an unrelated database")
                    self.connection.executescript("""
                        BEGIN IMMEDIATE;
                        CREATE TABLE variants (
                            device TEXT NOT NULL, generation TEXT NOT NULL, kind TEXT NOT NULL,
                            record_id INTEGER NOT NULL, fingerprint TEXT NOT NULL,
                            timestamp INTEGER NOT NULL, raw BLOB NOT NULL,
                            provisional INTEGER NOT NULL, day_policy TEXT NOT NULL,
                            PRIMARY KEY(device,generation,kind,record_id,fingerprint,provisional)
                        );
                        CREATE INDEX variants_time ON variants(device,generation,kind,timestamp);
                        CREATE TABLE cursors (
                            device TEXT NOT NULL, generation TEXT NOT NULL, kind TEXT NOT NULL,
                            lane TEXT NOT NULL, boot_epoch TEXT NOT NULL, cursor TEXT NOT NULL,
                            PRIMARY KEY(device,generation,kind,lane)
                        );
                        PRAGMA user_version=1;
                        COMMIT;
                    """)
                self.connection.execute("PRAGMA journal_mode=WAL")
                self.connection.execute("PRAGMA synchronous=FULL")
                self.connection.execute("PRAGMA wal_autocheckpoint=64")
                self.connection.execute("PRAGMA journal_size_limit=4194304")
        except BaseException:
            self.connection.close()
            raise

    def close(self):
        self.connection.close()

    def cursor(self, device: str, generation: str, kind: str, lane: str):
        return self.connection.execute("""SELECT boot_epoch,cursor FROM cursors
            WHERE device=? AND generation=? AND kind=? AND lane=?""",
            (device, generation, kind, lane)).fetchone()

    def import_page(self, page: Page):
        rows = validate(page)  # Reject incomplete/unbounded pages before BEGIN.
        db = self.connection
        db.execute("BEGIN IMMEDIATE")
        try:
            current = self.cursor(page.device, page.generation, page.kind, page.lane)
            expected = None if page.previous_cursor is None else (page.boot_epoch, page.previous_cursor)
            if current != expected:
                # A lost commit response may retry the last page. Verify every
                # record, rather than accepting a matching cursor alone.
                if current == (page.boot_epoch, page.next_cursor) and all(db.execute("""
                    SELECT 1 FROM variants WHERE device=? AND generation=? AND kind=?
                    AND record_id=? AND fingerprint=? AND provisional=?""",
                    (page.device, page.generation, page.kind, row[0], row[2], page.provisional)).fetchone()
                    for row in rows):
                    db.execute("ROLLBACK")
                    return
                raise CursorConflict("reconcile boot/anchor before importing")
            for identity, timestamp, fingerprint, raw in rows:
                db.execute("INSERT OR IGNORE INTO variants VALUES(?,?,?,?,?,?,?,?,?)",
                           (page.device, page.generation, page.kind, identity, fingerprint,
                            timestamp, raw, page.provisional, page.day_policy))
            db.execute("INSERT OR REPLACE INTO cursors VALUES(?,?,?,?,?,?)",
                       (page.device, page.generation, page.kind, page.lane, page.boot_epoch, page.next_cursor))
            db.execute("COMMIT")
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise

    def records(self, device: str, generation: str, kind: str, *, after_row: int = 0, limit: int = 64):
        """Bounded raw export, including conflict count. No automatic summation.

        Row IDs are local pagination anchors, never persistent source identity.
        Scope enforcement belongs to the future authenticated server API.
        """
        if not 1 <= limit <= 64 or after_row < 0:
            raise ArchiveError("invalid export page")
        return self.connection.execute("""SELECT a.rowid,a.record_id,a.fingerprint,a.timestamp,
            a.raw,a.provisional,(SELECT COUNT(*) FROM variants b
              WHERE b.device=a.device AND b.generation=a.generation AND b.kind=a.kind
                AND b.record_id=a.record_id AND b.provisional=a.provisional) AS variants
            FROM variants a WHERE a.device=? AND a.generation=? AND a.kind=? AND a.rowid>?
            ORDER BY a.rowid LIMIT ?""", (device, generation, kind, after_row, limit)).fetchall()

    def restart_lane(self, device: str, generation: str, kind: str, lane: str, expected):
        """Explicit reconciliation: abandon only a checked cursor, retain every row.

        A restart does not certify coverage. The caller exposes the reason and
        performs bounded overlap/backfill from the current source manifest.
        """
        db = self.connection
        db.execute("BEGIN IMMEDIATE")
        try:
            if self.cursor(device, generation, kind, lane) != expected:
                raise CursorConflict("cursor changed during reconciliation")
            db.execute("DELETE FROM cursors WHERE device=? AND generation=? AND kind=? AND lane=?",
                       (device, generation, kind, lane))
            db.execute("COMMIT")
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise

    def backup(self, destination: str | Path):
        """Create a new consistent SQLite backup. Never overwrite an old file."""
        path = Path(destination)
        with path.open("xb"):
            pass
        target = sqlite3.connect(path)
        try:
            self.connection.backup(target, pages=64)
            if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ArchiveError("backup integrity check failed")
        finally:
            target.close()
