/* Generated from assets/web/js/inverter_profiles.js; edit the firmware catalog. */
const window={};
/** Selectable inverter profiles; provisional entries are labeled explicitly. */
(function(global) {
    "use strict";

    global.InverterProfileCatalog = [
        {
            id: "auto",
            label: "Усі підтверджені виробники",
            models: [{
                id: "auto",
                label: "Усі підтверджені моделі",
                protocol: "auto",
                interfaceName: "auto",
                modbusAddress: 1
            }]
        },
        {
            id: "easun",
            label: "EASUN Power",
            models: [{
                id: "easun-smh3-cable",
                label: "SMH3 · кабель RS232 (PI30)",
                protocol: "pi30",
                interfaceName: "rs232",
                baudRate: 2400,
                modbusAddress: 1
            }, {
                id: "easun-smh3-rwb1",
                label: "SMH3 · Solar Plug-RWB1 (WiFi)",
                protocol: "solarv_smh3",
                interfaceName: "wifi",
                tcpPort: 58899,
                baudRate: 2400,
                modbusAddress: 5
            }]
        },
        {
            id: "anenji",
            label: "ANENJI",
            models: [{
                id: "anenji-anj4000-wifi",
                label: "ANJ-4000 · WiFi (LAN)",
                protocol: "modbus_smg",
                interfaceName: "wifi",
                tcpPort: 18899,
                baudRate: 9600,
                modbusAddress: 1
            }]
        },
        {
            // AN-SCI-EVO cable and RWB1 profiles are hardware-confirmed on the
            // same inverter. Both keep their explicit transport identity.
            id: "anern",
            label: "Anern",
            models: [{
                id: "anern-evo3200-cable",
                label: "AN-SCI-EVO-3200 · кабель RS232 (Modbus)",
                protocol: "modbus_anern",
                interfaceName: "rs232",
                baudRate: 2400,
                modbusAddress: 5
            }, {
                id: "anern-evo3200-rwb1",
                label: "AN-SCI-EVO-3200 · Solar Plug-RWB1 (WiFi)",
                protocol: "solarv_anern",
                interfaceName: "wifi",
                tcpPort: 58899,
                baudRate: 2400,
                modbusAddress: 5
            }]
        },
        {
            id: "growatt",
            label: "Growatt",
            models: [{
                id: "growatt-spf6000-es-plus-rs485",
                label: "SPF 6000 ES Plus · RS485 expansion (лише читання; кандидат)",
                protocol: "modbus_growatt_spf",
                interfaceName: "rs485",
                baudRate: 9600,
                modbusAddress: 1
            }, {
                id: "growatt-spf6000-es-plus-shinewifi",
                label: "SPF 6000 ES Plus · ShineWiFi-F/F Pro (локально; лише читання; кандидат)",
                protocol: "shinewifi_growatt_spf",
                interfaceName: "wifi_tcp",
                tcpPort: 5279,
                baudRate: 9600,
                modbusAddress: 1
            }]
        },
        {
            id: "must",
            label: "MUST Power",
            models: [{
                id: "must-pv18-3524-cable",
                label: "PV18-3524 ECO · кабель RS485 (protocol 1.4.15)",
                protocol: "modbus_must",
                interfaceName: "rs485",
                baudRate: 19200,
                modbusAddress: 4
            }]
        }
    ];
})(window);

export default window.InverterProfileCatalog;
