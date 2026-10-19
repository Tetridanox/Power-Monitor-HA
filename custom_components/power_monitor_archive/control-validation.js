/* UI validation mirrors firmware bounds; server validation remains authoritative. */
import {t} from './i18n.js?v=1.0.207';
const fail=message=>{throw new Error(t(message))};
const bytes=value=>new TextEncoder().encode(String(value??'')).length;
export function validateUtf8(value,limit){if(bytes(value)>limit)fail('Текст превышает допустимую длину')}
export function validateProfiles(profiles){
 if(!Array.isArray(profiles)||profiles.length>10)fail('Можно добавить до 10 получателей');
 const ids=new Set();
 for(const profile of profiles){
  if(!String(profile.name||'').trim()||/[|\x00-\x1f]/.test(profile.name))fail('Укажите имя получателя без служебных символов');
  validateUtf8(profile.name,32);
  if(!/^-?\d{1,23}$/.test(profile.chatId||'')||String(profile.chatId).length>23)fail('ID чата должен содержать цифры и необязательный минус');
  if(ids.has(profile.chatId))fail('Этот ID чата уже добавлен');ids.add(profile.chatId);
  if(!Number.isInteger(profile.permissions)||profile.permissions<0||profile.permissions>16383)fail('Проверьте настройки получателя');
 }
}
export function validateSettings(patch){
 for(const [key,value]of Object.entries(patch)){
  if(typeof value==='number'&&!Number.isFinite(value))fail('Проверьте числовые поля');
  if(['deviceName','wifiSSID'].includes(key))validateUtf8(value,32);
  if(key==='wifiPassword'&&value!==''&&(bytes(value)<8||bytes(value)>63))fail('Пароль Wi-Fi должен содержать от 8 до 63 байт');
  if(key==='adminPassword'&&value!==''&&(bytes(value)<8||bytes(value)>64))fail('Пароль должен содержать от 8 до 64 байт');
  if(key==='accessPointPassword'&&value!==''&&(bytes(value)<8||bytes(value)>63))fail('Пароль Wi-Fi должен содержать от 8 до 63 байт');
  if(['forecastApiUrl','forecastServerUrl'].includes(key)&&value){try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.hash||/\s/.test(value))throw Error()}catch{fail('Адрес должен начинаться с http:// или https://')}}
 }
}
export function validateRelay(value){
 validateUtf8(value.name,32);
 if(value.minSoc>0&&value.stopSoc>value.minSoc)fail('Порог отключения не должен превышать порог включения');
}
export function validateTariff(value){
 if(value.nightStartMinutes===value.nightEndMinutes)fail('Начало и окончание должны различаться');
 if(value.nightStartSoc>=value.nightStopSoc||value.dayEmergencySoc>=value.dayRecoverySoc)fail('Порог восстановления должен быть выше порога включения');
 if(value.solarBypassEnabled&&(value.minimumPvPower<=0||value.minimumChargeCurrent<=0))fail('Для солнечного режима задайте положительные пороги мощности и тока');
}
export function validateTelegram(value){
 if(value.profiles)validateProfiles(value.profiles);
 if(value.recoverySoc<=value.lowSoc||value.fullResetSoc>=value.fullSoc)fail('Проверьте порядок порогов заряда');
}
