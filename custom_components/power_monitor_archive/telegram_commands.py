"""HA-owned read-only command receiver; no ESP polling or generated YAML."""
import asyncio
import logging
import time

from homeassistant.core import callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_track_state_change_event

from .const import DOMAIN
from .pm_archive.reports import command_settings,command_report
from .pm_archive.runtime import pairing_signature
from .pm_archive.store import ArchiveError

LOGGER=logging.getLogger(__name__)


def bot_choices(hass):
    registry=er.async_get(hass)
    result=[]
    for bot in hass.config_entries.async_entries('telegram_bot'):
        event=next((e.entity_id for e in er.async_entries_for_config_entry(registry,bot.entry_id)
                    if e.entity_id.startswith('event.') and not e.disabled_by),None)
        chats=[{'id':sub.data['chat_id'],'name':sub.title} for sub in bot.subentries.values()
               if sub.subentry_type=='allowed_chat_ids' and type(sub.data.get('chat_id')) is int]
        if bot.data.get('platform') not in ('polling','webhooks'):continue
        result.append({'id':bot.entry_id,'name':bot.title,'loaded':bot.state.value=='loaded',
                       'event':event,'chats':chats})
    return result


def stop_receiver(state,device):
    receiver=state.setdefault('telegram_receivers',{}).pop(device,None)
    if receiver:
        receiver['unsubscribe']()
        task=receiver.get('task')
        if task and not task.done():task.cancel()


def refresh_receiver(hass,state,entry):
    device=entry.data['deviceId'];stop_receiver(state,device)
    settings=command_settings(entry.options.get('telegramCommands'))
    if not settings['enabled']:return
    # Registry entries survive startup ordering; event state may arrive later.
    bot=next((b for b in bot_choices(hass) if b['id']==settings['telegramEntry']),None)
    if not bot or not bot['event'] or settings['chatId'] not in {c['id'] for c in bot['chats']}:return
    receiver={'task':None,'nextAt':0.0,'unsubscribe':lambda:None}
    state.setdefault('telegram_receivers',{})[device]=receiver
    signature=pairing_signature(entry.data)

    @callback
    def received(event):
        new=event.data.get('new_state');old=event.data.get('old_state')
        if new is None or old is None or new.state==old.state:return
        if state['telegram_receivers'].get(device) is not receiver:return
        if receiver['task'] and not receiver['task'].done() or time.monotonic()<receiver['nextAt']:return
        bot_entry=hass.config_entries.async_get_entry(settings['telegramEntry'])
        if not bot_entry or bot_entry.state.value!='loaded' or settings['chatId'] not in {s.data.get('chat_id') for s in bot_entry.subentries.values() if s.subentry_type=='allowed_chat_ids'}:return
        runtime=getattr(bot_entry,'runtime_data',None)
        username=getattr(getattr(runtime,'bot',None),'username','')
        report=command_report(dict(new.attributes),settings,username)
        if not report:return

        async def respond():
            try:
                if state['telegram_receivers'].get(device) is not receiver:return
                with state['app'].lock:state['app']._require_binding(device,signature,'liveRead')
                await hass.services.async_call(DOMAIN,report,{'device':device,
                    'telegram_entry':settings['telegramEntry'],'chat_id':settings['chatId'],
                    'language':settings['language'],'hours':settings['hours']},blocking=True,context=event.context)
            except asyncio.CancelledError:raise
            except Exception as error:
                LOGGER.warning('Power Monitor Telegram report failed: %s',type(error).__name__)
            finally:receiver['nextAt']=time.monotonic()+5
        receiver['task']=hass.async_create_task(respond(),'Power Monitor Telegram report')
    receiver['unsubscribe']=async_track_state_change_event(hass,[bot['event']],received)


def report_settings(hass,state,entry):
    return {'settings':command_settings(entry.options.get('telegramCommands')),'bots':bot_choices(hass),
            'listening':entry.data['deviceId'] in state.get('telegram_receivers',{})}


def save_report_settings(hass,state,entry,value):
    try:settings=command_settings(value)
    except ValueError as error:raise ArchiveError(str(error)) from error
    device=entry.data['deviceId']
    if settings['enabled']:
        with state['app'].lock:state['app']._require_binding(device,pairing_signature(entry.data),'liveRead')
        bot=next((b for b in bot_choices(hass) if b['id']==settings['telegramEntry']),None)
        if not bot or not bot['loaded'] or not bot['event']:raise ArchiveError('Select an available HA Telegram bot')
        if settings['chatId'] not in {c['id'] for c in bot['chats']}:raise ArchiveError('Select an allowed HA Telegram chat')
        for other in state['entries'].values():
            old=command_settings(other.options.get('telegramCommands'))
            if other.entry_id!=entry.entry_id and old['enabled'] and old['telegramEntry']==settings['telegramEntry'] and old['chatId']==settings['chatId']:
                raise ArchiveError('Another Power Monitor already handles commands for this chat')
    hass.config_entries.async_update_entry(entry,options={**entry.options,'telegramCommands':settings})
    refresh_receiver(hass,state,entry)
    return report_settings(hass,state,entry)
