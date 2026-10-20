import {t,isApplicationMessage,locale,setText,setMarkup,bindAttribute,setProfileLanguage,setLanguage,languagePreference,watchLanguage,refreshTranslations} from './i18n.js?v=1.0.213';
/* Small native DOM primitives; never render device-provided HTML. */
export const el=(tag,cls,text,raw=false)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)setText(n,text,!raw);return n};
export const icon=name=>{const n=el('ha-icon');n.setAttribute('icon',name);return n};
export const button=(text,action,cls='button',glyph,raw=false)=>{const b=el('button',cls);b.type='button';if(glyph)b.append(icon(glyph));const label=document.createTextNode('');setText(label,text,!raw);b.append(label);b.onclick=action;return b};
export function layoutFields(fields,leading=[]){const first=fields.filter(f=>leading.includes(f.key)),rest=fields.filter(f=>!leading.includes(f.key)),regular=rest.filter(f=>f.type!=='switch'),switches=rest.filter(f=>f.type==='switch');return [...first.map(f=>({...f,fullWidth:true})),...regular.map((f,i)=>regular.length%2&&i===regular.length-1?{...f,fullWidth:true}:f),...switches]}
// Firmware still persists four legacy generation gates. Personal permissions
// are authoritative in HA; a user save opens those gates without changing masks.
export const telegramSettingsPatch=patch=>({...patch,gridLost:true,gridRestored:true,lowBattery:true,fullBattery:true});
export const fmt=(value,digits=0)=>value===null||value===undefined||!Number.isFinite(Number(value))?'—':Number(value).toLocaleString(locale(),{maximumFractionDigits:digits,minimumFractionDigits:digits});
export const timeValue=minutes=>`${String(Math.floor((Number(minutes)||0)/60)).padStart(2,'0')}:${String((Number(minutes)||0)%60).padStart(2,'0')}`;
export const inputNumber=(value,desc={})=>value===null||value===undefined||value===''?'':Number((Number(value)*(desc.scale||1)).toFixed(desc.digits??6));
export const storedNumber=(value,desc={})=>value===''?NaN:Number(value)/(desc.scale||1);
export const sameValue=(a,b)=>a===b||(typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(0.000001,Math.abs(b)*0.000001));
export function verifyPatch(actual,patch){
 for(const [key,value]of Object.entries(patch)){
  if(key==='scope')continue;
  if(Array.isArray(value)){if(!Array.isArray(actual?.[key])||actual[key].length!==value.length)throw new Error(t('Сохранение не подтверждено чтением'));value.forEach((item,i)=>typeof item==='object'?verifyPatch(actual[key][i],item):verifyPatch({value:actual[key][i]},{value:item}));continue}
  if(value&&typeof value==='object'){verifyPatch(actual?.[key],value);continue}
  if(!sameValue(actual?.[key],value))throw new Error(t('Сохранение не подтверждено чтением'));
 }
}
const errors={device_pairing_required:'Подключите управление новым кодом ESP',device_busy:'Устройство занято',device_unavailable:'Ответ устройства не подтверждён',inverter_profile_not_pi30:'Настройки недоступны для текущего профиля',unauthorized:'Недостаточно прав',history_memory_busy:'Устройство занято'};
Object.assign(errors,{out_of_memory:'Недостаточно памяти ESP',invalid_request:'Некорректный запрос',invalid_body:'Некорректные данные',invalid_json:'Некорректные данные',body_limit:'Слишком большой запрос',device_control_required:'Обновите привязку интеграции кодом с ESP',device_queue_full:'Очередь устройства занята. Повторите позже',device_timeout:'Устройство не ответило вовремя',device_response_too_large:'Ответ устройства превышает допустимый размер',device_command_expired:'Время ожидания команды истекло',invalid_token:'Доступ истёк. Разблокируйте устройство заново',forbidden:'Недостаточно прав',not_found:'Данные не найдены',busy:'Устройство занято',timeout:'Устройство не ответило вовремя',offline:'Устройство недоступно',locked:'Разблокируйте настройки',unsupported:'Действие не поддерживается',invalid_value:'Проверьте введённое значение','Failed to fetch':'Нет связи с Home Assistant','NetworkError':'Нет связи с Home Assistant'});
export const errorText=error=>{
 const code=error?.data?.error||error?.data?.result||error?.code,message=error?.message;
 if(error?.data?.address!==undefined&&error?.data?.result){const bms={timeout:t('BMS не подтвердила запись. Прочитайте настройки перед повтором'),mismatch:t('BMS вернула другое значение. Прочитайте настройки'),send_failed:t('Не удалось отправить команду BMS'),unsupported:t('Этот параметр BMS нельзя подтвердить чтением')};if(bms[error.data.result])return t(bms[error.data.result])}
 if(errors[code]||errors[message])return t(errors[code]||errors[message]);
 if(isApplicationMessage(message))return t(message);
 if(message&&/[А-Яа-яЁё]/.test(message))return message;
 if(error?.status===401||error?.status===403)return t('Нет доступа к устройству. Проверьте привязку');
 if(error?.status===409)return t('Действие сейчас недоступно. Проверьте состояние устройства');
 if(error?.status===422)return t('Устройство отклонило значение. Проверьте параметры');
 return t('Не удалось подтвердить действие. Проверьте связь и состояние устройства');
};
export const eventStamp=(event,data)=>{
 let stamp=Number(event.timestamp)||0;
 if(stamp<1700000000&&data.serverTimestamp>=1700000000&&event.uptimeSeconds<=data.serverUptimeSeconds)stamp=data.serverTimestamp-(data.serverUptimeSeconds-event.uptimeSeconds);
 return stamp;
};
export const eventTime=(event,data)=>{const stamp=eventStamp(event,data);return stamp>=1700000000?new Date(stamp*1000).toLocaleString(locale(),{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):t('До синхронизации')};
// `active` describes the recorded edge, never the present health of a device.
export function eventMeta(event){
 const code=String(event.code||''),recovery=/(_restored|_normal|_recovered)$/.test(code);
 const severity=recovery?'recovery':['critical','warning'].includes(event.severity)?event.severity:'info';
 const category=code.startsWith('grid')?'grid':code.startsWith('wifi')?'wifi':/^(bms|cell)/.test(code)?'bms':/^(inverter|load|temperature)/.test(code)?'inverter':'system';
 const unit=/^grid_/.test(code)?'В':/^temperature_/.test(code)?'°C':/^cell_delta_/.test(code)?'В':/^load_/.test(code)?'%':/^heap_/.test(code)?'КБ':null;
 const value=Number(event.value),measurement=unit&&Number.isFinite(value)?fmt(unit==='КБ'?value/1024:value,unit==='В'&&code.startsWith('cell')?3:unit==='КБ'?1:0)+' '+t(unit):'';
 return {severity,category,measurement};
}

Object.assign(errors,{ble_scan_active:'Сначала завершите поиск Bluetooth',wifi_scan_busy:'Поиск Wi-Fi уже выполняется',invalid_address:'Проверьте MAC-адрес BMS',storage_failed:'Не удалось сохранить настройки на ESP',runtime_failed:'ESP не подтвердила применение настроек'});
export async function searchCities(query,signal){
 if(String(query).trim().length<2)return [];
 const url=new URL('https://geocoding-api.open-meteo.com/v1/search');url.search=new URLSearchParams({name:String(query).trim(),count:'8',language:/[іїєґ]/i.test(query)?'uk':locale().slice(0,2),format:'json'});
 const response=await fetch(url,{signal});if(!response.ok)throw new Error(t('Поиск городов временно недоступен'));
 const data=await response.json();return (data.results||[]).filter(n=>Number.isFinite(n.latitude)&&Number.isFinite(n.longitude)&&Math.abs(n.latitude)<=90&&Math.abs(n.longitude)<=180).map(n=>({name:n.name,latitude:n.latitude,longitude:n.longitude,label:[...new Set([n.name,n.admin1,n.country].filter(Boolean))].join(', ')}));
}

Object.assign(errors,{'Invalid BMS password':'Неверный пароль BMS'});

export const inverterInputValue=value=>String(value!==null&&value!==''&&Number.isFinite(Number(value))?Number(value):value??'');
