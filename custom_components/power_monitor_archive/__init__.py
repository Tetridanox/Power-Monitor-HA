"""An archive owned by HA, with an authenticated native sidebar panel."""
import asyncio
from pathlib import Path
import threading
import sqlite3

import voluptuous as vol
from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import callback
from homeassistant.helpers import device_registry as dr

from .const import DOMAIN, PANEL, VERSION
from .pm_archive.runtime import Application
from .pm_archive.store import ArchiveError
from .coordinator import PowerMonitorCoordinator


def _create_app(hass):
    app = Application({"dataDirectory": hass.config.path(".storage", DOMAIN, "data"), "devices": []})
    # Config entries are the registry; a standalone pilot settings file must
    # never silently authorize an extra device.
    app.devices = []
    return app


async def async_setup(hass, config):
    state = hass.data.setdefault(DOMAIN, {})
    if "app" in state:
        return True
    state["app"] = await hass.async_add_executor_job(_create_app, hass)
    state["reads"] = asyncio.Semaphore(1)
    state["admitted_reads"] = 0
    state["entries"] = {}
    state["coordinators"] = {}
    app = state["app"]
    thread = threading.Thread(target=app.run_writer, name="power-monitor-archive", daemon=True)
    state["thread"] = thread
    thread.start()

    async def stop(_event):
        app.stop.set()
        # Each request has an 8 s timeout; no new cycle starts after stop.
        await hass.async_add_executor_job(thread.join, 12)
    state["stop_unsub"] = hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, stop)
    await hass.http.async_register_static_paths([StaticPathConfig(
        "/power_monitor_archive/panel.js", str(Path(__file__).with_name("panel.js")), False), StaticPathConfig(
        "/power_monitor_archive/brand.svg", str(Path(__file__).with_name("brand.svg")), True)])
    websocket_api.async_register_command(hass, websocket_archive)
    await panel_custom.async_register_panel(hass, frontend_url_path=PANEL,
        webcomponent_name="power-monitor-panel", sidebar_title="Power Monitor",
        sidebar_icon="mdi:flash", module_url="/power_monitor_archive/panel.js?v=" + VERSION,
        require_admin=True)
    return True


async def async_setup_entry(hass, entry):
    state = hass.data[DOMAIN]
    app = state["app"]
    with app.lock:
        if len(app.devices) >= 8 and entry.data["deviceId"] not in {d["deviceId"] for d in app.devices}:
            return False
        app.devices = [d for d in app.devices if d["deviceId"] != entry.data["deviceId"]] + [dict(entry.data)]
    state["entries"][entry.entry_id] = entry
    if entry.data.get("liveRead"):
        coordinator=PowerMonitorCoordinator(hass,app,entry.data["deviceId"])
        state["coordinators"][entry.entry_id]=coordinator
        await coordinator.async_config_entry_first_refresh()
        await hass.config_entries.async_forward_entry_setups(entry,["sensor","binary_sensor"])
    dr.async_get(hass).async_get_or_create(config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, entry.data["deviceId"])}, manufacturer="Power Monitor",
        name=entry.title, model="Server history archive", sw_version=VERSION)
    pending = Path(hass.config.path(".storage", DOMAIN, "pair-" + entry.data["deviceId"] + ".json"))
    await hass.async_add_executor_job(lambda: pending.unlink(missing_ok=True))
    return True


async def async_unload_entry(hass, entry):
    state = hass.data[DOMAIN]
    if entry.entry_id in state["coordinators"]:
        if not await hass.config_entries.async_unload_platforms(entry,["sensor","binary_sensor"]):
            return False
        state["coordinators"].pop(entry.entry_id,None)
    with state["app"].lock:
        state["app"].devices = [d for d in state["app"].devices if d["deviceId"] != entry.data["deviceId"]]
        state["app"].states.pop(entry.data["deviceId"], None)
    state["entries"].pop(entry.entry_id, None)
    return True


@websocket_api.websocket_command({
    vol.Required("type"): DOMAIN + "/query",
    vol.Required("action"): vol.In(("status", "coverage", "history", "days", "resume")),
    vol.Optional("device"): vol.All(str, vol.Match(r"^[0-9a-f]{12}$")),
    vol.Optional("start"): vol.All(int, vol.Range(min=0, max=0xffffffff)),
    vol.Optional("end"): vol.All(int, vol.Range(min=0, max=0xffffffff)),
    vol.Optional("maximum", default=1440): vol.All(int, vol.Range(min=10, max=2000)),
})
@websocket_api.async_response
async def websocket_archive(hass, connection, msg):
    """HA authenticates every call; never expose archive credentials to JS."""
    if not connection.user.is_admin:
        connection.send_error(msg["id"], "unauthorized", "Administrator access required")
        return
    state = hass.data.get(DOMAIN)
    if not state or "app" not in state:
        connection.send_error(msg["id"], "not_ready", "Archive is starting")
        return
    app = state["app"]
    action = msg["action"]
    if action == "status":
        connection.send_result(msg["id"], app.status()); return
    device = msg.get("device")
    with app.lock:
        known = any(d["deviceId"] == device for d in app.devices)
        if action == "resume" and known:
            app.resume.add(device)
    if not known:
        connection.send_error(msg["id"], "unknown_device", "Device is not configured"); return
    if action == "resume":
        connection.send_result(msg["id"], {"accepted": True}); return
    if state["admitted_reads"] >= 4:
        connection.send_error(msg["id"], "busy", "Please retry shortly"); return
    state["admitted_reads"] += 1
    try:
        async with state["reads"]:
            if action == "coverage":
                result = await hass.async_add_executor_job(app.coverage, device)
            else:
                result = await hass.async_add_executor_job(getattr(app, action), device,
                    msg["start"], msg["end"], msg["maximum"])
        connection.send_result(msg["id"], result)
    except (ArchiveError, OSError, ValueError, KeyError, sqlite3.Error):
        connection.send_error(msg["id"], "archive_unavailable", "Archive is temporarily unavailable")
    finally:
        state["admitted_reads"] -= 1
