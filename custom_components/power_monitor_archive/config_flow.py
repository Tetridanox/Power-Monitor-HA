"""Pair an ESP from the normal Home Assistant Add integration dialog."""
import asyncio
import http.client
from pathlib import Path
import json
import os

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.helpers import selector

from .const import DOMAIN
from .pm_archive.pairing import pair, parse_code, confirm
from .pm_archive.store import ArchiveError


def _pair(hass, code, name):
    """Durable intent before POST, one remote write, read-only recovery."""
    parsed = parse_code(code)
    path = Path(hass.config.path(".storage", DOMAIN, "pair-" + parsed["deviceId"] + ".json"))
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists():
        try:
            recovered = confirm(json.loads(path.read_text()), timeout=0)
        except (OSError, ArchiveError):
            pass
        else:
            # Keep the intent until HA has durably stored the config entry.
            return recovered

    def save_intent(intent):
        temporary = path.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(intent, output); output.flush(); os.fsync(output.fileno())
        temporary.replace(path)

    return pair(code, name, save_intent)


class PowerMonitorFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Only a pasted code; no MQTT, SSH or second server account."""
    VERSION = 1

    async def async_step_user(self, user_input=None):
        return await self._step_pair(user_input, False)

    async def async_step_reconfigure(self, user_input=None):
        return await self._step_pair(user_input, True)

    async def _step_pair(self, user_input, reconfigure):
        errors = {}
        if user_input:
            try:
                parsed = parse_code(user_input["code"])
                if not parsed["liveSupported"]:
                    raise ArchiveError("update ESP firmware to 1.0.154 or later")
                await self.async_set_unique_id(parsed["deviceId"])
                if reconfigure:
                    entry=self._get_reconfigure_entry()
                    if parsed["deviceId"] != entry.unique_id:
                        return self.async_abort(reason="wrong_device")
                else:
                    self._abort_if_unique_id_configured()
                # Serialize pairing flows: device limit and remote writes must
                # never race. No blocking socket, disk or sleep on HA's loop.
                state = self.hass.data.setdefault(DOMAIN, {})
                lock = state.setdefault("pair_lock", asyncio.Lock())
                async with lock:
                    if not reconfigure and len(self._async_current_entries()) >= 8:
                        return self.async_abort(reason="device_limit")
                    record = await self.hass.async_add_executor_job(
                        _pair, self.hass, user_input["code"], user_input.get("name", "Power Monitor"))
                if reconfigure:
                    return self.async_update_reload_and_abort(entry,data=record)
                return self.async_create_entry(title=record["name"], data=record)
            except (OSError, ArchiveError, ValueError, http.client.HTTPException):
                errors["base"] = "cannot_connect"
        return self.async_show_form(step_id="reconfigure" if reconfigure else "user", errors=errors, data_schema=vol.Schema({
            vol.Required("code"): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)),
            vol.Optional("name", default="Power Monitor"): str,
        }))
