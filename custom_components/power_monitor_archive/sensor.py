"""Native read-only inverter/battery/energy sensors."""
from homeassistant.components.sensor import SensorEntity, SensorDeviceClass, SensorStateClass
from .const import DOMAIN
from .entity import PowerMonitorEntity


def definitions():
    items = []
    def add(key, name, unit, kind): items.append((key, name, unit, kind))
    for key, name in (("grid_power","Из сети"),("load_power","Потребление"),("pv_power","Солнечная генерация"),("battery_power","Мощность батареи")):
        add(key,name,"W","power")
    for key,name in (("grid_voltage","Напряжение сети"),("output_voltage","Выходное напряжение"),("pv_voltage","Напряжение PV"),("battery_voltage","Напряжение батареи")):
        add(key,name,"V","voltage")
    for key,name in (("grid_frequency","Частота сети"),("output_frequency","Выходная частота")): add(key,name,"Hz","frequency")
    for key,name in (("pv_current","Ток PV"),("battery_current","Ток батареи")):add(key,name,"A","current")
    for key,name in (("inverter_temperature","Температура инвертора"),("bms_temperature_1","BMS 1 · Температура 1"),("bms_temperature_2","BMS 1 · Температура 2"),("mosfet_temperature","BMS 1 · Температура MOSFET")):
        add(key,name,"°C","temperature")
    for key,name in (("battery_soc","Заряд батареи"),("load_percent","Загрузка инвертора"),("bms_soh","Состояние батареи"),("autonomy_today","Автономность сегодня")):add(key,name,"%",None)
    for key,name in (("pv_energy_today","Солнечная энергия сегодня"),("grid_import_today","Из сети сегодня"),("load_energy_today","Потребление сегодня"),("battery_charge_energy_today","Заряд батареи сегодня"),("battery_discharge_energy_today","Разряд батареи сегодня")):
        add(key,name,"kWh","energy")
    add("remaining_capacity","Оставшаяся ёмкость","Ah",None)
    add("remaining_energy","Оставшаяся энергия банка","kWh","energy")
    add("cell_delta","Разница напряжений ячеек","V","voltage")
    add("cycle_count","Циклы батареи",None,None)
    add("wifi_rssi","Уровень Wi-Fi","dBm","signal_strength")
    add("uptime","Время работы","s","duration")
    for key,name,unit,kind in (("bms1_cell_delta","BMS 1 · Разница ячеек","V","voltage"),
            ("cell_min_voltage","BMS 1 · Минимальное напряжение ячейки","V","voltage"),
            ("cell_max_voltage","BMS 1 · Максимальное напряжение ячейки","V","voltage"),
            ("bms_balance_current","BMS 1 · Ток балансировки","A","current"),
            ("bms2_remaining_capacity","BMS 2 · Оставшаяся ёмкость","Ah",None),
            ("bms2_cell_min_voltage","BMS 2 · Минимальное напряжение ячейки","V","voltage"),
            ("bms2_cell_max_voltage","BMS 2 · Максимальное напряжение ячейки","V","voltage"),
            ("bms2_cycle_count","BMS 2 · Циклы батареи",None,None),
            ("bms2_soh","BMS 2 · Состояние батареи","%",None),
            ("bms2_balance_current","BMS 2 · Ток балансировки","A","current")):
        add(key,name,unit,kind)
    add("operating_mode","Режим инвертора",None,None)
    for slot in (1,2):
        prefix="" if slot==1 else "bms2_"
        for cell in range(1,33):
            add(prefix+f"cell_voltage_{cell}",f"BMS {slot} · Ячейка {cell}","V","voltage")
            add(prefix+f"cell_resistance_{cell}",f"BMS {slot} · Сопротивление ячейки {cell}","mΩ",None)
    for key,name,unit,kind in (("soc","Заряд","%",None),("voltage","Напряжение","V","voltage"),("current","Ток","A","current"),("power","Мощность","W","power"),
            ("temperature_1","Температура 1","°C","temperature"),("temperature_2","Температура 2","°C","temperature"),("mosfet_temperature","Температура MOSFET","°C","temperature"),("cell_delta","Разница ячеек","V","voltage")):
        add("bms2_"+key,"BMS 2 · "+name,unit,kind)
    return items


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator=hass.data[DOMAIN]["coordinators"][entry.entry_id]
    async_add_entities([PowerMonitorSensor(coordinator,entry,*item) for item in definitions()])


class PowerMonitorSensor(PowerMonitorEntity, SensorEntity):
    def __init__(self, coordinator, entry, key, name, unit, kind):
        super().__init__(coordinator,entry,key,name)
        self._attr_native_unit_of_measurement=unit
        if kind:self._attr_device_class=SensorDeviceClass(kind)
        self._attr_state_class=SensorStateClass.TOTAL_INCREASING if kind=="energy" else SensorStateClass.MEASUREMENT if unit and kind!="duration" else None
        if key == 'remaining_energy':
            self._attr_state_class = SensorStateClass.MEASUREMENT
            self._attr_suggested_display_precision = 2
        if "resistance" in key:self._attr_entity_registry_enabled_default=False

    @property
    def native_value(self):
        value=self.value
        if self.key=="operating_mode":return value if value in ("line","battery") else None
        return value if isinstance(value,(int,float)) and not isinstance(value,bool) else None
