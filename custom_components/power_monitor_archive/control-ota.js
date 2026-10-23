import {t,locale,setText,setMarkup,bindAttribute,setProfileLanguage,setLanguage,languagePreference,watchLanguage,refreshTranslations} from './i18n.js?v=1.0.226';
/* Ticketed OTA protocol, with read-only reconciliation after an ambiguous POST. */
import {wait} from './control-api.js?v=1.0.226';
// esp_image_header_t (24) + first segment header (8) + esp_app_desc_t (256).
// This is a metadata preview, not a replacement for ESP's image validation.
export async function softwareImageVersion(file){
  if(!file||file.size<1024||file.size>0x300000)throw new Error(t('Неверный размер образа'));
  const bytes=new Uint8Array(await file.slice(0,288).arrayBuffer());
  if(bytes.length!==288||bytes[0]!==0xe9)throw new Error(t('Это не образ ESP'));
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(view.getUint32(28,true)<256||view.getUint32(28,true)>file.size-32||view.getUint32(32,true)!==0xabcd5432)return null;
  const version=bytes.subarray(48,80),end=version.indexOf(0);
  if(end<1||!version.subarray(0,end).every(c=>c>=32&&c<=126))return null;
  return new TextDecoder().decode(version.subarray(0,end)).trim()||null;
}
export async function updateFirmware(api,file,progress){
  const expectedVersion=await softwareImageVersion(file);
  if(!expectedVersion)throw new Error(t('Не удалось определить версию образа'));
  const headers={'X-PM-OTA':'1'};let upload,committed=false,confirmed=0,received=0;const started=Date.now();
  const report=(pct,message,stage='upload')=>progress(pct,message,{received,total:file.size,elapsedMs:Date.now()-started,stage});
  const status=async()=>{const value=await api.get('update/session/status');if(String(value.upload)!==String(upload))throw new Error(t('Сессия OTA изменилась'));return value};
  const consume=async(ticket,state,received)=>{
    if(!ticket)throw new Error(t('Нет номера операции OTA'));
    const deadline=Date.now()+18000;
    while(Date.now()<deadline){try{const result=await api.get('update/session/result',{'X-OTA-Ticket':String(ticket)});if(String(result.upload)!==String(upload))throw new Error(t('Ответ другой сессии OTA'));if(result.result!==0)throw new Error(t('ESP отклонила операцию OTA'));return result}catch(error){if(error.status!==404&&!['device_unavailable','device_busy'].includes(error.code))throw error}await wait(100)}
    const value=await status();if((value.state===state||state==='committed'&&value.state==='reboot_pending')&&value.received===received&&(!value.commandTicket||value.commandTicket==='0'))return {result:0,...value};
    throw new Error(t('Результат OTA не подтверждён'));
  };
  try{
    const before=await api.get('archive');
    if(!/^[a-f0-9]{16}$/.test(before.bootEpoch||'')||!/^[a-f0-9]{12}$/.test(before.deviceId||'')||!/^[a-f0-9]{32}$/.test(before.generation||''))throw new Error(t('Не удалось проверить перезапуск'));
    report(0,t('Подготовка…'),'prepare');const begin=await api.post('update/session',undefined,{...headers,'X-OTA-Size':String(file.size)});upload=begin.ticket;
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
      offset+=chunk.length;received=offset;confirmed=Math.floor(offset*100/file.size);report(confirmed,`${t("Передано ")}${confirmed}%`);
    }
    report(100,t('Проверка образа…'),'validate');
    try{const finish=await api.post('update/session/finish',undefined,{...headers,'X-OTA-Upload':String(upload)});await consume(finish.ticket,'committed',file.size)}
    catch(error){const current=await status();if(current.commandTicket&&current.commandTicket!=='0')await consume(current.commandTicket,'committed',file.size);else if(!['committed','reboot_pending'].includes(current.state))throw error}
    const final=await status();if(!['committed','reboot_pending'].includes(final.state)||final.received!==file.size)throw new Error(t('Установка образа не подтверждена'));committed=true;
    report(100,t('Перезапуск ESP…'),'restart');try{await api.post('system/restart',{})}catch(_){}
    const bootDeadline=Date.now()+60000;let epoch,healthDeadline;
    while(Date.now()<(healthDeadline||bootDeadline)){
      await wait(1500);
      let current,manifest;
      try{manifest=await api.get('archive');current=await api.get('system')}catch(_){continue}
      if(manifest.deviceId!==before.deviceId||manifest.generation!==before.generation)throw new Error(t('Привязка устройства изменилась'));
      if(!/^[a-f0-9]{16}$/.test(manifest.bootEpoch||'')||manifest.bootEpoch===before.bootEpoch)continue;
      if(epoch&&epoch!==manifest.bootEpoch)throw new Error(t('ESP повторно перезапустилась при проверке'));
      if(!epoch){epoch=manifest.bootEpoch;healthDeadline=Date.now()+420000}
      if(current.firmwareVersion!==expectedVersion)throw new Error(t('Версия после перезапуска не совпала с образом'));
      report(100,t('Проверка стабильной загрузки ESP…'),'health');
      const health=current.otaHealth,owners=current.ownerProgress;
      if(health?.partitionState==='valid'&&health.pending===false&&health.blockingMask===0&&
          Number.isFinite(health.requiredHealthyMs)&&health.requiredHealthyMs>=60000&&
          Number.isFinite(health.healthyForMs)&&health.healthyForMs>=health.requiredHealthyMs&&
          owners?.missingMask===0&&owners.recoveryMask===0){
        report(100,t('Версия и стабильная загрузка подтверждены'),'complete');return;
      }
    }
    throw new Error(epoch?t('Стабильная загрузка ESP не подтверждена'):t('Образ записан, перезапуск не подтверждён'));
  }catch(error){report(confirmed,committed?t('Образ записан. ')+error.message:error.message,'error');if(!committed&&upload)try{await api.post('update/session/cancel',undefined,{...headers,'X-OTA-Upload':String(upload)})}catch(_){}throw error}
}
