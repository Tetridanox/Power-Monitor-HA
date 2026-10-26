"""An archive owned by HA, with an authenticated native sidebar panel."""
import asyncio
from pathlib import Path
import threading
import sqlite3
import logging

import voluptuous as vol
from homeassistant.components import frontend as ha_frontend, panel_custom, websocket_api, persistent_notification
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.lovelace import LOVELACE_DATA
from homeassistant.const import EVENT_HOMEASSISTANT_STOP, EVENT_CORE_CONFIG_UPDATE
from homeassistant.core import callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN, PANEL, VERSION
from .pm_archive.runtime import Application
from .pm_archive.store import ArchiveError
from .pm_archive.analytics import cost_settings, resolved_cost_settings
from .coordinator import PowerMonitorCoordinator
from .frontend import ensure_frontend_resources


def _create_app(hass):
    app = Application({"dataDirectory": hass.config.path(".storage", DOMAIN, "data"), "devices": []})
    # Config entries are the registry; a standalone pilot settings file must
    # never silently authorize an extra device.
    app.devices = []
    return app


async def _register_card_resource(resources):
    """Load cards after Lovelace installs its custom-element registry."""
    url = "/local/power_monitor_archive/cards-loader.js?v=" + VERSION
    await resources.async_get_info()
    owned = [item for item in resources.async_items()
             if item.get("url", "").split("?", 1)[0] in
             ("/power_monitor_archive/cards.js", "/local/power_monitor_archive/cards-loader.js")]
    if hasattr(resources, "async_create_item"):
        if not owned:
            await resources.async_create_item({"url": url, "res_type": "module"})
        for item in owned:
            if item.get("url") != url or item.get("type") != "module":
                await resources.async_update_item(item["id"], {"url": url, "res_type": "module"})
    else:
        # YAML resources are a runtime collection; never rewrite user YAML.
        resources.data = [item for item in resources.async_items() if item not in owned]
        resources.data.append({"url": url, "type": "module"})


def _register_dashboard_bootstrap(hass):
    # Importing our .frontend submodule sets this package's `frontend` attribute.
    # Keep HA's frontend under a distinct name in the package namespace.
    ha_frontend.add_extra_js_url(hass, '/power_monitor_archive/dashboard-bootstrap.js?v=' + VERSION)


async def async_setup(hass, config):
    state = hass.data.setdefault(DOMAIN, {})
    if "app" in state:
        return True
    def install_loader():
        # Only our loader and pinned vendor assets are owned by this integration.
        # User dashboards and other www resources are never copied or changed.
        target = Path(hass.config.path("www", DOMAIN, "cards-loader.js"))
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".js.pmnew")
        temporary.write_bytes(Path(__file__).with_name("cards-loader.js").read_bytes())
        temporary.replace(target)
        # A blueprint is inert until the admin creates an automation. Preserve
        # any locally edited copy; never create or enable a messaging automation.
        blueprint=Path(hass.config.path('blueprints','automation',DOMAIN,'telegram_reports.yaml'))
        if not blueprint.exists():
            blueprint.parent.mkdir(parents=True,exist_ok=True)
            blueprint.write_bytes((Path(__file__).parent/'blueprints'/'telegram_reports.yaml').read_bytes())
    await hass.async_add_executor_job(install_loader)
    state["app"] = await hass.async_add_executor_job(_create_app, hass)
    state["reads"] = asyncio.Semaphore(1)
    state["admitted_reads"] = 0
    state["entries"] = {}
    state["coordinators"] = {}
    from .telegram_reports import register_reports
    register_reports(hass,state)
    from .energy_statistics import register_energy_statistics
    register_energy_statistics(hass,state)
    app = state["app"]
    @callback
    def update_cost_timezones(_event):
        with app.lock:
            for entry in state['entries'].values():
                for device in app.devices:
                    if device['deviceId']==entry.data['deviceId']:
                        device['costSettings']=resolved_cost_settings(entry.options.get('costSettings'),hass.config.time_zone)
    state['timezone_unsub']=hass.bus.async_listen(EVENT_CORE_CONFIG_UPDATE,update_cost_timezones)
    thread = threading.Thread(target=app.run_writer, name="power-monitor-archive", daemon=True)
    state["thread"] = thread
    thread.start()

    async def stop(_event):
        state['timezone_unsub']()
        from .telegram_commands import stop_receiver
        for device in list(state.get('telegram_receivers',{})):stop_receiver(state,device)
        app.stop.set()
        # Each request has an 8 s timeout; no new cycle starts after stop.
        await hass.async_add_executor_job(thread.join, 12)
    state["stop_unsub"] = hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, stop)
    await hass.http.async_register_static_paths([StaticPathConfig(
        "/power_monitor_archive/panel.js", str(Path(__file__).with_name("panel.js")), False), StaticPathConfig(
        "/power_monitor_archive/dashboard.js", str(Path(__file__).with_name("dashboard.js")), False), StaticPathConfig(
        "/power_monitor_archive/cards.js", str(Path(__file__).with_name("cards.js")), False), StaticPathConfig(
        "/power_monitor_archive/device-card.js", str(Path(__file__).with_name("device-card.js")), False), StaticPathConfig(
        "/power_monitor_archive/dashboard-template.json", str(Path(__file__).with_name("dashboard-template.json")), False), StaticPathConfig(
        "/power_monitor_archive/brand.svg", str(Path(__file__).with_name("brand.svg")), True)])
    await hass.http.async_register_static_paths([
        StaticPathConfig('/power_monitor_archive/' + name, str(Path(__file__).with_name(name)), False)
        for name in ('forecast-card.js', 'dashboard-setup.js', 'dashboard-bootstrap.js', 'control-schema.js', 'control-api.js', 'control-views.js',
                     'i18n.js', 'i18n-messages.js', 'control-validation.js', 'control-hardware.js', 'control-backup.js', 'control-ota.js', 'control-ui.js', 'control.css', 'inverter-catalog.js', 'insights-card.js', 'telegram-card.js')
    ])
    websocket_api.async_register_command(hass, websocket_archive)
    websocket_api.async_register_command(hass, websocket_device)
    try:
        await ensure_frontend_resources(hass, hass.data[LOVELACE_DATA].resources)
        persistent_notification.async_dismiss(hass, DOMAIN+'_frontend')
    except (OSError, ValueError) as error:
        logging.getLogger(__name__).warning('Frontend resources not ready: %s', type(error).__name__)
        persistent_notification.async_create(hass, 'Power Monitor could not download its dashboard cards. Restore Internet access and reload the integration.', title='Power Monitor', notification_id=DOMAIN+'_frontend')
    await _register_card_resource(hass.data[LOVELACE_DATA].resources)
    _register_dashboard_bootstrap(hass)
    await panel_custom.async_register_panel(hass, frontend_url_path=PANEL,
        webcomponent_name="power-monitor-panel", sidebar_title=None if any(e.options.get("dashboardPath") for e in hass.config_entries.async_entries(DOMAIN)) else "Power Monitor",
        sidebar_icon="mdi:flash", module_url="/power_monitor_archive/panel.js?v=" + VERSION,
        require_admin=True)
    return True


async def async_setup_entry(hass, entry):
    registry=er.async_get(hass)
    prefix=entry.data["deviceId"]+"_smart_plug_"
    for entity in er.async_entries_for_config_entry(registry,entry.entry_id):
        if entity.platform==DOMAIN and entity.unique_id.startswith(prefix):
            registry.async_remove(entity.entity_id)
    state = hass.data[DOMAIN]
    app = state["app"]
    with app.lock:
        if len(app.devices) >= 8 and entry.data["deviceId"] not in {d["deviceId"] for d in app.devices}:
            return False
        app.devices = [d for d in app.devices if d["deviceId"] != entry.data["deviceId"]] + [{**entry.data, "dashboardPath": entry.options.get("dashboardPath"), 'costSettings':resolved_cost_settings(entry.options.get('costSettings'),hass.config.time_zone)}]
        for cache in (app.states, app.live_states, app.interface_states):
            cache.pop(entry.data['deviceId'], None)
        app.device_cache = {k: v for k, v in app.device_cache.items() if k[0] != entry.data['deviceId']}
    state["entries"][entry.entry_id] = entry
    from .telegram_commands import refresh_receiver
    try:refresh_receiver(hass,state,entry)
    except ValueError:logging.getLogger(__name__).warning('Invalid Power Monitor Telegram settings; receiver disabled')
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
    from .telegram_commands import stop_receiver
    stop_receiver(state,entry.data['deviceId'])
    if entry.entry_id in state["coordinators"]:
        if not await hass.config_entries.async_unload_platforms(entry,["sensor","binary_sensor"]):
            from .telegram_commands import refresh_receiver
            refresh_receiver(hass,state,entry)
            return False
        state["coordinators"].pop(entry.entry_id,None)
    with state["app"].lock:
        state["app"].devices = [d for d in state["app"].devices if d["deviceId"] != entry.data["deviceId"]]
        state["app"].states.pop(entry.data["deviceId"], None)
        state['app'].live_states.pop(entry.data['deviceId'], None)
        state['app'].interface_states.pop(entry.data['deviceId'], None)
        state['app'].device_cache = {k: v for k, v in state['app'].device_cache.items() if k[0] != entry.data['deviceId']}
    state["entries"].pop(entry.entry_id, None)
    return True


@websocket_api.websocket_command({
    vol.Required("type"): DOMAIN + "/query",
    vol.Required("action"): vol.In(("status", "coverage", "history", "days", "resume", "current", "interface", "dashboard", "analytics", "costs", "analysis_settings", "telegram_settings", "telegram_settings_save")),
    vol.Optional("device"): vol.All(str, vol.Match(r"^[0-9a-f]{12}$")),
    vol.Optional("start"): vol.All(int, vol.Range(min=0, max=0xffffffff)),
    vol.Optional("end"): vol.All(int, vol.Range(min=0, max=0xffffffff)),
    vol.Optional("maximum", default=1440): vol.All(int, vol.Range(min=10, max=2000)),
    vol.Optional("url"): vol.All(str, vol.Length(max=192)),
    vol.Optional("dashboardPath"): vol.All(str, vol.Match(r"^power-monitor-[0-9a-f]{12}$")),
    vol.Optional('slot',default=0):vol.All(int,vol.Range(min=0,max=1)),
    vol.Optional('costSettings'):dict,
    vol.Optional('telegramSettings'):dict,
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
    if action in ('telegram_settings','telegram_settings_save'):
        from .telegram_commands import report_settings,save_report_settings
        entry=next((e for e in state['entries'].values() if e.data['deviceId']==device),None)
        try:
            if entry is None:raise ArchiveError('Unknown Power Monitor')
            result=save_report_settings(hass,state,entry,msg.get('telegramSettings')) if action=='telegram_settings_save' else report_settings(hass,state,entry)
            connection.send_result(msg['id'],result)
        except (ArchiveError,ValueError,TypeError):
            connection.send_error(msg['id'],'invalid_format','Check the Telegram bot, allowed chat and report settings')
        return
    if action=='analysis_settings':
        try:
            if 'costSettings' not in msg:raise ArchiveError('Price settings required')
            settings=resolved_cost_settings(msg.get('costSettings'),hass.config.time_zone)
            entry=next((e for e in state['entries'].values() if e.data['deviceId']==device),None)
            if entry is None: raise ArchiveError('unknown device')
            hass.config_entries.async_update_entry(entry,options={**entry.options,'costSettings':settings})
            with app.lock:
                for item in app.devices:
                    if item['deviceId']==device:item['costSettings']=settings
            connection.send_result(msg['id'],{'saved':True,'costSettings':settings})
        except (ArchiveError,ValueError,TypeError):
            connection.send_error(msg['id'],'invalid_format','Invalid price settings')
        return
    if action == "dashboard":
        path = msg.get("dashboardPath")
        if path != "power-monitor-" + device:
            connection.send_error(msg["id"], "invalid_format", "Device dashboard path required"); return
        entry = next((e for e in state["entries"].values() if e.data["deviceId"] == device), None)
        if entry is None:
            connection.send_error(msg["id"], "unknown_device", "Device is not configured"); return
        hass.config_entries.async_update_entry(entry, options={**entry.options, "dashboardPath": path})
        with app.lock:
            for item in app.devices:
                if item["deviceId"] == device:
                    item["dashboardPath"] = path
        panel = hass.data.get(ha_frontend.DATA_PANELS, {}).get(PANEL)
        if panel:
            ha_frontend.async_register_built_in_panel(hass, panel.component_name,
                frontend_url_path=PANEL, config=panel.config, require_admin=True,
                update=True, show_in_sidebar=False)
        connection.send_result(msg["id"], {"saved": True, "dashboardPath": path}); return
    if action == "resume":
        connection.send_result(msg["id"], {"accepted": True}); return
    if action == "current":
        connection.send_result(msg["id"], app.current(device)); return
    if action == "interface" and "url" not in msg:
        connection.send_error(msg["id"], "invalid_format", "Panel URL is required"); return
    if state["admitted_reads"] >= 4:
        connection.send_error(msg["id"], "busy", "Please retry shortly"); return
    state["admitted_reads"] += 1
    try:
        async with state["reads"]:
            if action == "coverage":
                result = await hass.async_add_executor_job(app.coverage, device)
            elif action == "interface":
                result = await hass.async_add_executor_job(app.set_interface, device, msg["url"])
            elif action=='analytics':
                result=await hass.async_add_executor_job(app.analytics,device,msg['start'],msg['end'],msg['maximum'],msg['slot'])
            else:
                result = await hass.async_add_executor_job(getattr(app, action), device,
                    msg["start"], msg["end"], msg["maximum"])
        connection.send_result(msg["id"], result)
    except (ArchiveError, OSError, ValueError, KeyError, sqlite3.Error):
        connection.send_error(msg["id"], "archive_unavailable", "Archive is temporarily unavailable")
    finally:
        state["admitted_reads"] -= 1


@websocket_api.websocket_command({
    vol.Required('type'): DOMAIN + '/device',
    vol.Required('device'): vol.All(str, vol.Match(r'^[0-9a-f]{12}$')),
    vol.Required('request'): {
        vol.Required('method'): vol.In(('GET', 'POST')),
        vol.Required('path'): vol.All(str, vol.Length(max=256)),
        vol.Optional('headers', default={}): dict,
        vol.Optional('body', default=''): vol.All(str, vol.Length(max=90000)),
    },
})
@websocket_api.async_response
async def websocket_device(hass, connection, msg):
    """The paired device is the only target; HA authorizes each request."""
    if not connection.user.is_admin:
        connection.send_error(msg['id'], 'unauthorized', 'Administrator access required'); return
    state = hass.data.get(DOMAIN)
    if not state or 'app' not in state:
        connection.send_error(msg['id'], 'not_ready', 'Integration is starting'); return
    if state.get('device_admitted', 0) >= 8:
        connection.send_error(msg['id'], 'busy', 'Device is busy'); return
    state['device_admitted'] = state.get('device_admitted', 0) + 1
    try:
        result = await hass.async_add_executor_job(state['app'].device_request, msg['device'], msg['request'])
        connection.send_result(msg['id'], result)
    except (ArchiveError, OSError, sqlite3.Error):
        connection.send_error(msg['id'], 'device_unavailable', 'Device response not confirmed')
    finally:
        state['device_admitted'] -= 1
