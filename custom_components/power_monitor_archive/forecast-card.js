import {DeviceApi} from './control-api.js?v=1.0.236';
import {t,locale,setProfileLanguage,watchLanguage} from './i18n.js?v=1.0.236';
import {el,icon,button} from './control-ui.js?v=1.0.236';

export const forecastPresentation=config=>Object.fromEntries(['show_title','show_city','show_period','show_updated','show_note','show_units','show_refresh'].map(k=>[k,config?.[k]!==false]));
const TTL=30*60*1000,MAX_BODY=128*1024;
const hubs=new WeakMap();
const signature=c=>JSON.stringify(['forecastSource','forecastCity','forecastLatitude','forecastLongitude','forecastPeakPowerWatts','forecastTiltDegrees','forecastAzimuthDegrees','forecastEfficiency','forecastApiUrl','forecastServerUrl'].map(k=>c[k]));
export function forecastUrl(c){
 const custom=c.forecastSource==='custom',url=new URL(custom?c.forecastServerUrl:c.forecastApiUrl||'https://api.open-meteo.com/v1/forecast');
 if(!['https:','http:'].includes(url.protocol))throw Error('invalid_url');
 const query={latitude:c.forecastLatitude,longitude:c.forecastLongitude,tilt:c.forecastTiltDegrees};
 if(custom)Object.assign(query,{days:7,peak_power_w:c.forecastPeakPowerWatts,azimuth:c.forecastAzimuthDegrees,efficiency:c.forecastEfficiency});
 else Object.assign(query,{hourly:'global_tilted_irradiance',forecast_days:7,timezone:'auto',timeformat:'unixtime',azimuth:Number(c.forecastAzimuthDegrees)-180,...(c.forecastApiKey?{apikey:c.forecastApiKey}:{})});
 for(const [k,v]of Object.entries(query))url.searchParams.set(k,String(v));return url.toString();
}
const finite=v=>typeof v==='number'&&Number.isFinite(v);
export function forecastDays(payload,c){
 let days;
 if(c.forecastSource==='open_meteo'){
  const times=payload?.hourly?.time,values=payload?.hourly?.global_tilted_irradiance;
  if(!Array.isArray(times)||!Array.isArray(values)||times.length!==values.length||times.length>192)throw Error('invalid_forecast');
  const peak=Number(c.forecastPeakPowerWatts),efficiency=Number(c.forecastEfficiency),totals=new Map();
  if(!finite(peak)||peak<0||!finite(efficiency)||efficiency<0||efficiency>1)throw Error('invalid_config');
  times.forEach((time,i)=>{if(!finite(values[i]))return;let date=String(time).slice(0,10);if(typeof time==='number'){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:payload.timezone||'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date((time-1)*1000));const get=k=>parts.find(p=>p.type===k)?.value;date=`${get('year')}-${get('month')}-${get('day')}`}totals.set(date,(totals.get(date)||0)+Math.max(0,values[i])*peak/1000*efficiency)});
  days=[...totals].map(([date,energyWh])=>({date,energyWh}));
 }else days=payload?.days;
 if(!Array.isArray(days)||!days.length)throw Error('empty_forecast');
 return days.slice(0,7).map(d=>{const date=String(d?.date||''),energyWh=d?.energyWh??d?.energy_wh;if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!finite(energyWh)||energyWh<0||!Number.isFinite(Date.parse(date+'T12:00:00Z'))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)throw Error('invalid_forecast');return {date,energyWh}});
}
export async function readForecast(response){
 if(Number(response.headers?.get('Content-Length'))>MAX_BODY)throw Error('body_limit');
 const reader=response.body?.getReader();if(!reader)throw Error('stream_required');
 const bytes=new Uint8Array(MAX_BODY);let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;if(value.byteLength>MAX_BODY-size)throw Error('body_limit');bytes.set(value,size);size+=value.byteLength}return JSON.parse(new TextDecoder().decode(bytes.subarray(0,size)))}
 catch(error){reader.cancel().catch(()=>{});throw error}finally{reader.releaseLock()}
}
export class ForecastSource{
 constructor(){this.days=[];this.next=0;this.updated=0}
 load(api,force=false){
  if(this.pending)return this.pending;
  if(Date.now()<this.next&&!force)return Promise.resolve(this);
  if(force&&Date.now()-(this.attempt||0)<5000)return Promise.resolve(this);
  this.attempt=Date.now();this.error=false;
  this.pending=(async()=>{
   try{
    const config=await api.get('forecast/config'),key=signature(config);
    if(key!==this.signature){this.days=[];this.updated=0}this.signature=key;this.city=config.forecastCity||'';this.source=config.forecastSource;
    if(this.source==='off'){this.days=[];this.updated=0;this.next=Date.now()+TTL;return this}
    if(!['open_meteo','custom'].includes(this.source))throw Error('invalid_source');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{
     const headers={Accept:'application/json'};if(this.source==='custom'&&config.forecastServerToken)headers.Authorization='Bearer '+config.forecastServerToken;
     const response=await fetch(forecastUrl(config),{signal:controller.signal,headers,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
     if(!response.ok)throw Error('forecast_http');this.days=forecastDays(await readForecast(response),config);this.updated=Date.now();
    }finally{clearTimeout(timer);controller.abort()}
    this.next=Date.now()+TTL;
   }catch(_){this.error=true;this.next=Date.now()+60000;if(Date.now()-this.updated>24*60*60*1000)this.days=[]}
   return this;
  })().finally(()=>{this.pending=null});return this.pending;
 }
}
function sourceFor(hass,device){let devices=hubs.get(hass.connection);if(!devices){devices=new Map();hubs.set(hass.connection,devices)}if(!devices.has(device))devices.set(device,new ForecastSource());return devices.get(device)}
class PowerMonitorForecastCard extends HTMLElement{
 constructor(){super();this.attachShadow({mode:'open'});this._epoch=0;this._visible=()=>{if(!document.hidden)this.load()}}
 setConfig(c){if(c.device&&c.device!=='auto'&&!/^[0-9a-f]{12}$/.test(c.device))throw Error(t('Неверный идентификатор ESP'));if(c.title!==undefined&&(typeof c.title!=='string'||c.title.length>120))throw Error(t('Неверный заголовок'));const changed=this._config?.device!==c.device;this._config={...c};this._epoch++;if(changed)this.load();else this.render()}
 set hass(hass){setProfileLanguage(hass.locale?.language||hass.language);const changed=this._hass?.connection!==hass.connection;this._hass=hass;if(changed)this.load()}
 connectedCallback(){this._unsub?.();this._unsub=watchLanguage(this,()=>this.render());document.addEventListener('visibilitychange',this._visible);clearInterval(this._timer);this._timer=setInterval(()=>{if(!document.hidden)this.load()},60000);this.load()}
 disconnectedCallback(){this._epoch++;clearInterval(this._timer);this._unsub?.();this._unsub=null;document.removeEventListener('visibilitychange',this._visible)}
 async load(force=false){
  if(!this.isConnected||!this._hass||!this._config||this._loading)return;
  const epoch=this._epoch;this._loading=true;this._failed=false;this.render();
  try{let device=this._config.device;if(!device||device==='auto'){const s=await this._hass.callWS({type:'power_monitor_archive/query',action:'status'});device=s.devices[0]?.deviceId}if(!device)throw Error('no_device');this._source=sourceFor(this._hass,device);await this._source.load(new DeviceApi(this._hass,device),force)}
  catch(_){this._failed=true}finally{this._loading=false;if(this.isConnected){if(epoch===this._epoch)this.render();else this.load()}}
 }
 render(){
  if(!this.isConnected)return;const s=this._source,days=s?.days||[],view=forecastPresentation(this._config);
  this.shadowRoot.replaceChildren();const style=el('style');style.textContent=`:host{display:block;min-width:0;color:var(--primary-text-color)}*{box-sizing:border-box}.content{padding:20px}.header{display:flex;align-items:center;gap:12px}.header ha-icon{color:var(--primary-color);--mdc-icon-size:24px}h2{font-size:18px;font-weight:500;margin:0;flex:1;min-width:0}.button{font:inherit;font-size:13px;min-height:40px;padding:8px 12px;background:transparent;color:var(--primary-color);border:1px solid var(--divider-color);border-radius:10px;cursor:pointer}.button:disabled{opacity:.5;cursor:default}.muted{font-size:12px;line-height:1.6;color:var(--secondary-text-color);margin:10px 0}.days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;margin:20px 0 14px}.day{min-width:0;display:flex;flex-direction:column;align-items:center;gap:7px}.value{font-size:16px;font-weight:500;white-space:nowrap}.track{height:88px;width:100%;max-width:42px;border-radius:7px;background:color-mix(in srgb,var(--primary-color) 8%,transparent);display:flex;align-items:flex-end;overflow:hidden}.bar{width:100%;background:linear-gradient(#ffca66,#f4a52d);border-radius:7px}.date,.weekday{font-size:12px;color:var(--secondary-text-color)}.warning{color:var(--warning-color,#e5b963)}@media(max-width:500px){.content{padding:16px}.header{flex-wrap:wrap}.header h2{font-size:16px}.days{gap:4px}.value{font-size:13px}.date,.weekday{font-size:10px}.track{max-width:28px;height:72px}}`;
  const card=el('ha-card'),content=el('div','content'),header=el('div','header'),refresh=button(()=>t('Обновить'),()=>this.load(true));refresh.disabled=!!this._loading;if(view.show_title)header.append(icon('mdi:weather-sunny'),el('h2',null,()=>this._config.title||t('Прогноз генерации PV'),true));if(view.show_refresh)header.append(refresh);if(view.show_title||view.show_refresh)content.append(header);
  const subtitle=[view.show_city?s?.city:'',view.show_period?t('Прогноз на 7 дней'):''].filter(Boolean).join(' · ');if(subtitle)content.append(el('p','muted',()=>subtitle,true));
  if(days.length){const grid=el('div','days'),max=Math.max(1,...days.map(d=>d.energyWh));for(const d of days){const node=el('div','day'),date=new Date(d.date+'T12:00:00'),value=(d.energyWh/1000).toLocaleString(locale(),{minimumFractionDigits:1,maximumFractionDigits:1}),track=el('div','track'),bar=el('div','bar');bar.style.height=Math.max(d.energyWh>0?2:0,d.energyWh/max*100)+'%';track.append(bar);node.setAttribute('aria-label',date.toLocaleDateString(locale())+': '+value+' '+t('кВт·ч'));node.append(el('strong','value',()=>value),track,el('span','weekday',()=>date.toLocaleDateString(locale(),{weekday:'short'})),el('span','date',()=>date.toLocaleDateString(locale(),{day:'2-digit',month:'2-digit'})));grid.append(node)}content.append(grid);const footer=[view.show_units?t('кВт·ч'):'',view.show_updated?t('Обновлено')+': '+new Date(s.updated).toLocaleString(locale()):''].filter(Boolean).join(' · ');if(footer)content.append(el('div','muted',()=>footer))}
  const message=this._loading?t('Загрузка прогноза…'):s?.source==='off'?t('Прогноз выключен. Включите его в настройках генерации PV.'):s?.error||this._failed?(days.length?t('Не удалось обновить прогноз. Показаны сохранённые данные.'):t('Прогноз недоступен. Проверьте интернет и настройки PV.')):!days.length?t('Нет данных прогноза'):t('Расчётная генерация, фактическая зависит от погоды.');
  const status=el('p','muted'+(s?.error?' warning':''),()=>message);status.setAttribute('role','status');if(view.show_note||this._loading||s?.error||this._failed||!days.length)content.append(status);card.append(style,content);this.shadowRoot.append(card);
 }
 getCardSize(){return 5}
 getGridOptions(){return {columns:12,rows:'auto',min_columns:6}}
 static getStubConfig(){return {device:'auto'}}
 static getConfigElement(){return document.createElement('power-monitor-forecast-card-editor')}
}
export const FORECAST_OPTIONS=[['show_title','Заголовок'],['show_city','Город'],['show_period','Подпись периода'],['show_updated','Время обновления'],['show_note','Пояснение под графиком'],['show_units','Единица измерения под графиком'],['show_refresh','Кнопка обновления']];
class PowerMonitorForecastEditor extends HTMLElement{
 constructor(){super();this.attachShadow({mode:'open'})}
 setConfig(config){if(JSON.stringify(config)===JSON.stringify(this._config))return;this._config={...config};this.render()}
 set hass(hass){setProfileLanguage(hass.locale?.language||hass.language)}
 connectedCallback(){this._unsub?.();this._unsub=watchLanguage(this,()=>this.render());this.render()}
 disconnectedCallback(){this._unsub?.();this._unsub=null}
 change(key,value){this._config={...this._config,[key]:value};this.dispatchEvent(new CustomEvent('config-changed',{detail:{config:{...this._config}},bubbles:true,composed:true}))}
 render(){
  if(!this._config)return;this.shadowRoot.replaceChildren();const style=el('style');style.textContent=':host{display:block;color:var(--primary-text-color)}.title{display:grid;gap:8px;margin:16px 0}input[type=text]{box-sizing:border-box;width:100%;font:inherit;padding:12px;border-radius:10px;border:1px solid var(--divider-color);background:var(--card-background-color);color:inherit}.option{display:flex;align-items:center;gap:12px;min-height:44px;border-bottom:1px solid var(--divider-color);font-size:14px}.option input{width:18px;height:18px;accent-color:var(--primary-color);flex-shrink:0}';this.shadowRoot.append(style);
  const label=el('label','title'),title=el('input');title.type='text';title.maxLength=120;title.value=this._config.title||'';title.placeholder=t('Прогноз генерации PV');title.onchange=()=>this.change('title',title.value);label.append(el('span',null,()=>t('Заголовок')),title);this.shadowRoot.append(label);
  const view=forecastPresentation(this._config);for(const [key,text]of FORECAST_OPTIONS){const row=el('label','option'),input=el('input');input.type='checkbox';input.name=key;input.checked=view[key];input.onchange=()=>this.change(key,input.checked);row.append(input,el('span',null,()=>t(text)));this.shadowRoot.append(row)}
 }
}
if(typeof customElements!=='undefined'&&!customElements.get('power-monitor-forecast-card-editor'))customElements.define('power-monitor-forecast-card-editor',PowerMonitorForecastEditor);
if(typeof customElements!=='undefined'&&!customElements.get('power-monitor-forecast-card'))customElements.define('power-monitor-forecast-card',PowerMonitorForecastCard);
if(typeof window!=='undefined'){window.customCards=window.customCards||[];if(!window.customCards.some(c=>c.type==='power-monitor-forecast-card'))window.customCards.push({type:'power-monitor-forecast-card',name:'Power Monitor · PV',description:'Прогноз генерации на семь дней',preview:true})}
