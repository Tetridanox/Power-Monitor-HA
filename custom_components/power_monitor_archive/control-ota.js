import {t,locale,setText,setMarkup,bindAttribute,setProfileLanguage,setLanguage,languagePreference,watchLanguage,refreshTranslations} from './i18n.js?v=1.0.207';
/* Ticketed OTA protocol, with read-only reconciliation after an ambiguous POST. */
import {wait} from './control-api.js?v=1.0.207';
export async function updateFirmware(api,file,progress){
  if(!file||file.size<1024||file.size>0x300000)throw new Error(t('Неверный размер образа'));
  if(new Uint8Array(await file.slice(0,1).arrayBuffer())[0]!==0xe9)throw new Error(t('Это не образ ESP'));
  const headers={'X-PM-OTA':'1'};let upload,committed=false,confirmed=0;
  const status=async()=>{const value=await api.get('update/session/status');if(String(value.upload)!==String(upload))throw new Error(t('Сессия OTA изменилась'));return value};
  const consume=async(ticket,state,received)=>{
    if(!ticket)throw new Error(t('Нет номера операции OTA'));
    const deadline=Date.now()+18000;
    while(Date.now()<deadline){try{const result=await api.get('update/session/result',{'X-OTA-Ticket':String(ticket)});if(String(result.upload)!==String(upload))throw new Error(t('Ответ другой сессии OTA'));if(result.result!==0)throw new Error(t('ESP отклонила операцию OTA'));return result}catch(error){if(error.status!==404&&!['device_unavailable','device_busy'].includes(error.code))throw error}await wait(100)}
    const value=await status();if((value.state===state||state==='committed'&&value.state==='reboot_pending')&&value.received===received&&(!value.commandTicket||value.commandTicket==='0'))return {result:0,...value};
    throw new Error(t('Результат OTA не подтверждён'));
  };
  try{
    progress(0,t('Подготовка…'));const begin=await api.post('update/session',undefined,{...headers,'X-OTA-Size':String(file.size)});upload=begin.ticket;
    const initial=await consume(upload,'receiving',0);if(initial.state!=='receiving')throw new Error(t('ESP не начала приём'));
    for(let offset=0;offset<file.size;){
      const chunk=new Uint8Array(await file.slice(offset,offset+4096).arrayBuffer());let complete;
      try{const accepted=await api.post('update/session/data',chunk,{...headers,'Content-Type':'application/octet-stream','X-OTA-Upload':String(upload),'X-OTA-Offset':String(offset)});complete=await consume(accepted.ticket,'receiving',offset+chunk.length)}
      catch(error){
        // Never resend merely because a response was lost. Consume any pending
        // ticket, then continue only if the same upload proves these exact bytes.
        const current=await status();if(current.commandTicket&&current.commandTicket!=='0')complete=await consume(current.commandTicket,'receiving',offset+chunk.length);
        else if(current.state==='receiving'&&current.received===offset+chunk.length)complete={result:0,...current};
        else throw error;
      }
      if(complete.state!=='receiving'||complete.received!==offset+chunk.length)throw new Error(t('Смещение записи OTA не совпало'));
      offset+=chunk.length;confirmed=Math.floor(offset*100/file.size);progress(confirmed,`${t("Передано ")}${confirmed}%`);
    }
    progress(100,t('Проверка образа…'));
    try{const finish=await api.post('update/session/finish',undefined,{...headers,'X-OTA-Upload':String(upload)});await consume(finish.ticket,'committed',file.size)}
    catch(error){const current=await status();if(current.commandTicket&&current.commandTicket!=='0')await consume(current.commandTicket,'committed',file.size);else if(!['committed','reboot_pending'].includes(current.state))throw error}
    const final=await status();if(!['committed','reboot_pending'].includes(final.state)||final.received!==file.size)throw new Error(t('Установка образа не подтверждена'));committed=true;
    const before=await api.get('system/summary');if(!Number.isFinite(before.uptimeSeconds))throw new Error(t('Не удалось проверить перезапуск'));
    progress(100,t('Перезапуск ESP…'));try{await api.post('system/restart',{})}catch(_){}
    const deadline=Date.now()+60000;let restarted=false;
    while(Date.now()<deadline){await wait(1500);try{const current=await api.get('system/summary');if(Number.isFinite(current.uptimeSeconds)&&current.uptimeSeconds<before.uptimeSeconds){restarted=true;break}}catch(_){}}
    if(!restarted)throw new Error(t('Образ записан, перезапуск не подтверждён'));
    progress(100,t('ESP перезапущена · проверка загрузки'));
  }catch(error){progress(confirmed,committed?t('Образ записан. ')+error.message:error.message);if(!committed&&upload)try{await api.post('update/session/cancel',undefined,{...headers,'X-OTA-Upload':String(upload)})}catch(_){}throw error}
}
