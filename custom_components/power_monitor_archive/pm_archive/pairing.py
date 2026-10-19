"""One pasted ESP code. No SSH, address guessing or admin password on server."""
import json
import re
import secrets
import time
import http.client

from .store import ArchiveError
from .sync import Source, SourceError


def parse_code(text):
    if not isinstance(text, str) or len(text) > 100:
        raise ArchiveError("invalid pairing code")
    parts = text.strip().split(":")
    if len(parts) != 5 or parts[0] not in ("PM1", "PM2", "PM3", "PM4") or re.fullmatch("[0-9a-f]{12}", parts[2]) is None or re.fullmatch("[0-9a-f]{32}", parts[4]) is None:
        raise ArchiveError("copy a complete code from ESP: Home Assistant → Connect server")
    if not parts[3].isdecimal() or len(parts[3]) > 10 or int(parts[3]) > 0xffffffff:
        raise ArchiveError("invalid pairing revision")
    # Source's IP allowlist prevents using this form as an arbitrary HTTP proxy.
    Source(parts[1], "0" * 64)
    return {"address": parts[1], "deviceId": parts[2], "revision": int(parts[3]), "code": parts[4], "liveSupported": parts[0] in ("PM2", "PM3", "PM4"), "interfaceSupported": parts[0] in ("PM3", "PM4"), "deviceSupported": parts[0] == "PM4"}


def confirm(intent, timeout=10):
    source = Source(intent["address"], intent["token"])
    deadline = time.monotonic() + timeout
    while True:
        try:
            manifest = source.manifest()
            if manifest["deviceId"] != intent["deviceId"]:
                raise ArchiveError("device identity mismatch")
            if intent.get("requiresLive") and manifest.get("liveRead") is not True:
                raise ArchiveError("current readings permission was not confirmed")
            if intent.get("requiresInterface") and manifest.get("interfaceControl") is not True:
                raise ArchiveError("interface permission was not confirmed")
            if intent.get("requiresDevice") and manifest.get("deviceControl") is not True:
                raise ArchiveError("device control permission was not confirmed")
            return {"address": intent["address"], "deviceId": manifest["deviceId"],
                    "generation": manifest["generation"], "token": intent["token"], "name": intent.get("name", "Power Monitor"),
                    "liveRead": manifest.get("liveRead") is True, "interfaceControl": manifest.get("interfaceControl") is True, "deviceControl": manifest.get("deviceControl") is True}
        except SourceError as error:
            if error.status not in (401, 403) or time.monotonic() >= deadline:
                raise
        time.sleep(0.2)


def pair(code, name, save_intent):
    request = parse_code(code)
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 64:
        raise ArchiveError("device name must contain 1..64 characters")
    intent = {"address": request["address"], "deviceId": request["deviceId"],
              "token": secrets.token_hex(32), "name": name.strip(), "requiresLive": request["liveSupported"], "requiresInterface": request["interfaceSupported"], "requiresDevice": request["deviceSupported"]}
    # Persist recovery credential before a remote write. The one-time code is
    # never put on disk. A lost reply is resolved only by read-only confirmation.
    save_intent(intent)
    source = Source(intent["address"], intent["token"])
    body = json.dumps({"code": request["code"], "deviceId": request["deviceId"],
                       "revision": request["revision"], "token": intent["token"], "liveRead": request["liveSupported"], "interfaceControl": request["interfaceSupported"], "deviceControl": request["deviceSupported"]}).encode()
    try:
        source.request({"X-Archive-Command": "pair", "Content-Type": "application/json"},
                       method="POST", body=body, accepted=(202,))
    except (OSError, http.client.HTTPException, SourceError):
        # Never repeat POST after an ambiguous transport result.
        pass
    return confirm(intent)
