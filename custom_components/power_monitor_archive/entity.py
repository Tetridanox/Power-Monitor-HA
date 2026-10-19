"""Shared stable native identities; no MQTT registry migration."""
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from .const import DOMAIN

# Stable HA logical identity matches the earlier MQTT entity key; the wire
# serializer names the measurement explicitly with "energy".
SOURCE_KEYS = {"grid_import_today": "grid_import_energy_today"}


class PowerMonitorEntity(CoordinatorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator, entry, key, name):
        super().__init__(coordinator)
        self.key = key
        self._attr_unique_id = entry.data["deviceId"] + "_" + key
        self._attr_name = name
        self._attr_device_info = {"identifiers": {(DOMAIN, entry.data["deviceId"])}}

    @property
    def available(self):
        return bool(self.coordinator.data and self.coordinator.data.get("available") and self.value is not None)

    @property
    def value(self):
        value=(self.coordinator.data or {}).get("values", {}).get(SOURCE_KEYS.get(self.key,self.key))
        return None if self.key=="operating_mode" and value not in ("line","battery") else value
