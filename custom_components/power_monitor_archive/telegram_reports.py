"""Explicit HA actions; ESP bot polling stays disabled."""
import asyncio
import math
import time

import voluptuous as vol
from homeassistant.exceptions import HomeAssistantError

from .const import DOMAIN
from .pm_archive.reports import status_text, generation_png
from .pm_archive.runtime import pairing_signature


def register_reports(hass,state):
    lock=asyncio.Lock()
    async def handle(call):
        if call.context.user_id:
            user=await hass.auth.async_get_user(call.context.user_id)
            if not user or not user.is_admin:raise HomeAssistantError('Administrator access required')
        device=call.data['device']
        app=state['app']
        with app.lock:
            paired=next((dict(d) for d in app.devices if d['deviceId']==device),None)
        if not paired:raise HomeAssistantError('Unknown Power Monitor')
        def guard():
            with app.lock:app._require_binding(device,pairing_signature(paired),'liveRead')
        if lock.locked():raise HomeAssistantError('A Power Monitor report is in progress')
        def allowed_bot():
            bot=hass.config_entries.async_get_entry(call.data['telegram_entry'])
            if not bot or bot.domain!='telegram_bot' or bot.state.value!='loaded':
                raise HomeAssistantError('Select an available HA Telegram bot')
            if call.data['chat_id'] not in {s.data.get('chat_id') for s in bot.subentries.values() if s.subentry_type=='allowed_chat_ids'}:
                raise HomeAssistantError('Select an allowed HA Telegram chat')
            return bot
        bot=allowed_bot()
        destination={'config_entry_id':bot.entry_id,'chat_id':call.data['chat_id'],'parse_mode':'plain_text'}
        async with lock:
            guard()
            if call.service=='telegram_status':
                message=status_text(app.current(device),call.data['language'])
                guard()
                await hass.services.async_call('telegram_bot','send_message',
                    {**destination,'message':message},blocking=True,context=call.context)
                return
            end=int(time.time());start=end-call.data['hours']*3600
            zone=hass.config.time_zone
            def prepare():
                points=app.history(device,start,end,1000)['points']
                if not any(isinstance(p.get('pvPower'),(int,float)) and not isinstance(p['pvPower'],bool)
                           and math.isfinite(p['pvPower']) and p['pvPower']>=0 for p in points):
                    raise HomeAssistantError('No measured PV history for this range')
                return generation_png(points,start,end,zone)
            photo=await hass.async_add_executor_job(prepare)
            guard();bot=allowed_bot()
            # Reuse HA's configured client with bytes, so no global file access
            # or temporary files are needed. Never retry an ambiguous send.
            from telegram import InputFile
            from telegram.error import TelegramError
            label={'ru':'Солнечная генерация','uk':'Сонячна генерація','en':'Solar generation'}[call.data['language']]
            try:
                await bot.runtime_data.bot.send_photo(chat_id=call.data['chat_id'],
                    photo=InputFile(photo,filename='power-monitor-pv.png'),
                    caption=f'Power Monitor · {label} · {call.data["hours"]} h · {zone}',parse_mode=None)
            except TelegramError:
                # SDK exceptions can contain a request URL with the bot token.
                raise HomeAssistantError('Telegram could not confirm photo delivery') from None
    schema=vol.Schema({vol.Required('device'):vol.All(str,vol.Match(r'^[0-9a-f]{12}$')),
        vol.Required('telegram_entry'):str,vol.Required('chat_id'):vol.All(vol.Coerce(int)),
        vol.Optional('language',default='ru'):vol.In(('ru','uk','en')),
        vol.Optional('hours',default=24):vol.All(int,vol.Range(min=1,max=168))})
    for service in ('telegram_status','telegram_generation_graph'):
        hass.services.async_register(DOMAIN,service,handle,schema=schema)
