"""Single archive owner and bounded SQLite readers. No web server or login."""
from pathlib import Path
import random
import sqlite3
import math
from collections import deque
from .device import execute as execute_device, validate_request, json_response
from .device_history import serve as serve_device_history
import struct
import threading
import time

from .store import ArchiveError, ArchiveStore
from .sync import Source, Synchronizer


def device_cache_seconds(path):
    # Live snapshots are shared across viewers; configuration keeps its slower cache.
    return 1 if path.split('?', 1)[0] in ('/api/telemetry', '/api/bms', '/api/relays', '/api/system', '/api/archive') else 5


def pairing_signature(paired):
    return paired['generation'], paired['address'], paired['token']


def live_retry_seconds(failures, error):
    return max(min(30, 2 ** min(failures, 5)), getattr(error, 'retry_after', 0))


def remaining_energy_kwh(values):
    """Estimate remaining bank energy from its aggregated Ah and bank voltage."""
    capacity, voltage = values.get('remaining_capacity'), values.get('battery_voltage')
    if values.get('bms_available') is not True:
        return None
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (capacity, voltage)):
        return None
    energy = capacity * voltage / 1000 if capacity >= 0 and voltage > 0 else None
    return energy if energy is not None and math.isfinite(energy) else None


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
        self.work_ready = threading.Event()
        self.resume = set()
        self.states = {}
        self.writer_error = None
        self.live_states = {}
        self.interface_states = {}
        self.interface_command = None
        self.sources = {}
        self.device_commands = deque()
        self.device_cache = {}
        self.ota_quiet_until = 0

    def _require_binding(self, device, signature, permission):
        """Caller holds lock; never hold it over source I/O."""
        paired = next((d for d in self.devices if d['deviceId'] == device), None)
        if (self.stop.is_set() or not paired or not paired.get(permission) or
                pairing_signature(paired) != signature):
            raise ArchiveError('device pairing changed or permission removed')

    def _command_guard(self, command, permission):
        with self.lock:
            self._require_binding(command['device'], command['signature'], permission)
            if time.monotonic() > command['deadline']:
                raise ArchiveError('device command expired')

    def device_request(self, device, request):
        with self.lock:
            paired = next((dict(d) for d in self.devices if d['deviceId'] == device), None)
        if paired is None:
            raise ArchiveError('unknown device')
        history = serve_device_history(self, paired, request)
        if history is not None:
            return history
        path, headers, body = validate_request(request)
        with self.lock:
            paired = next((d for d in self.devices if d['deviceId'] == device), None)
            if not paired or not paired.get('deviceControl'):
                return json_response({'error': 'device_pairing_required'}, 403)
            signature = pairing_signature(paired)
            key = (device, signature, path, tuple(sorted((k.lower(), v) for k, v in headers.items())))
            if request['method'] == 'GET' and key in self.device_cache:
                until, result = self.device_cache[key]
                if time.monotonic() < until:
                    return result
            if self.stop.is_set() or self.writer_error or len(self.device_commands) >= 8:
                return json_response({'error': 'device_busy'}, 503)
            command = {'device': device, 'request': request, 'key': key,
                       'signature': signature,
                       'deadline': time.monotonic() + 10, 'done': threading.Event()}
            self.device_commands.append(command)
            self.work_ready.set()
        if not command['done'].wait(40):
            raise ArchiveError('device result not confirmed')
        result = command.get('result')
        if isinstance(result, Exception) or result is None:
            raise ArchiveError('device request failed; refresh before retrying a write')
        with self.lock:
            self._require_binding(device, command['signature'], 'deviceControl')
        return result

    def _device_pass(self, syncs):
        with self.lock:
            if not self.device_commands:
                return
            command = self.device_commands.popleft()
            device = command['device']
        try:
            self._command_guard(command, 'deviceControl')
            sync = syncs[device]
            if sync.stopped or command['signature'] != (sync.generation, sync.source.address, sync.source._token):
                raise ArchiveError('device access stopped')
            request, key = command['request'], command['key']
            if request['path'].startswith('/api/update/session'):
                self.ota_quiet_until = time.monotonic() + 20
            with self.lock:
                cached = self.device_cache.get(key)
            if request['method'] == 'GET' and cached and cached[0] > time.monotonic():
                result = cached[1]
            else:
                result = execute_device(sync.source, request, guard=lambda: self._command_guard(command, 'deviceControl'))
            with self.lock:
                self._require_binding(device, command['signature'], 'deviceControl')
                # Writes never retry. Invalidate reads even after an error:
                # command admission is not proof that a durable save failed.
                if request['method'] == 'POST':
                    self.device_cache = {k: v for k, v in self.device_cache.items() if k[0] != device}
                elif result['status'] == 200 and not request['path'].split('?')[0].endswith(('/result', '/unlock', '/full')):
                    if len(self.device_cache) >= 128:
                        self.device_cache.clear()
                    self.device_cache[key] = (time.monotonic() + device_cache_seconds(request['path']), result)
            command['result'] = result
        except Exception as error:
            command['result'] = error
            with self.lock:
                self.device_cache = {k: v for k, v in self.device_cache.items() if k[0] != device}
        finally:
            command['done'].set()

    def set_interface(self, device, url):
        """Queue one short-lived presentation command on the existing I/O owner."""
        command = {"device": device, "url": url, "deadline": time.monotonic() + 10,
                   "done": threading.Event(), "result": None}
        with self.lock:
            if self.stop.is_set() or self.writer_error or self.interface_command is not None:
                raise ArchiveError("interface owner is busy or unavailable")
            paired = next((d for d in self.devices if d['deviceId'] == device), None)
            if not paired:
                raise ArchiveError("unknown device")
            if not paired.get('interfaceControl'):
                raise ArchiveError('interface pairing required')
            command['signature'] = pairing_signature(paired)
            self.interface_command = command
            self.work_ready.set()
        if not command["done"].wait(40):
            raise ArchiveError("result not confirmed; refresh before another action")
        if isinstance(command["result"], Exception):
            raise ArchiveError("interface save failed; check pairing and ESP connection")
        with self.lock:
            self._require_binding(device, command['signature'], 'interfaceControl')
        return command["result"]

    def _interface_pass(self, syncs):
        with self.lock:
            command = self.interface_command
        if command is None:
            return
        try:
            device = command["device"]
            guard = lambda: self._command_guard(command, 'interfaceControl')
            guard()
            sync = syncs[device]
            if sync.stopped or command['signature'] != (sync.generation, sync.source.address, sync.source._token):
                raise ArchiveError("access is stopped")
            manifest = sync.source.manifest()
            if manifest["deviceId"] != device or manifest["generation"] != sync.generation:
                raise ArchiveError("device identity changed")
            guard()
            result = sync.source.set_interface(manifest, command["url"], guard=guard)
            with self.lock:
                self._require_binding(device, command['signature'], 'interfaceControl')
                command['result'] = result
                self.interface_states[device] = {**self.interface_states.get(device, {}), **result}
        except Exception as error:
            command["result"] = error
        finally:
            with self.lock:
                self.interface_command = None
            command["done"].set()

    def run_writer(self):
        try:
            store = ArchiveStore(self.database)
            try:
                syncs, due, live_due, signatures, live_failures = {}, {}, {}, {}, {}
                while not self.stop.is_set():
                    with self.lock:
                        devices = list(self.devices)
                    active = {d["deviceId"] for d in devices}
                    for removed in set(syncs) - active:
                        del syncs[removed]; due.pop(removed, None); signatures.pop(removed, None)
                        live_due.pop(removed, None)
                        live_failures.pop(removed, None)
                        with self.lock:
                            self.live_states.pop(removed, None)
                            self.interface_states.pop(removed, None)
                            self.sources.pop(removed, None)
                            self.device_cache = {k: v for k, v in self.device_cache.items() if k[0] != removed}
                    for d in devices:
                        signature = pairing_signature(d)
                        if signatures.get(d["deviceId"]) != signature:
                            with self.lock:
                                self.device_cache = {k: v for k, v in self.device_cache.items() if k[0] != d['deviceId']}
                            syncs[d["deviceId"]] = Synchronizer(store, Source(d["address"], d["token"]), d["deviceId"], d["generation"])
                            signatures[d["deviceId"]] = signature; due[d["deviceId"]] = 0
                            live_due[d["deviceId"]] = 0
                            live_failures[d["deviceId"]] = 0
                            with self.lock:
                                self.live_states.pop(d["deviceId"], None)
                                self.interface_states.pop(d["deviceId"], None)
                                self.sources[d["deviceId"]] = syncs[d["deviceId"]].source
                    for device, sync in syncs.items():
                        if self.stop.is_set():
                            break
                        if self.device_commands or time.monotonic() < self.ota_quiet_until:
                            continue
                        with self.lock:
                            if device in self.resume:
                                sync.stopped = False; due[device] = 0; self.resume.discard(device)
                                live_due[device] = 0
                                live_failures[device] = 0
                        config = next((d for d in devices if d["deviceId"] == device), {})
                        if config.get("liveRead") and not sync.stopped and time.monotonic() >= live_due[device]:
                            try:
                                manifest = sync.source.manifest()
                                if manifest["deviceId"] != device or manifest["generation"] != sync.generation:
                                    sync.stopped = True
                                    raise ArchiveError("device identity changed")
                                readings = sync.source.live(manifest)
                                with self.lock:
                                    self._require_binding(device, signatures[device], 'liveRead')
                                    self.live_states[device] = {"values": readings, "at": time.time(), "available": True}
                                    self.interface_states[device] = {"interfaceUrl": manifest.get("interfaceUrl", ""),
                                        "interfaceSupported": manifest.get("interfaceSupported") is True,
                                        "interfaceControl": manifest.get("interfaceControl") is True}
                                live_due[device] = time.monotonic() + 1.5
                                live_failures[device] = 0
                            except Exception as error:
                                if getattr(error, "status", None) in (401, 403):
                                    sync.stopped = True
                                    sync.status["state"] = "grant_disabled_or_revoked"
                                elif sync.stopped:
                                    sync.status["state"] = "identity_changed_pairing_required"
                                live_failures[device] = live_failures.get(device, 0) + 1
                                retry = live_retry_seconds(live_failures[device], error)
                                with self.lock:
                                    self.live_states[device] = {"values": {}, "at": time.time(), "available": False,
                                        "errorType": type(error).__name__, "httpStatus": getattr(error, 'status', None),
                                        "retrySeconds": retry}
                                live_due[device] = time.monotonic() + retry
                        if time.monotonic() < due[device]:
                            continue
                        delay = sync.cycle(backfill_pages=4,
                            cancelled=lambda: self.stop.is_set() or not self.device_active(device))
                        due[device] = time.monotonic() + delay + random.uniform(0, min(5, delay / 10))
                        with self.lock:
                            if any(d['deviceId'] == device and pairing_signature(d) == signatures[device] for d in self.devices):
                                self.states[device] = {"deviceId": device, "generation": sync.generation, **sync.status}
                    self._interface_pass(syncs)
                    self._device_pass(syncs)
                    self._wait_for_work()
            finally:
                store.close()
        except Exception as error:
            with self.lock:
                self.writer_error = type(error).__name__

    def _wait_for_work(self):
        # Clear then check the queue under its lock. A producer either leaves
        # queued work visible here or sets the event after the check; no lost wake.
        self.work_ready.clear()
        with self.lock:
            pending = bool(self.device_commands) or self.interface_command is not None
        if not pending and not self.stop.is_set():
            self.work_ready.wait(0.2)

    def status(self):
        with self.lock:
            states = [{"deviceId": d["deviceId"], "name": d.get("name", "Power Monitor"),
                       "localUrl": "http://" + d["address"] + "/local/",
                       "dashboardPath": d.get("dashboardPath"),
                       "deviceControl": d.get("deviceControl") is True,
                       "sourceStats": {"requests": getattr(self.sources.get(d["deviceId"]), "request_count", 0),
                                       "responseBytes": getattr(self.sources.get(d["deviceId"]), "response_bytes", 0)},
                       **self.interface_states.get(d["deviceId"], {}),
                       **self.states.get(d["deviceId"], {"state": "starting"})} for d in self.devices]
            return {"protocol": 1, "writerError": self.writer_error, "devices": states}

    def device_active(self, device):
        with self.lock:
            return any(d["deviceId"] == device for d in self.devices)

    def current(self, device):
        with self.lock:
            value = self.live_states.get(device, {})
            values = dict(value.get('values', {}))
            values['remaining_energy'] = remaining_energy_kwh(values)
            return {**value, 'values': values, "available": bool(value.get("available") and time.time() - value.get("at", 0) < 35)}

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

