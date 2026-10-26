import {t,locale,setText,setMarkup,bindAttribute,setProfileLanguage,setLanguage,languagePreference,watchLanguage,refreshTranslations} from './i18n.js?v=1.0.236';
import {el,button,telegramSettingsPatch,errorText} from './control-ui.js?v=1.0.236';
import {RELAY_KEYS,TARIFF_GROUPS,SETTINGS_GROUPS,TELEGRAM_GROUPS,MQTT_FIELDS,pick} from './control-schema.js?v=1.0.236';
import {validateSettings,validateRelay,validateTariff,validateTelegram} from './control-validation.js?v=1.0.236';
const keys=groups=>groups.flatMap(([,fields])=>fields.map(f=>f.key));
const sections={relays:'Реле',tariff:'Ночной тариф',tg:'Telegram',ha:'MQTT',profile:'Профиль инвертора',wifi:'Сеть',forecast:'Прогноз PV',bms:'BMS',security:'Пароли доступа'};
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const sectionData=(src,key)=>src[key]!==undefined?src[key]:({tg:src.telegram,ha:src.homeAssistant,bms:src.other,security:src.other})[key];
function validateBackup(parsed){
  if(!object(parsed)||parsed.format!=='energy-node-backup'||![1,2,3,4,5].includes(parsed.version)||!object(parsed.sections))throw new Error(t('Формат резервной копии не поддерживается'));
  let count=0;
  for(const key of Object.keys(sections)){
    const data=sectionData(parsed.sections,key);if(data===undefined)continue;
    if(key==='relays'?!Array.isArray(data)||!data.length||data.length>4||data.some(r=>!object(r)):!object(data)||!Object.keys(data).length)throw new Error(t('Формат резервной копии не поддерживается'));
    count++;
  }
  if(!count)throw new Error(t('Формат резервной копии не поддерживается'));
}
const telegram=data=>({...pick(data,['enabled','language','dailyReportHour','weeklyReportDay','profiles','token']),...pick(data.notifications||data,['gridLost','gridRestored','lowBattery','fullBattery']),...pick(data.thresholds||data,['lowSoc','recoverySoc','fullSoc','fullResetSoc','fullEndCurrent','fullConfirmSeconds'])});
export async function exportSettings(api,selected=Object.keys(sections)){
  const full=await api.get('settings/full'),backup={format:'energy-node-backup',version:5,createdAt:new Date().toISOString(),sections:{}};
  for(const key of selected){
    if(key==='relays')backup.sections.relays=(await api.get('relays')).map(r=>pick(r,['slot',...RELAY_KEYS]));
    else if(key==='tariff')backup.sections.tariff=pick((await api.get('tariff')).settings,keys(TARIFF_GROUPS));
    else if(key==='tg'){backup.sections.tg=telegram(await api.get('telegram'));backup.sections.tg.token=full.telegramToken||''}
    else if(key==='ha')backup.sections.ha={...pick(await api.get('home-assistant/settings'),MQTT_FIELDS.map(f=>f.key)),password:full.mqttPassword||''};
    else if(key==='bms')backup.sections.bms=pick(full,['bmsMacAddress','bmsModel','bmsPassword','bmsSlots','bmsBankMode']);
    else{const scope={profile:'profile',wifi:'network',forecast:'forecast',security:'security'}[key];backup.sections[key]=pick(full,SETTINGS_GROUPS.find(g=>g[0]===scope)[2].map(f=>f.key));if(key==='wifi')backup.sections.wifi.deviceName=full.deviceName}
  }
  const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'})),a=el('a');a.href=url;a.download='power-monitor-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function exportDialog(card){card.modal(t('Резервная копия'),d=>{const selected=new Set(Object.keys(sections));d.append(card.notice(t('Файл содержит пароли. Храните его в безопасном месте.')));for(const [key,label]of Object.entries(sections))d.append(card.field({key,label,type:'switch'},{[key]:true},(k,on)=>on?selected.add(k):selected.delete(k)));const a=el('div','actions');a.append(button(()=>(t('Скачать')),()=>card.run('backup',async()=>{await exportSettings(card.api,[...selected]);d.close()},''),'button primary'));d.append(a)})}
export function importSettings(card){card.modal(t('Восстановить настройки'),d=>{
  const file=el('input','file');file.type='file';file.accept='.json';file.setAttribute('aria-label',t('Резервная копия'));const preview=el('div'),status=el('div','muted'),apply=button(()=>(t('Восстановить')),async()=>{
    if(!backup||!selected.size)return;apply.disabled=true;
    try{await card.act('restore',async()=>{
      const src=backup.sections,applied=[],plan=[],notices=[];let restart=false;
      const post=async(path,body,label)=>{try{const result=await card.api.post(path,body);restart ||=!!result.restartRequired;applied.push(label)}catch(error){throw new Error(errorText(error)+t('. Применено: ')+(applied.join(', ')||t('ничего')))}};
      const prepare=(path,body,label)=>{if(path==='settings')validateSettings(body);else if(path==='relays/settings')validateRelay(body);else if(path==='tariff/settings')validateTariff(body);else if(path==='telegram/settings')validateTelegram(body);if(Object.keys(body).length)plan.push({path,body,label})};
      // Validate every selected section before the first write. Firmware still
      // validates each save; a transport failure can leave earlier sections saved.
      // Network and access are last, and restart always remains a separate action.
      for(const key of ['tg','ha','tariff','relays','profile','forecast','bms','wifi','security']){
        if(!selected.has(key))continue;const data=src[key]||({tg:src.telegram,ha:src.homeAssistant,bms:src.other,security:src.other})[key];if(!data)continue;
        if(key==='tg')prepare('telegram/settings',telegramSettingsPatch(telegram(data)),'Telegram');
        else if(key==='ha')prepare('home-assistant/settings',pick(data,MQTT_FIELDS.map(f=>f.key)),'MQTT');
        else if(key==='tariff')prepare('tariff/settings',pick(data.settings||data,keys(TARIFF_GROUPS)),t('Тариф'));
        else if(key==='relays'){for(const r of data){if(!Number.isInteger(r.slot)||r.slot<0||r.slot>3)throw new Error(t('Неверный канал реле'));prepare('relays/settings',pick(r,['slot',...RELAY_KEYS]),t('Реле ')+(r.slot+1))}}
        else if(key==='bms')prepare('settings',pick(data,['bmsMacAddress','bmsModel','bmsPassword','bmsSlots','bmsBankMode']),'BMS');
        else{const scope={profile:'profile',wifi:'network',forecast:'forecast',security:'security'}[key],body=pick(data,[...SETTINGS_GROUPS.find(g=>g[0]===scope)[2].map(f=>f.key),...(key==='wifi'?['deviceName']:[])]);
          validateSettings(body);
          if(key==='wifi'){
            if(!body.wifiSSID){if('wifiPassword'in body)notices.push('Пароль Wi-Fi пропущен: в файле нет SSID');delete body.wifiPassword;delete body.wifiSSID}
            else if(!body.wifiPassword){
              const current=await card.api.get('settings');
              // Empty backup secrets never clear the active network password.
              // Open networks can be selected explicitly in network settings.
              delete body.wifiPassword;
              if(current.wifiSSID!==body.wifiSSID){delete body.wifiSSID;notices.push('SSID и пароль Wi-Fi пропущены: в файле нет пароля')}
              else if('wifiPassword'in data)notices.push('Пустой пароль Wi-Fi пропущен');
            }
          }
          prepare('settings',body,sections[key]);
        }
      }
      if(!plan.length&&!notices.length)throw new Error(t('Формат резервной копии не поддерживается'));
      for(const item of plan)await post(item.path,item.body,item.label);
      setText(status,()=>[!plan.length?t('Изменений нет'):restart?t('Восстановлено · нужен перезапуск'):t('Восстановлено'),...notices.map(n=>t(n))].join(' · '));card.data.settings=await card.api.get('settings');
      if(plan.length){for(const page of card.pages.values())delete page.dataset.ready;card.renderPage(card._page,true)}
    },'');}catch(_){setText(status,()=>t('Восстановление прервано. Проверьте применённые разделы'));apply.disabled=false}
  },'button primary');apply.disabled=true;let backup;const selected=new Set();
  file.onchange=async()=>{try{if(!file.files?.[0]||file.files[0].size>131072)throw new Error(t('Неверный размер файла'));const parsed=JSON.parse(await file.files[0].text());validateBackup(parsed);backup=parsed;preview.replaceChildren();selected.clear();for(const [key,label]of Object.entries(sections)){if(!sectionData(backup.sections,key))continue;selected.add(key);preview.append(card.field({key,label,type:'switch'},{[key]:true},(k,on)=>{if(on)selected.add(k);else selected.delete(k);apply.disabled=!selected.size}))}apply.disabled=false;setText(status,()=>'')}catch(error){backup=null;apply.disabled=true;preview.replaceChildren();selected.clear();card.notify(error,true)}};
  d.append(file,preview,card.notice(t('Настройки записываются по разделам. Перезапуск — отдельным действием.')),status);const a=el('div','actions');a.append(apply);d.append(a);
})}
