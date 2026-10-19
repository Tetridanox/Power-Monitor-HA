"""Bounded, single-device pull client. No administrator credentials."""
import http.client
import ipaddress
import json
import struct
import time
import sqlite3
from urllib.parse import urlsplit

from .store import ArchiveError, ArchiveStore, Page, _fnv, _hex


class SourceError(ArchiveError):
    def __init__(self, status: int, retry_after: int = 2):
        super().__init__(f"source HTTP {status}")
        self.status, self.retry_after = status, retry_after


def decode_page(raw: bytes, kind: str):
    code = {"minute": 1, "daily": 2, "today": 3}[kind]
    stride, limit = (38, 64) if kind == "minute" else (56, 1 if kind == "today" else 3)
    if len(raw) < 24 or raw[:4] != b"PMA1" or raw[4] != code or raw[5] & ~1 or raw[7] != stride:
        raise ArchiveError("unsupported archive envelope")
    count = raw[6]
    if count > limit or len(raw) != 24 + count * stride or any(raw[12:24]):
        raise ArchiveError("incomplete or oversized archive envelope")
    if _fnv(raw[24:]) != struct.unpack_from("<I", raw, 8)[0]:
        raise ArchiveError("archive envelope checksum mismatch")
    if kind == "today" and raw[5] or not count and raw[5]:
        raise ArchiveError("invalid page progress")
    return tuple(raw[24 + i * stride:24 + (i + 1) * stride] for i in range(count)), bool(raw[5])


class Source:
    def __init__(self, address: str, token: str):
        ip = ipaddress.ip_address(address)
        if ip.version != 4 or not ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified:
            raise ArchiveError("paired source must be a private LAN IPv4 address")
        if not _hex(token, 64):
            raise ArchiveError("invalid archive credential")
        self.address, self._token = address, token
        self.request_count = 0
        self.response_bytes = 0

    def request(self, headers=None, *, method="GET", body=None, accepted=(200,), maximum=2456):
        if maximum not in (2456, 8192):
            raise ArchiveError("invalid source body bound")
        connection = http.client.HTTPConnection(self.address, 80, timeout=8)
        self.request_count += 1
        try:
            connection.request(method, "/api/archive", body=body, headers={"Authorization": "Bearer " + self._token,
                "Connection": "close", **(headers or {})})
            response = connection.getresponse()
            raw = response.read(maximum + 1)
            self.response_bytes += len(raw)
            if response.status not in accepted:
                retry = response.getheader("Retry-After", "2")
                raise SourceError(response.status, min(300, max(2, int(retry))) if retry.isdecimal() else 2)
            length = response.getheader("Content-Length", "")
            if len(raw) > maximum or not length.isdecimal() or int(length) != len(raw) or response.getheader("Transfer-Encoding"):
                raise ArchiveError("source body not complete and bounded")
            return raw, {name.lower(): value for name, value in response.getheaders()}
        finally:
            connection.close()

    def manifest(self):
        raw, _ = self.request()
        result = json.loads(raw)
        if (result.get("protocol") != 1 or result.get("minuteSchema") != "pmh3-38" or
                result.get("dailySchema") != "day2-56" or result.get("dayPolicy") != "unknown" or
                not _hex(result.get("deviceId"), 12) or not _hex(result.get("generation"), 32) or
                not _hex(result.get("bootEpoch"), 16) or result.get("enabled") is not True or result.get("ready") is not True):
            raise ArchiveError("incompatible source manifest")
        return result

    def set_interface(self, manifest, url):
        if manifest.get("interfaceControl") is not True:
            raise ArchiveError("fresh pairing is required for interface switching")
        if not isinstance(url, str) or len(url) > 192:
            raise ArchiveError("invalid panel URL")
        if url:
            target = urlsplit(url)
            if (target.scheme not in ("http", "https") or not target.hostname or target.username or target.password or
                    target.path != "/power-monitor" or target.query != "device=" + manifest["deviceId"] or target.fragment):
                raise ArchiveError("invalid panel URL")
        try:
            self.request({"X-Archive-Command": "interface", "Content-Type": "application/json"},
                         method="POST", body=json.dumps({"revision": manifest["revision"], "url": url}).encode())
        except (OSError, http.client.HTTPException):
            pass  # Ambiguous write: resolve with readback, never repeat POST.
        current = self.manifest()
        if (current["deviceId"] != manifest["deviceId"] or current["generation"] != manifest["generation"] or
                current.get("interfaceUrl") != url):
            raise ArchiveError("interface save was not confirmed")
        return {"interfaceUrl": url, "saved": True}

    def page(self, manifest, kind, before="latest"):
        raw, headers = self.request({"X-Archive-Kind": kind, "X-Archive-Before": before,
            "X-Archive-Epoch": manifest["bootEpoch"], "X-Archive-Generation": manifest["generation"]})
        if headers.get("x-archive-epoch") != manifest["bootEpoch"] or headers.get("x-archive-generation") != manifest["generation"]:
            raise ArchiveError("source changed while reading a page")
        return decode_page(raw, kind)

    def live(self, manifest):
        if manifest.get("liveRead") is not True:
            raise ArchiveError("fresh pairing is required for current readings")
        raw, headers = self.request({"X-Archive-Kind": "live", "X-Archive-Epoch": manifest["bootEpoch"],
            "X-Archive-Generation": manifest["generation"]}, maximum=8192)
        if headers.get("x-archive-epoch") != manifest["bootEpoch"] or headers.get("x-archive-generation") != manifest["generation"]:
            raise ArchiveError("source changed while reading current values")
        data = json.loads(raw, parse_constant=lambda _: None)
        if not isinstance(data, dict) or len(data) > 384 or not isinstance(data.get("uptime"), (int, float)):
            raise ArchiveError("invalid current readings")
        return data


class Synchronizer:
    def __init__(self, store: ArchiveStore, source: Source, device: str, generation: str):
        if not _hex(device, 12) or not _hex(generation, 32):
            raise ArchiveError("invalid pairing identity")
        self.store, self.source, self.device, self.generation = store, source, device, generation
        self.stopped = False
        self.status = {"state": "starting", "minuteBackfillComplete": False, "dailyBackfillComplete": False,
                       "lastSuccess": None, "reconciliations": 0, "coverage": "not_yet_verified"}

    def _cursor(self, manifest, kind, lane):
        current = self.store.cursor(self.device, self.generation, kind, lane)
        if current and current[0] != manifest["bootEpoch"]:
            self.store.restart_lane(self.device, self.generation, kind, lane, current)
            self.status["reconciliations"] += 1
            self.status["coverage"] = "rechecking_after_boot_change"
            current = None
        return current

    def _pull(self, manifest, kind, lane):
        storage_kind = "daily" if kind == "today" else kind
        current = self._cursor(manifest, storage_kind, lane)
        old = current[1] if current else None
        if lane == "backfill" and old and old.startswith("done:"):
            return True
        before = old.split(":", 1)[1] if lane == "backfill" and old else "latest"
        try:
            records, more = self.source.page(manifest, kind, before)
        except SourceError as error:
            if error.status == 409 and current:
                self.store.restart_lane(self.device, self.generation, storage_kind, lane, current)
                self.status["reconciliations"] += 1
                self.status["coverage"] = "anchor_expired_possible_gap"
                return False
            raise
        if records:
            identity = struct.unpack_from("<I", records[0], 0 if kind == "minute" else 4)[0]
            if lane == "backfill":
                following = f"{'before' if more else 'done'}:{identity}"
            else:
                # Fingerprint all variants/today updates, including changes with
                # identical sequence or day. This is a cursor, not a record key.
                import hashlib
                latest = struct.unpack_from("<I", records[-1], 0 if kind == "minute" else 4)[0]
                if lane == "tail" and old and old.startswith("seen:"):
                    previous_id = int(old.split(":")[1])
                    ids = [struct.unpack_from("<I", raw, 0 if kind == "minute" else 4)[0] for raw in records]
                    if previous_id not in ids:
                        backfill = self.store.cursor(self.device, self.generation, storage_kind, "backfill")
                        if backfill:
                            self.store.restart_lane(self.device, self.generation, storage_kind, "backfill", backfill)
                        self.status["coverage"] = "tail_gap_rechecking_local_window"
                        self.status["reconciliations"] += 1
                following = "seen:" + str(latest) + ":" + hashlib.sha256(b"".join(records)).hexdigest()
        else:
            following = "done:0" if lane == "backfill" else "empty"
        if old == following:
            return not more
        self.store.import_page(Page(self.device, self.generation, storage_kind, manifest["bootEpoch"],
            lane, old, following, records, provisional=kind == "today"))
        return not more

    def cycle(self, backfill_pages=4, cancelled=lambda: False):
        if self.stopped or cancelled():
            return 300
        try:
            manifest = self.source.manifest()
            if manifest["deviceId"] != self.device or manifest["generation"] != self.generation:
                self.stopped = True
                self.status["state"] = "identity_changed_pairing_required"
                return 300
            for kind, lane in (("minute", "tail"), ("daily", "tail"), ("today", "today")):
                if cancelled():
                    return 0
                self._pull(manifest, kind, lane)
                time.sleep(0.05)
            for kind in ("minute", "daily"):
                complete = False
                for _ in range(backfill_pages):
                    if cancelled():
                        return 0
                    complete = self._pull(manifest, kind, "backfill")
                    if complete:
                        break
                    time.sleep(0.1)
                self.status[kind + "BackfillComplete"] = complete
            self.status.update(state="syncing", lastSuccess=int(time.time()))
            return 60 if self.status["minuteBackfillComplete"] and self.status["dailyBackfillComplete"] else 2
        except SourceError as error:
            if error.status in (401, 403):
                self.stopped = True
                self.status["state"] = "grant_disabled_or_revoked"
                return 300
            self.status["state"] = f"source_http_{error.status}"
            return error.retry_after if error.status in (429, 503) else 15
        except (OSError, sqlite3.Error, http.client.HTTPException, ArchiveError, ValueError):
            self.status["state"] = "source_or_storage_error"
            return 15
