"""Single archive owner and bounded SQLite readers. No web server or login."""
from pathlib import Path
import random
import sqlite3
import struct
import threading
import time

from .store import ArchiveError, ArchiveStore
from .sync import Source, Synchronizer


def power_summary(rows):
    """Fixed-memory statistics over source records, before graph decimation."""
    channels = {key: {"sum": 0, "count": 0, "max": None, "min": None}
                for key in ("pvPower", "gridPower", "loadPower", "batteryChargePower", "batteryDischargePower",
                            "gridVoltage", "outputVoltage", "batteryVoltage", "pvVoltage", "inverterTemperature", "soc")}
    previous = None
    first = last = None
    gaps, gap_count = [], 0
    for timestamp, raw in rows:
        fields = struct.unpack("<III8H4bBBHH", raw)
        first = timestamp if first is None else first
        last = timestamp
        if previous is not None and timestamp - previous > 120:
            gap_count += 1
            if len(gaps) < 64:
                gaps.append([previous + 60, timestamp])
        previous = timestamp
        for key, value in minute_measurements(fields).items():
            if value is None: continue
            item = channels[key]
            item["sum"] += value; item["count"] += 1
            item["max"] = value if item["max"] is None else max(item["max"], value)
            item["min"] = value if item["min"] is None else min(item["min"], value)
        # No minute energy is inferred from samples: gaps and source timing
        # must not turn into fabricated kWh.
    for item in channels.values():
        item["average"] = item["sum"] / item["count"] if item["count"] else None
        del item["sum"]
    return {"channels": channels, "first": first, "last": last, "gaps": gaps,
            "gapCount": gap_count, "averagePolicy": "valid_source_samples"}


def minute_measurements(fields):
    """Only recorded fields with their source validity and missing sentinels."""
    inv, battery = bool(fields[16] & 1), bool(fields[16] & 2)
    values = {key: fields[3+i] if (battery if i >= 3 else inv) else None
              for i,key in enumerate(("pvPower","gridPower","loadPower","batteryChargePower","batteryDischargePower"))}
    values.update(gridVoltage=fields[9]/10 if inv else None,
                  outputVoltage=fields[10]/10 if inv else None,
                  batteryVoltage=(fields[8] | fields[17]<<16)/1000 if battery else None,
                  pvVoltage=fields[18]/10 if inv and fields[18]!=65535 else None,
                  inverterTemperature=fields[14] if inv and fields[14]!=-128 else None,
                  soc=fields[15] if battery and fields[15]<=100 else None)
    return values


class Application:
    def __init__(self, config):
        self.data = Path(config["dataDirectory"]).resolve()
        self.data.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.database = self.data / "archive.sqlite"
        self.devices = list(config.get("devices", []))
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.resume = set()
        self.states = {}
        self.writer_error = None
        self.live_states = {}

    def run_writer(self):
        try:
            store = ArchiveStore(self.database)
            try:
                syncs, due, live_due, signatures = {}, {}, {}, {}
                while not self.stop.is_set():
                    with self.lock:
                        devices = list(self.devices)
                    active = {d["deviceId"] for d in devices}
                    for removed in set(syncs) - active:
                        del syncs[removed]; due.pop(removed, None); signatures.pop(removed, None)
                        live_due.pop(removed, None)
                        with self.lock:
                            self.live_states.pop(removed, None)
                    for d in devices:
                        signature = (d["generation"], d["address"], d["token"])
                        if signatures.get(d["deviceId"]) != signature:
                            syncs[d["deviceId"]] = Synchronizer(store, Source(d["address"], d["token"]), d["deviceId"], d["generation"])
                            signatures[d["deviceId"]] = signature; due[d["deviceId"]] = 0
                            live_due[d["deviceId"]] = 0
                            with self.lock:
                                self.live_states.pop(d["deviceId"], None)
                    for device, sync in syncs.items():
                        if self.stop.is_set():
                            break
                        with self.lock:
                            if device in self.resume:
                                sync.stopped = False; due[device] = 0; self.resume.discard(device)
                                live_due[device] = 0
                        config = next((d for d in devices if d["deviceId"] == device), {})
                        if config.get("liveRead") and not sync.stopped and time.monotonic() >= live_due[device]:
                            try:
                                manifest = sync.source.manifest()
                                if manifest["deviceId"] != device or manifest["generation"] != sync.generation:
                                    sync.stopped = True
                                    raise ArchiveError("device identity changed")
                                readings = sync.source.live(manifest)
                                with self.lock:
                                    self.live_states[device] = {"values": readings, "at": time.time(), "available": True}
                                live_due[device] = time.monotonic() + 10
                            except Exception as error:
                                if getattr(error, "status", None) in (401, 403):
                                    sync.stopped = True
                                    sync.status["state"] = "grant_disabled_or_revoked"
                                elif sync.stopped:
                                    sync.status["state"] = "identity_changed_pairing_required"
                                with self.lock:
                                    self.live_states[device] = {"values": {}, "at": time.time(), "available": False}
                                live_due[device] = time.monotonic() + 30
                        if time.monotonic() < due[device]:
                            continue
                        delay = sync.cycle(backfill_pages=4,
                            cancelled=lambda: self.stop.is_set() or not self.device_active(device))
                        due[device] = time.monotonic() + delay + random.uniform(0, min(5, delay / 10))
                        with self.lock:
                            if any(d["deviceId"] == device for d in self.devices):
                                self.states[device] = {"deviceId": device, "generation": sync.generation, **sync.status}
                    self.stop.wait(0.2)
            finally:
                store.close()
        except Exception as error:
            with self.lock:
                self.writer_error = type(error).__name__

    def status(self):
        with self.lock:
            states = [{"deviceId": d["deviceId"], "name": d.get("name", "Power Monitor"),
                       **self.states.get(d["deviceId"], {"state": "starting"})} for d in self.devices]
            return {"protocol": 1, "writerError": self.writer_error, "devices": states}

    def device_active(self, device):
        with self.lock:
            return any(d["deviceId"] == device for d in self.devices)

    def current(self, device):
        with self.lock:
            value = self.live_states.get(device, {})
            return {**value, "available": bool(value.get("available") and time.time() - value.get("at", 0) < 35)}

    def coverage(self, device):
        paired = next((d for d in self.devices if d["deviceId"] == device), None)
        if not paired:
            raise ArchiveError("unknown device")
        if not self.database.exists():
            return {"first": None, "last": None, "minuteRecords": 0, "dayRecords": 0}
        db = sqlite3.connect(self.database.as_uri() + "?mode=ro", uri=True, timeout=2)
        try:
            row = db.execute("""SELECT MIN(CASE WHEN timestamp>=1700000000 THEN timestamp END),
                MAX(CASE WHEN timestamp>=1700000000 THEN timestamp END),COUNT(*) FROM variants
                WHERE device=? AND generation=? AND kind='minute'""", (device, paired["generation"])).fetchone()
            days = db.execute("SELECT COUNT(DISTINCT record_id) FROM variants WHERE device=? AND generation=? AND kind='daily'",
                              (device, paired["generation"])).fetchone()[0]
            dates = db.execute("SELECT MIN(timestamp),MAX(timestamp) FROM variants WHERE device=? AND generation=? AND kind='daily'",
                               (device, paired["generation"])).fetchone()
            return {"first": row[0], "last": row[1], "firstDay": dates[0], "lastDay": dates[1], "minuteRecords": row[2], "dayRecords": days}
        finally:
            db.close()

    def days(self, device, start, end, maximum):
        paired = next((d for d in self.devices if d["deviceId"] == device), None)
        if not paired or not 0 <= start < end <= 0xffffffff or not 10 <= maximum <= 2000:
            raise ArchiveError("invalid daily range")
        db = sqlite3.connect(self.database.as_uri() + "?mode=ro", uri=True, timeout=2)
        try:
            width = max(86400, (end - start + maximum) // maximum)
            rows = db.execute("""WITH versions AS (
                SELECT record_id,SUM(CASE WHEN provisional=0 THEN 1 ELSE 0 END) AS finals,
                MAX(CASE WHEN provisional=0 THEN rowid END) AS final_row,
                MAX(CASE WHEN provisional=1 THEN rowid END) AS provisional_row FROM variants
                WHERE device=? AND generation=? AND kind='daily' GROUP BY record_id
              ) SELECT a.timestamp,a.raw,a.provisional FROM variants a JOIN versions v
                ON a.rowid=CASE WHEN finals=1 THEN final_row WHEN finals=0 THEN provisional_row END
                WHERE a.timestamp>=? AND a.timestamp<=? ORDER BY a.timestamp""",
                (device, paired["generation"], start, end))
            bins = {}
            for timestamp, raw, provisional in rows:
                bucket = (timestamp - start) // width
                point = bins.setdefault(bucket, {"timestamp": timestamp, "pvWh": 0, "gridWh": 0,
                    "loadWh": 0, "batteryChargeWh": 0, "batteryDischargeWh": 0, "days": 0, "provisional": False})
                values = struct.unpack_from("<5f", raw, 8)
                for key, value in zip(("pvWh", "gridWh", "loadWh", "batteryChargeWh", "batteryDischargeWh"), values):
                    point[key] += value
                point["days"] += 1; point["provisional"] |= bool(provisional)
            return {"points": list(bins.values())[:maximum], "source": "server", "dayPolicy": "as_recorded_by_esp",
                    "coverage": "available_imported_records_only", "downsampleSeconds": width}
        finally:
            db.close()

    def history(self, device, start, end, maximum):
        paired = next((d for d in self.devices if d["deviceId"] == device), None)
        if not paired or not (0 <= start < end <= 0xffffffff) or not 10 <= maximum <= 2000:
            raise ArchiveError("invalid history request")
        if not self.database.exists():
            return {"points": [], "source": "server", "coverage": "starting"}
        connection = sqlite3.connect(self.database.as_uri() + "?mode=ro", uri=True, timeout=2)
        try:
            # SQL works on the server's own DB, never proxies a browser to ESP.
            connection.execute("PRAGMA query_only=ON")
            connection.execute("PRAGMA cache_size=-1024")
            connection.execute("BEGIN")
            width = max(1, (end - start + maximum) // maximum)
            rows = connection.execute("""WITH unambiguous AS (
                SELECT timestamp,raw,record_id FROM variants WHERE device=? AND generation=? AND kind='minute'
                GROUP BY record_id HAVING COUNT(*)=1
              ), windowed AS (
                SELECT timestamp,raw,LAG(timestamp) OVER (ORDER BY timestamp,record_id) AS previous
                FROM unambiguous WHERE timestamp>=? AND timestamp<=?
              ), ranked AS (
                SELECT *,ROW_NUMBER() OVER (PARTITION BY ((timestamp-?)/?) ORDER BY timestamp) AS pick,
                MAX(CASE WHEN timestamp-previous>120 THEN 1 ELSE 0 END)
                  OVER (PARTITION BY ((timestamp-?)/?)) AS gap FROM windowed
              ) SELECT timestamp,raw,gap FROM ranked WHERE pick=1 ORDER BY timestamp LIMIT ?""",
              (device, paired["generation"], start, end, start, width, start, width, maximum)).fetchall()
            points = []
            for timestamp, raw, gap in rows:
                fields = struct.unpack("<III8H4bBBHH", raw)
                points.append({"timestamp": timestamp, "pvPower": fields[3], "gridPower": fields[4],
                    "loadPower": fields[5], "batteryChargePower": fields[6], "batteryDischargePower": fields[7],
                    "battMv": fields[8] | fields[17] << 16, "tInv": fields[14], "soc": fields[15],
                    "available": bool(fields[16] & 1), "batteryAvailable": bool(fields[16] & 2),
                    "pvDv": fields[18], "gapBefore": bool(gap), **minute_measurements(fields)})
            conflicts = connection.execute("""SELECT COUNT(*) FROM (
                SELECT record_id FROM variants WHERE device=? AND generation=? AND kind='minute'
                GROUP BY record_id HAVING COUNT(*)>1)""", (device, paired["generation"])).fetchone()[0]
            summary = power_summary(connection.execute("""WITH unambiguous AS (
                SELECT timestamp,raw,record_id FROM variants
                WHERE device=? AND generation=? AND kind='minute'
                GROUP BY record_id HAVING COUNT(*)=1
              ) SELECT timestamp,raw FROM unambiguous WHERE timestamp>=? AND timestamp<=?
                ORDER BY timestamp,record_id""", (device, paired["generation"], start, end)))
            return {"points": points, "source": "server", "generation": paired["generation"],
                    "conflictingSequences": conflicts, "coverage": "available_imported_records_only",
                    "downsampleSeconds": width, "summary": summary}
        finally:
            connection.close()

