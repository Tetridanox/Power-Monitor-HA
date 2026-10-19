"""HA observes the single owner's cache; entities never poll the ESP."""
from datetime import timedelta
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator


class PowerMonitorCoordinator(DataUpdateCoordinator):
    def __init__(self, hass, app, device):
        super().__init__(hass, __import__("logging").getLogger(__name__), name="Power Monitor current readings",
                         update_interval=timedelta(seconds=1), always_update=False)
        self.app, self.device = app, device

    async def _async_update_data(self):
        return self.app.current(self.device)
