"""Explicit append-only export into a separate HA statistics namespace."""
import asyncio
import math
import time

import voluptuous as vol
from homeassistant.core import SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.storage import Store

from .const import DOMAIN
from .pm_archive.runtime import pairing_signature
from .pm_archive.energy_export import ENERGY_FIELDS, daily_export, external_rows, export_cutoff

def register_energy_statistics(hass,state):
    lock=asyncio.Lock()
    storage=Store(hass,1,DOMAIN+'.energy_exports')
    async def handle(call):
        if call.context.user_id:
            user=await hass.auth.async_get_user(call.context.user_id)
            if not user or not user.is_admin:raise HomeAssistantError('Administrator access required')
        if lock.locked():raise HomeAssistantError('An energy statistics export is in progress')
        if 'recorder' not in hass.config.components:raise HomeAssistantError('The HA Recorder integration is required')
        if not call.data['dry_run'] and call.data.get('confirmation')!='IMPORT_DAILY_ARCHIVE':
            raise HomeAssistantError('Preview first, then confirm IMPORT_DAILY_ARCHIVE')
        from homeassistant.components.recorder import get_instance
        from homeassistant.components.recorder.models import StatisticMeanType
        from homeassistant.components.recorder.statistics import async_add_external_statistics,get_last_statistics
        app=state['app'];device=call.data['device']
        with app.lock:
            paired=next((dict(d) for d in app.devices if d['deviceId']==device),None)
        if not paired:raise HomeAssistantError('Unknown Power Monitor')
        def guard():
            with app.lock:app._require_binding(device,pairing_signature(paired),'liveRead')
        async with lock:
            guard()
            saved=await storage.async_load() or {'cutoffs':{}}
            if not isinstance(saved,dict) or not isinstance(saved.get('cutoffs'),dict):
                raise HomeAssistantError('Invalid saved energy export boundaries')
            key=device+'_'+paired['generation']
            try:before=export_cutoff(saved['cutoffs'].get(key),call.data.get('before'))
            except ValueError as error:raise HomeAssistantError(str(error)) from error
            if before is not None and before>time.time():
                raise HomeAssistantError('The archive cutoff must not be in the future')
            days=await hass.async_add_executor_job(daily_export,app.database,device,paired['generation'],before)
            guard();plans=[]
            for field in ENERGY_FIELDS:
                statistic_id=f'{DOMAIN}:{device}_{paired["generation"]}_{field}_daily'
                last_data=await hass.async_add_executor_job(get_last_statistics,hass,1,statistic_id,False,{'sum'})
                last=(last_data.get(statistic_id)or[None])[0]
                if before is not None and last and last['start']>=before:
                    raise HomeAssistantError('Existing archive statistics cross the requested cutoff; no data were changed')
                rows=external_rows(days,field,last)
                plans.append({'id':statistic_id,'field':field,'rows':rows})
            if not call.data['dry_run']:
                if before is not None and key not in saved['cutoffs']:
                    guard()
                    saved['cutoffs'][key]=before
                    # Persist intent before Recorder writes. A later partial
                    # failure/retry must keep the same non-overlapping prefix.
                    await storage.async_save(saved)
                for plan in plans:
                    guard()
                    if not plan['rows']:continue
                    async_add_external_statistics(hass,{'statistic_id':plan['id'],'source':DOMAIN,
                        'name':f'Power Monitor {device} · {plan["field"]} · daily archive',
                        'unit_of_measurement':'kWh','unit_class':'energy',
                        'has_sum':True,'mean_type':StatisticMeanType.NONE},plan['rows'])
                # Queued is not committed. Wait for Recorder and independently
                # read the last point before claiming a completed import.
                await get_instance(hass).async_block_till_done()
                for plan in plans:
                    guard()
                    if not plan['rows']:continue
                    actual=await hass.async_add_executor_job(get_last_statistics,hass,1,plan['id'],False,{'sum'})
                    last=(actual.get(plan['id'])or[{}])[0]
                    if last.get('start')!=plan['rows'][-1]['start'].timestamp() or not math.isclose(last.get('sum',-1),plan['rows'][-1]['sum'],abs_tol=1e-6):
                        raise HomeAssistantError('Statistics commit was not confirmed; refresh before retrying')
            return {'dry_run':call.data['dry_run'],'completed':not call.data['dry_run'],
                'before':before,
                'statistics':[{'id':p['id'],'newPoints':len(p['rows'])}for p in plans],
                'dailyRecords':len(days),
                'notice':'Daily totals are placed in one hourly bucket at the recorded day start; this does not reconstruct hourly consumption. Select either these archive series or overlapping live energy sensors, never both for the same flow. Imported prefixes are not rewritten.'}
    hass.services.async_register(DOMAIN,'export_energy_statistics',handle,
        schema=vol.Schema({vol.Required('device'):vol.All(str,vol.Match(r'^[0-9a-f]{12}$')),
            vol.Optional('dry_run',default=True):bool,vol.Optional('confirmation'):str,
            vol.Optional('before'):vol.All(int,vol.Range(min=1700000000))}),
        supports_response=SupportsResponse.OPTIONAL)
