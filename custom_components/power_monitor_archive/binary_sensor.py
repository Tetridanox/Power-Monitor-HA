"""Read-only connectivity and relay states; pairing grants no control."""
from homeassistant.components.binary_sensor import BinarySensorEntity, BinarySensorDeviceClass
from .const import DOMAIN
from .entity import PowerMonitorEntity


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator=hass.data[DOMAIN]["coordinators"][entry.entry_id]
    items=[("inverter_available","Связь с инвертором","connectivity"),("bms_available","Связь с BMS","connectivity"),
           ("grid_present","Сеть присутствует","power"),("bms1_available","Связь с BMS 1","connectivity"),
           ("bms2_available","Связь с BMS 2","connectivity"),("balancing","Балансировка батареи",None)]
    items += [(f"relay_{i}_state",f"Реле {i}","power") for i in range(1,5)]
    items += [(f"smart_plug_{i}_{key}",f"Розетка {i} · {name}",kind) for i in range(1,5)
              for key,name,kind in (("connection","Связь","connectivity"),("relay","Реле","power"))]
    async_add_entities([PowerMonitorBinary(coordinator,entry,*item) for item in items])


class PowerMonitorBinary(PowerMonitorEntity, BinarySensorEntity):
    def __init__(self, coordinator, entry, key, name, kind):
        super().__init__(coordinator,entry,key,name)
        if kind:self._attr_device_class=BinarySensorDeviceClass(kind)

    @property
    def is_on(self):
        return self.value if isinstance(self.value,bool) else None
