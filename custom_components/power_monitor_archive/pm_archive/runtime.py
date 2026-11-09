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
import base64
import json
import http.client

from .store import ArchiveError, ArchiveStore, unpack_minute, resolve_minute_extensions
from .sync import Source, Synchronizer
from .analytics import AnalyticsStore, read_battery, cost_settings, minute_cost
from .external_history import ExternalHistory, archive_query, row_digest, wire_row
from .retention import LocalRetention
from .jk_logbook import JkLogbookStore, latest_windows, wire_window, window_anchor
from .storage import (CLEAR_CATEGORIES, CLEAR_TABLES, DIAGNOSTICS, clear_local_table, export_page,
                      local_storage, reclaim_local)
from .managed_storage import (ManagedHistory, StorageWorker, load_settings, settings as storage_settings,
                              prepare_folder, save_json, folder_choices, local_space, storage_locations, SETTINGS)


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
                for key in ("pvPower", "pv1Power", "pv2Power", "gridPower", "loadPower", "batteryChargePower", "batteryDischargePower",
                            "gridVoltage", "outputVoltage", "batteryVoltage", "pvVoltage", "pv2Voltage", "inverterTemperature", "soc")}
    previous = None
    first = last = None
    gaps, gap_count = [], 0
    for timestamp, raw in rows:
        fields = unpack_minute(raw)
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
    second = fields[20] if inv and fields[20] != 65535 and fields[20] <= fields[3] else None
    values.update(pv1Power=fields[3]-second if second is not None else None, pv2Power=second,
                  gridVoltage=fields[9]/10 if inv else None,
                  outputVoltage=fields[10]/10 if inv else None,
                  batteryVoltage=(fields[8] | fields[17]<<16)/1000 if battery else None,
                  pvVoltage=fields[18]/10 if inv and fields[18]!=65535 else None,
                  pv2Voltage=fields[19]/10 if inv and fields[19]!=65535 else None,
                  inverterTemperature=fields[14] if inv and fields[14]!=-128 else None,
                  soc=fields[15] if battery and fields[15]<=100 else None)
    return values


class Application:
    def __init__(self, config):
        self.data = Path(config["dataDirectory"]).resolve()
        if config.get('createDataDirectory', True):
            self.data.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.database = self.data / "archive.sqlite"
        self.analytics_database = self.data / "analytics.sqlite"
        self.analytics_error = None
        self.logbook_database = self.data / 'jk-logbook.sqlite'
        self.logbook_states = {}
        self.logbook_error = None
        self.devices = list(config.get("devices", []))
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.work_ready = threading.Event()
        self.resume = set()
        self.states = {}
        self.writer_error = None
        self.live_states = {}
        self.inverter_profiles = {}
        self.interface_states = {}
        self.interface_command = None
        self.sources = {}
        self.device_commands = deque()
        self.device_cache = {}
        self.ota_quiet_until = 0
        self.external_history = None
        self.external_history_error = None
        self.storage_command = None
        self.storage_worker = None
        self.storage_worker_error = None
        self.storage_ready = threading.Event()
        self.storage_pressure = {'recordingPaused': False}
        self.local_reclaims = set()
        self.space_due = 0
        self.storage_settings = {'mode': 'local', 'path': '', 'limitBytes': 10 * 1024**3}
        if config.get('externalHistory', True):
            try:
                self.storage_settings = load_settings(self.data)
                if self.storage_settings['mode'] == 'folder':
                    self.external_history = ManagedHistory(self.storage_settings)
            except (OSError, ValueError, TypeError, KeyError):
                self.external_history_error = 'invalid_configuration'
            reader_config = self.data / 'external-history.json'
            if self.storage_settings['mode'] == 'legacy' and reader_config.exists():
                try:
                    self.external_history = ExternalHistory(reader_config)
                except (OSError, ValueError, TypeError, KeyError):
                    self.external_history_error = 'invalid_configuration'

    def _archive_connection(self):
        connection = sqlite3.connect(self.database.as_uri() + '?mode=ro', uri=True, timeout=2)
        try:
            resolve_minute_extensions(connection)
            connection.execute('PRAGMA query_only=ON')
            connection.execute('PRAGMA cache_size=-1024')
            connection.execute('BEGIN')
            return connection
        except BaseException:
            connection.close(); raise

    def _analytics_connection(self):
        connection = sqlite3.connect(self.analytics_database.as_uri() + '?mode=ro', uri=True, timeout=2)
        try:
            connection.execute('PRAGMA query_only=ON')
            connection.execute('PRAGMA cache_size=-512')
            connection.execute('BEGIN')
            return connection
        except BaseException:
            connection.close(); raise

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
        history = self.archived_device_request(device, request)
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

    @archive_query
    def archived_device_request(self, device, request):
        paired = next((d for d in self.devices if d['deviceId'] == device), None)
        if paired is None:
            raise ArchiveError('unknown device')
        return serve_device_history(self, paired, request)

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
            retention = LocalRetention(self.data, self.external_history)
            analytics = None
            logbooks = None
            try:
                logbooks = JkLogbookStore(self.logbook_database)
            except (OSError, sqlite3.Error, ArchiveError) as error:
                self.logbook_error = type(error).__name__
            try:
                analytics = AnalyticsStore(self.analytics_database)
            except (OSError, sqlite3.Error, ArchiveError) as error:
                self.analytics_error = type(error).__name__
            try:
                for category, target in (('history', store), ('battery', analytics), ('jk_logbook', logbooks)):
                    if target is not None and target.connection.execute(
                            "SELECT 1 FROM sqlite_master WHERE name='pm_cleared'").fetchone():
                        self.local_reclaims.add(category)
                self.storage_worker = StorageWorker(self)
                self.storage_worker.thread.start()
                syncs, due, live_due, signatures, live_failures = {}, {}, {}, {}, {}
                battery_due = {}
                while not self.stop.is_set():
                    retention.reader = self.external_history
                    if time.monotonic() >= self.space_due:
                        self.space_due = time.monotonic() + 30
                        if time.monotonic() >= self.ota_quiet_until:
                            self._reclaim_pending(store, analytics, logbooks)
                        try: self.storage_pressure = local_space(self.data)
                        except OSError: self.storage_pressure = {'recordingPaused': True}
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
                            self.logbook_states = {k:v for k,v in self.logbook_states.items() if k[0]!=removed}
                    for d in devices:
                        signature = pairing_signature(d)
                        if signatures.get(d["deviceId"]) != signature:
                            with self.lock:
                                self.device_cache = {k: v for k, v in self.device_cache.items() if k[0] != d['deviceId']}
                                self.logbook_states = {k:v for k,v in self.logbook_states.items() if k[0]!=d['deviceId']}
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
                                    protocol = manifest.get("inverterProtocol")
                                    if isinstance(protocol, str) and len(protocol) < 32:
                                        self.inverter_profiles[device] = protocol
                                    self.interface_states[device] = {"interfaceUrl": manifest.get("interfaceUrl", ""),
                                        "interfaceSupported": manifest.get("interfaceSupported") is True,
                                        "interfaceControl": manifest.get("interfaceControl") is True}
                                live_due[device] = time.monotonic() + 1.5
                                live_failures[device] = 0
                                if (analytics or logbooks) and not self.storage_pressure['recordingPaused'] and config.get('deviceControl') and time.monotonic() >= battery_due.get(device,0):
                                    battery_due[device] = time.monotonic()+300
                                    self._observe_batteries(analytics,sync,device,signatures[device],readings,logbooks)
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
                        if self.storage_pressure['recordingPaused'] or time.monotonic() < due[device]:
                            continue
                        delay = sync.cycle(backfill_pages=4,
                            cancelled=lambda: self.stop.is_set() or not self.device_active(device))
                        due[device] = time.monotonic() + delay + random.uniform(0, min(5, delay / 10))
                        with self.lock:
                            if any(d['deviceId'] == device and pairing_signature(d) == signatures[device] for d in self.devices):
                                self.states[device] = {"deviceId": device, "generation": sync.generation, **sync.status}
                    self._interface_pass(syncs)
                    self._device_pass(syncs)
                    self._local_clear_pass(store, analytics, logbooks)
                    if time.monotonic() >= self.ota_quiet_until:
                        retention.step(store, analytics, logbooks)
                    self._wait_for_work()
            finally:
                self.stop.set(); self.storage_ready.set()
                if self.storage_worker: self.storage_worker.thread.join(10)
                if analytics:
                    analytics.close()
                if logbooks:
                    logbooks.close()
                store.close()
        except Exception as error:
            with self.lock:
                self.writer_error = type(error).__name__

    def _wait_for_work(self):
        # Clear then check the queue under its lock. A producer either leaves
        # queued work visible here or sets the event after the check; no lost wake.
        self.work_ready.clear()
        with self.lock:
            pending = (bool(self.device_commands) or self.interface_command is not None or
                       (self.storage_command or {}).get('scope') == 'local')
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
            return {**value, 'values': values, 'inverterProtocol': self.inverter_profiles.get(device), "available": bool(value.get("available") and time.time() - value.get("at", 0) < 35)}

    def _analytics_guard(self,device,signature):
        with self.lock:
            self._require_binding(device,signature,'deviceControl')

    def _observe_batteries(self,analytics,sync,device,signature,readings,logbooks=None):
        # Called only by the existing I/O owner after a successful live pass.
        # Optional observations must not invalidate live telemetry or delay a
        # queued control command by opening another slot request.
        for slot in (0,1):
            if self.stop.is_set() or self.device_commands or self.interface_command or time.monotonic()<self.ota_quiet_until:
                break
            if readings.get(f'bms{slot+1}_available') is not True:
                continue
            try:
                guard=lambda:self._analytics_guard(device,signature)
                response=execute_device(sync.source,{'method':'GET','path':f'/api/bms?slot={slot}'},guard=guard)
                guard()
                if response['status']!=200:
                    raise ArchiveError('battery observation unavailable')
                snapshot=json.loads(base64.b64decode(response['body']))
                if analytics:
                    try:
                        analytics.observe(device,sync.generation,slot,time.time(),snapshot)
                        self.analytics_error=None
                    except (OSError,ValueError,sqlite3.Error) as error:
                        self.analytics_error=type(error).__name__
                if logbooks:
                    try:
                        with self.lock:
                            self._require_binding(device,signature,'deviceControl')
                            self.logbook_states[(device,slot)] = logbooks.observe(
                                device,sync.generation,slot,int(time.time()),snapshot)
                        self.logbook_error=None
                    except (OSError,ValueError,sqlite3.Error) as error:
                        self.logbook_error=type(error).__name__
            except (OSError,http.client.HTTPException,ValueError,ArchiveError,sqlite3.Error) as error:
                self.analytics_error=type(error).__name__

    def _storage_binding(self,device):
        with self.lock:
            paired=next((dict(d) for d in self.devices if d['deviceId']==device),None)
        if not paired:
            raise ArchiveError('unknown device')
        return paired

    def storage_configuration(self, device):
        self._storage_binding(device)
        with self.lock:
            value = {k: self.storage_settings[k] for k in ('mode', 'path', 'limitBytes')}
        places = storage_locations(self.data, value['path'] if value['mode']=='folder' else '')
        return {'settings': value, 'folders': folder_choices(), 'localDays': 30, **places,
                'legacyAvailable': value['mode']=='legacy'}

    def configure_storage(self, device, value):
        paired = self._storage_binding(device)
        command = {'paired': paired, 'settings': storage_settings(value), 'done': threading.Event(),
                   'deadline': time.monotonic() + 15}
        self._submit_storage(command)
        self._storage_guard(paired)
        return self.storage_configuration(device)

    def _submit_storage(self, command):
        with self.lock:
            if self.storage_command is not None or self.stop.is_set() or self.writer_error or self.storage_worker_error:
                raise ArchiveError('storage owner busy')
            self.storage_command = command
            (self.work_ready if command.get('scope') == 'local' else self.storage_ready).set()
        if not command['done'].wait(60):
            raise ArchiveError('storage result not confirmed; read current storage before retrying')
        if 'error' in command: raise ArchiveError(command['error'])

    def clear_storage(self, device, scope, categories, archive_id):
        paired = self._storage_binding(device)
        if (scope not in ('local', 'external') or not isinstance(categories, list) or not categories or
                any(key not in CLEAR_CATEGORIES for key in categories) or len(set(categories)) != len(categories) or
                (scope == 'external' and not archive_id)):
            raise ArchiveError('invalid clear request')
        command = {'paired': paired, 'scope': scope, 'categories': categories, 'archiveId': archive_id,
                   'done': threading.Event(), 'deadline': time.monotonic() + 15}
        self._submit_storage(command)
        return command['result']

    def _local_clear_pass(self, store, analytics, logbooks):
        with self.lock:
            command = self.storage_command
        if not command or command.get('scope') != 'local':
            return
        removed, failed, deferred = {}, [], []
        stores = {'history': store, 'battery': analytics, 'jk_logbook': logbooks}
        try:
            self._storage_guard(command['paired'])
            if time.monotonic() > command['deadline'] or time.monotonic() < self.ota_quiet_until:
                raise ArchiveError('storage owner busy')
            for category in command['categories']:
                try:
                    if category == 'metadata':
                        count = 0
                        for filename in DIAGNOSTICS:
                            path = self.data / filename
                            if path.is_file() and not path.is_symlink():
                                path.unlink()
                                count += 1
                        removed[category] = count
                        continue
                    target = stores[category]
                    if target is None:
                        raise ArchiveError('local database unavailable')
                    db = target.connection
                    table = CLEAR_TABLES[category]
                    digest = (lambda row: window_anchor(wire_window(row))) if table == 'windows' else (
                        lambda row: row_digest(wire_row(table, row)))
                    removed[category] = clear_local_table(db, table, digest)
                    try:
                        if not reclaim_local(db, self.data, force=True):
                            deferred.append(category)
                    except (OSError, sqlite3.Error):
                        deferred.append(category)
                except (OSError, ValueError, sqlite3.Error):
                    failed.append(category)
            self.space_due = 0
            self.local_reclaims.update(deferred)
            command['result'] = {'removed': removed, 'failed': failed, 'reclaimDeferred': deferred}
        except (OSError, ValueError, sqlite3.Error) as error:
            command['error'] = type(error).__name__
        finally:
            with self.lock: self.storage_command = None
            command['done'].set()

    def _reclaim_pending(self, store, analytics, logbooks):
        for category, target in (('history', store), ('battery', analytics), ('jk_logbook', logbooks)):
            if category in self.local_reclaims:
                try:
                    if reclaim_local(target.connection, self.data, force=True):
                        self.local_reclaims.remove(category)
                except (OSError, sqlite3.Error):
                    pass  # A busy reader or insufficient disk space can clear later.

    def _storage_config_pass(self):
        with self.lock: command = self.storage_command
        if command is None or command.get('scope') == 'local': return
        try:
            self._storage_guard(command['paired'])
            if time.monotonic() > command['deadline']: raise ArchiveError('storage command expired')
            old = self.external_history
            if command.get('scope') == 'external':
                if not isinstance(old, ManagedHistory) or time.monotonic() < self.ota_quiet_until:
                    raise ArchiveError('external archive unavailable')
                removed = old.clear(self, command['categories'], command['archiveId'])
                command['result'] = {'removed': removed, 'failed': [], 'compacting': True}
                return
            value = command['settings']
            if value['mode'] == 'folder':
                if isinstance(old, ExternalHistory):
                    try: active = old.request('/v1/status').get('ready') is True
                    except (OSError, ValueError, http.client.HTTPException): active = False
                    if active: raise ArchiveError('stop the previous archive service before folder adoption')
                # Explicit folder adoption is the only code allowed to create
                # archive files. A disconnected configured folder is never rebuilt.
                value = prepare_folder(value, self.data, old)
                reader = ManagedHistory(value)
            elif value['mode'] == 'legacy':
                reader = ExternalHistory(self.data / 'external-history.json')
            else: reader = None
            self._storage_guard(command['paired'])
            save_json(self.data / SETTINGS, {'schema': 1, 'settings': {k: value[k] for k in ('mode', 'path', 'limitBytes')},
                **{k: value[k] for k in ('volumeId', 'sourceId') if k in value}})
            # Source-only persistence contains no grants or device settings.
            if isinstance(old, ManagedHistory): old.close()
            with self.lock:
                self.storage_settings = value
                self.external_history = reader
                self.external_history_error = None
        except (OSError, ValueError, TypeError, KeyError, sqlite3.Error) as error:
            command['error'] = type(error).__name__
        finally:
            with self.lock: self.storage_command = None
            command['done'].set()

    def _storage_guard(self,paired):
        with self.lock:
            if not any(d['deviceId']==paired['deviceId'] and pairing_signature(d)==pairing_signature(paired)
                       for d in self.devices):
                raise ArchiveError('pairing changed')

    def storage_info(self,device):
        paired=self._storage_binding(device)
        local={**local_storage(self.data,device,paired['generation']), **self.storage_pressure}
        external={'configured':False,'available':False}
        reader=self.external_history
        if reader:
            try:
                external={**reader.storage_request(paired,'storage_info',[]),
                          'configured':True,'backend':reader.backend}
                if isinstance(reader,ManagedHistory):
                    external['locationKind']='server' if reader.root.stat().st_dev==self.data.stat().st_dev else 'external'
                    external['clearable'] = True
                if self.external_history is not reader:raise ArchiveError('archive changed during storage read')
            except (OSError,ValueError,sqlite3.Error,http.client.HTTPException):
                external={'configured':True,'backend':reader.backend,
                          'available':False,'reason':'reader_unavailable_or_update_required'}
        windows=latest_windows(self.logbook_database,device,paired['generation'])
        # A recent local tail wins; retained older slots remain readable on HDD.
        by_slot={w['slot']:w for w in external.get('logbookWindows',[])}
        for window in windows:
            if window['observed']>=by_slot.get(window['slot'],{}).get('observed',0):
                by_slot[window['slot']]=window
        windows=[by_slot[key] for key in sorted(by_slot)]
        with self.lock:
            states=[{'slot':slot,**self.logbook_states.get((device,slot),{'state':'waiting'})}
                    for slot in (0,1)]
            live=self.live_states.get(device,{})
            if not live.get('available') or time.time()-live.get('at',0)>=35:
                states=[{**state,'state':'offline'} for state in states]
            else:
                for state in states:
                    if live.get('values',{}).get(f"bms{state['slot']+1}_available") is not True:
                        state['state']='offline'
                    elif state['state']=='recording' and time.time()-state.get('observed',0)>600:
                        state['state']='stale'
        self._storage_guard(paired)
        return {'local':local,'external':external,'logbook':{'windows':windows,'states':states,
                'error':self.logbook_error,'sampleIntervalSeconds':300,'maxWindowEntries':50},
                'generation':paired['generation']}

    def storage_export(self,device,scope,dataset,start,end,after=0,upper=0,total=0):
        paired=self._storage_binding(device)
        if scope=='external':
            if not self.external_history:
                raise ArchiveError('dataset unavailable in external storage')
            result=self.external_history.storage_request(paired,'storage_export',
                [dataset,start,end,after,upper,total])
        elif scope=='local':
            path=self.database if dataset in ('minute','daily') else (
                self.analytics_database if dataset=='battery' else self.logbook_database)
            result=export_page(path,device,paired['generation'],dataset,start,end,after,upper,total)
        else:
            raise ArchiveError('unknown storage')
        self._storage_guard(paired)
        return {**result,'generation':paired['generation'],'scope':scope}

    @archive_query
    def analytics(self,device,start,end,maximum,slot=0):
        with self.lock:
            paired=next((dict(d) for d in self.devices if d['deviceId']==device),None)
        if not paired:
            raise ArchiveError('unknown device')
        result=read_battery(self.analytics_database,device,paired['generation'],slot,start,end,maximum,
                            connection_factory=self._analytics_connection)
        result['error']=self.analytics_error
        with self.lock:
            if not any(d['deviceId']==device and pairing_signature(d)==pairing_signature(paired) for d in self.devices):
                raise ArchiveError('pairing changed')
        return result

    @archive_query
    def costs(self,device,start,end,maximum):
        with self.lock:
            paired=next((dict(d) for d in self.devices if d['deviceId']==device),None)
        if not paired or not 0 < end-start <= 366*86400 or not 10<=maximum<=2000:
            raise ArchiveError('invalid cost range')
        settings=cost_settings(paired.get('costSettings'))
        result={'settings':settings,'configured':bool(paired.get('costSettings')),'source':'HA archive','estimated':True,'pricePolicy':'Selected prices applied to the entire selected period; not a supplier bill.'}
        if not self.database.exists():
            return {**result,'cost':None,'coveredSeconds':0}
        db=self._archive_connection()
        try:
            db.execute('PRAGMA query_only=ON'); db.execute('PRAGMA cache_size=-512')
            if settings['mode']=='flat':
                rows=db.execute('''WITH versions AS (
                    SELECT record_id,SUM(CASE WHEN provisional=0 THEN 1 ELSE 0 END) AS finals,
                    MAX(CASE WHEN provisional=0 THEN rowid END) AS final_row,
                    MAX(CASE WHEN provisional=1 THEN rowid END) AS provisional_row FROM variants
                    WHERE device=? AND generation=? AND kind='daily' GROUP BY record_id
                  ) SELECT a.raw FROM variants a JOIN versions v
                    ON a.rowid=CASE WHEN finals=1 THEN final_row WHEN finals=0 THEN provisional_row END
                    WHERE a.timestamp>=? AND a.timestamp<=?''',(device,paired['generation'],start,end))
                grid=pv=0.0;count=0
                for (raw,) in rows:
                    if not struct.unpack_from('<I',raw,48)[0]:continue
                    solar,imported=struct.unpack_from('<2f',raw,8)
                    if not all(math.isfinite(v) and v>=0 for v in (solar,imported)):continue
                    grid+=imported/1000;pv+=solar/1000;count+=1
                totals={'gridKwh':grid if count else None,'pvKwh':pv if count else None,
                        'cost':grid*settings['dayPrice'] if count else None,
                        'pvValueEstimate':pv*settings['dayPrice'] if count else None,'recordedDays':count,
                        'coverage':'Available daily totals only; PV value is not measured savings.'}
            else:
                rows=db.execute('''SELECT timestamp,raw FROM variants WHERE device=? AND generation=? AND kind='minute'
                    AND timestamp>=? AND timestamp<=? GROUP BY record_id HAVING COUNT(*)=1 ORDER BY timestamp''',
                    (device,paired['generation'],max(0,start-120),end))
                totals=minute_cost(rows,settings,start,end)
                totals['coverage']='Only observed minute intervals; gaps and missing old minute data are not estimated.'
            with self.lock:
                if not any(d['deviceId']==device and pairing_signature(d)==pairing_signature(paired) for d in self.devices):
                    raise ArchiveError('pairing changed')
            return {**result,**totals}
        finally:
            db.close()

    @archive_query
    def coverage(self, device):
        paired = next((d for d in self.devices if d["deviceId"] == device), None)
        if not paired:
            raise ArchiveError("unknown device")
        if not self.database.exists():
            return {"first": None, "last": None, "minuteRecords": 0, "dayRecords": 0}
        db = self._archive_connection()
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

    @archive_query
    def days(self, device, start, end, maximum):
        paired = next((d for d in self.devices if d["deviceId"] == device), None)
        if not paired or not 0 <= start < end <= 0xffffffff or not 10 <= maximum <= 2000:
            raise ArchiveError("invalid daily range")
        db = self._archive_connection()
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

    @archive_query
    def history(self, device, start, end, maximum):
        paired = next((d for d in self.devices if d["deviceId"] == device), None)
        if not paired or not (0 <= start < end <= 0xffffffff) or not 10 <= maximum <= 2000:
            raise ArchiveError("invalid history request")
        if not self.database.exists():
            return {"points": [], "source": "server", "coverage": "starting"}
        connection = self._archive_connection()
        try:
            # SQL works on the server's own DB, never proxies a browser to ESP.
            connection.execute("PRAGMA query_only=ON")
            connection.execute("PRAGMA cache_size=-1024")
            width = max(1, (end - start + maximum) // maximum)
            rows = connection.execute("""WITH unambiguous AS (
                SELECT timestamp,raw,record_id FROM variants WHERE device=? AND generation=? AND kind='minute'
                GROUP BY record_id HAVING COUNT(*)=1
              ) SELECT timestamp,raw FROM unambiguous WHERE timestamp>=? AND timestamp<=?
                ORDER BY timestamp,record_id""", (device, paired["generation"], start, end))
            points = []
            def sampled_rows():
                # One ordered scan supplies both full-source statistics and
                # bounded graph bins. A gap anywhere within a bin marks its
                # selected first point, exactly as the previous window query.
                previous = bucket_before = None
                selected = None
                for timestamp, raw in rows:
                    bucket = (timestamp-start)//width
                    gap = previous is not None and timestamp-previous > 120
                    if bucket != bucket_before:
                        selected = None
                        if len(points) < maximum:
                            fields = unpack_minute(raw)
                            selected = {"timestamp": timestamp, "pvPower": fields[3], "gridPower": fields[4],
                                "loadPower": fields[5], "batteryChargePower": fields[6], "batteryDischargePower": fields[7],
                                "battMv": fields[8] | fields[17] << 16, "tInv": fields[14], "soc": fields[15],
                                "available": bool(fields[16] & 1), "batteryAvailable": bool(fields[16] & 2),
                                "pvDv": fields[18], "pv2Dv": fields[19], "gapBefore": gap, **minute_measurements(fields)}
                            points.append(selected)
                        bucket_before = bucket
                    elif gap and selected is not None:
                        selected['gapBefore'] = True
                    previous = timestamp
                    yield timestamp, raw
            summary = power_summary(sampled_rows())
            conflicts = connection.execute("""SELECT COUNT(*) FROM (
                SELECT record_id FROM variants WHERE device=? AND generation=? AND kind='minute'
                GROUP BY record_id HAVING COUNT(*)>1)""", (device, paired["generation"])).fetchone()[0]
            return {"points": points, "source": "server", "generation": paired["generation"],
                    "conflictingSequences": conflicts, "coverage": "available_imported_records_only",
                    "downsampleSeconds": width, "summary": summary}
        finally:
            connection.close()

