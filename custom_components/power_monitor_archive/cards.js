import {autoProvisionDashboards} from './dashboard-setup.js?v=1.0.207';
import {t,locale,setText,setMarkup,bindAttribute,setProfileLanguage,setLanguage,languagePreference,watchLanguage,refreshTranslations} from './i18n.js?v=1.0.207';
/* Lovelace cards and a one-time, user-owned dashboard template. */
import './panel.js?v=1.0.207';
import './device-card.js?v=1.0.207';
const PM_SECTIONS={flow:'Потоки энергии',energy:'Энергия сегодня',system:'Состояние системы',inverter:'Сеть и нагрузка',battery:'Батарея',bank:'Банк аккумуляторов',bms1:'BMS 1',bms2:'BMS 2',badges:'Бейджи',overview:'Полный обзор'};
const PM_HUBS=new WeakMap();
class PowerMonitorCardHub {
  constructor(hass){this.hass=hass;this.listeners=new Set();this.devices=[];this.current=new Map();this.nextStatus=0;this.timer=null;this.busy=false}
  subscribe(callback){this.listeners.add(callback);callback(this);if(!this.timer)this.timer=setInterval(()=>this.tick(),500);this.tick();return()=>{this.listeners.delete(callback);if(!this.listeners.size){clearInterval(this.timer);this.timer=null}}}
  async tick(){
    if(this.busy||!this.listeners.size||document.hidden)return;
    this.busy=true;
    try{
      if(Date.now()>=this.nextStatus){this.devices=(await this.hass.callWS({type:'power_monitor_archive/query',action:'status'})).devices;this.nextStatus=Date.now()+30000}
      const wanted=new Set([...this.listeners].map(fn=>fn.device==='auto'?this.devices[0]?.deviceId:fn.device).filter(Boolean));
      for(const device of wanted)this.current.set(device,await this.hass.callWS({type:'power_monitor_archive/query',action:'current',device}));
      this.error=null;
    }catch(e){this.error=t('Не удалось прочитать данные. Карточке требуется доступ администратора HA.');this.current.clear()}
    finally{this.busy=false;for(const callback of this.listeners)callback(this)}
  }
}
function pmCardHub(hass){let hub=PM_HUBS.get(hass.connection);if(!hub){hub=new PowerMonitorCardHub(hass);PM_HUBS.set(hass.connection,hub)}hub.hass=hass;return hub}
class PowerMonitorCard extends HTMLElement {
  constructor(){super();this.attachShadow({mode:'open'})}
  setConfig(config){
    if(config.section&&!PM_SECTIONS[config.section])throw new Error(t('Неизвестный блок Power Monitor'));
    if(config.device&&config.device!=='auto'&&!/^[0-9a-f]{12}$/.test(config.device))throw new Error(t('Неверный идентификатор ESP'));
    if(config.title!==undefined&&(typeof config.title!=='string'||config.title.length>120))throw new Error(t('Неверный заголовок'));
    this._config={...config,device:config.device||'auto',section:config.section||'flow'};this._unsubscribe?.();this._unsubscribe=null;this.connect();
  }
  set hass(hass){setProfileLanguage(hass.locale?.language||hass.language);if(this._hass?.connection!==hass.connection){this._unsubscribe?.();this._unsubscribe=null}this._hass=hass;this.connect()}
  connectedCallback(){this._languageUnsub?.();this._languageUnsub=watchLanguage(this);this.connect()}
  disconnectedCallback(){this._languageUnsub?.();this._languageUnsub=null;this._unsubscribe?.();this._unsubscribe=null}
  connect(){
    if(!this.isConnected||!this._hass||!this._config||this._unsubscribe)return;
    if(!this._dashboard){setMarkup(this.shadowRoot,'<ha-card><style>:host{display:block;min-width:0}h2{font-size:20px;font-weight:400;margin:0 0 14px}.content{padding:16px}.error{color:var(--secondary-text-color);padding:12px}[hidden]{display:none!important}</style><div class="content"><h2></h2><div class="error" role="status"></div><power-monitor-dashboard></power-monitor-dashboard></div></ha-card>');this._dashboard=this.shadowRoot.querySelector('power-monitor-dashboard')}
    const callback=hub=>{
      const device=this._config.device==='auto'?hub.devices[0]?.deviceId:this._config.device;
      const current=hub.current.get(device),fresh=current?.available&&Date.now()/1000-current.at<35;
      const heading=this.shadowRoot.querySelector('h2');setText(heading,()=>this._config.title||'');heading.hidden=!this._config.title;
      setText(this.shadowRoot.querySelector('.error'),()=>hub.error||(!device?t('Подключите ESP через интеграцию Power Monitor.'):''));
      this._dashboard.config={section:this._config.section,show_heading:!this._config.title};
      this._dashboard.readings=fresh?current:{available:false};
    };
    callback.device=this._config.device;this._unsubscribe=pmCardHub(this._hass).subscribe(callback);
  }
  getCardSize(){return this._config?.section==='flow'?8:5}
  getGridOptions(){return {columns:12,rows:'auto',min_columns:6}}
  static getStubConfig(){return {section:'flow',device:'auto'}}
  static getConfigElement(){return document.createElement('power-monitor-card-editor')}
}
class PowerMonitorHistoryCard extends HTMLElement {
  constructor(){super();this.attachShadow({mode:'open'})}
  setConfig(config){if(config.device&&config.device!=='auto'&&!/^[0-9a-f]{12}$/.test(config.device))throw new Error(t('Неверный идентификатор ESP'));this._config={...config};this.render()}
  set hass(hass){setProfileLanguage(hass.locale?.language||hass.language);this._hass=hass;this.render()}
  connectedCallback(){this._languageUnsub?.();this._languageUnsub=watchLanguage(this);this.render()}
  disconnectedCallback(){this._languageUnsub?.();this._languageUnsub=null;this._panel=null;this._appliedConfig=null;setMarkup(this.shadowRoot,'')}
  render(){
    if(!this.isConnected||!this._hass||!this._config)return;
    if(!this._panel){setMarkup(this.shadowRoot,'<ha-card><power-monitor-panel></power-monitor-panel></ha-card>');const p=this._panel=this.shadowRoot.querySelector('power-monitor-panel');p._embedded=true;p._configuredDevice=this._config.device==='auto'?null:this._config.device;p.hass=this._hass;const style=document.createElement('style');setText(style,()=>'.toolbar,.title,nav,#overview,#interface,#archive,#empty,.details{display:none!important}main{padding:0;max-width:none}.card{border:0;margin:0;padding:16px;box-shadow:none}#charts>h2{display:none}');p.shadowRoot.append(style);p.showView('history')}
    this._panel.hass=this._hass;
    if(this._appliedConfig===this._config)return;
    this._appliedConfig=this._config;
    this._panel._configuredDevice=this._config.device==='auto'?null:this._config.device;
    this._panel.el('device').value='';
    const period=String(this._config.period||'1'),mode=this._config.metric||'power';
    if(['1','7','30','365','all'].includes(period))this._panel.el('period').value=period;
    if(['power','energy','voltage','temperature','soc'].includes(mode))this._panel.el('mode').value=mode;
  }
  getCardSize(){return 10}
  getGridOptions(){return {columns:12,rows:'auto',min_columns:6}}
  static getStubConfig(){return {device:'auto',period:'1',metric:'power'}}
  static getConfigElement(){return document.createElement('power-monitor-card-editor')}
}
class PowerMonitorInterfaceCard extends HTMLElement {
  constructor(){super();this.attachShadow({mode:'open'})}
  setConfig(config){if(config.device&&config.device!=='auto'&&!/^[0-9a-f]{12}$/.test(config.device))throw new Error(t('Неверный идентификатор ESP'));this._config={...config,device:config.device||'auto'};this._unsub?.();this._unsub=null;this.connect()}
  set hass(hass){setProfileLanguage(hass.locale?.language||hass.language);if(this._hass?.connection!==hass.connection){this._unsub?.();this._unsub=null}this._hass=hass;this.connect()}
  connectedCallback(){this._languageUnsub?.();this._languageUnsub=watchLanguage(this);this.connect()}
  disconnectedCallback(){this._languageUnsub?.();this._languageUnsub=null;this._unsub?.();this._unsub=null}
  connect(){
    if(!this.isConnected||!this._config||!this._hass||this._unsub)return;
    if(!this._mode){
      setMarkup(this.shadowRoot,"<link rel=\"stylesheet\" href=\"/power_monitor_archive/control.css?v=1.0.207\"><style>.wrap{max-width:560px;margin:40px auto;padding:0 18px}</style><div class=\"wrap\"><section class=\"card\"><div class=\"card-head\"><h2><!--pm-i18n:%D0%9E%D1%81%D0%BD%D0%BE%D0%B2%D0%BD%D0%BE%D0%B9%20%D0%B8%D0%BD%D1%82%D0%B5%D1%80%D1%84%D0%B5%D0%B9%D1%81-->Основной интерфейс</h2><ha-icon icon=\"mdi:monitor-dashboard\"></ha-icon></div><form><label class=\"field\"><span><!--pm-i18n:%D0%9E%D1%82%D0%BA%D1%80%D1%8B%D0%B2%D0%B0%D1%82%D1%8C%20pm.local%20%D0%B2-->Открывать pm.local в</span><select aria-label=\"Основной интерфейс\" data-pm-i18n-aria-label=\"%D0%9E%D1%81%D0%BD%D0%BE%D0%B2%D0%BD%D0%BE%D0%B9%20%D0%B8%D0%BD%D1%82%D0%B5%D1%80%D1%84%D0%B5%D0%B9%D1%81\"><option value=\"ha\">Home Assistant</option><option value=\"esp\">ESP</option></select></label><div class=\"actions\"><button type=\"submit\" class=\"button primary\" disabled><!--pm-i18n:%D0%A1%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D0%B8%D1%82%D1%8C-->Сохранить</button><a class=\"button\" target=\"_blank\" rel=\"noopener\"><!--pm-i18n:%D0%9E%D1%82%D0%BA%D1%80%D1%8B%D1%82%D1%8C%20ESP-->Открыть ESP</a></div><p class=\"muted\"><!--pm-i18n:%D0%92%D1%8B%D0%B1%D0%BE%D1%80%20%D1%81%D1%82%D1%80%D0%B0%D0%BD%D0%B8%D1%86%D1%8B%20%D0%BF%D1%80%D0%B8%20%D0%B2%D1%85%D0%BE%D0%B4%D0%B5%20%D0%BD%D0%B0%20ESP.%20%D0%A1%D0%B1%D0%BE%D1%80%20%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D1%85%20%D0%BF%D1%80%D0%BE%D0%B4%D0%BE%D0%BB%D0%B6%D0%B8%D1%82%D1%81%D1%8F.-->Выбор страницы при входе на ESP. Сбор данных продолжится.<br><!--pm-i18n:%D0%9B%D0%BE%D0%BA%D0%B0%D0%BB%D1%8C%D0%BD%D1%8B%D0%B9%20%D0%B2%D1%85%D0%BE%D0%B4%3A%20%2Flocal%2F-->Локальный вход: /local/</p><p class=\"muted\" role=\"status\"></p></form></section></div>");
      this._mode=this.shadowRoot.querySelector('select');this._button=this.shadowRoot.querySelector('button');this._status=this.shadowRoot.querySelector('[role=status]');
      this._mode.onchange=()=>{this._dirty=true;this._button.disabled=!this._device?.interfaceControl||this._saving;setText(this._status,()=>'')};
      this.shadowRoot.querySelector('form').onsubmit=async event=>{event.preventDefault();if(!this._device||this._saving)return;this._saving=true;this._button.disabled=true;setText(this._status,()=>t('Сохранение…'));try{const result=await this._hass.callWS({type:'power_monitor_archive/query',action:'interface',device:this._device.deviceId,url:this._mode.value==='ha'?location.origin+'/power-monitor?device='+this._device.deviceId:''});if(!result.saved)throw new Error();this._dirty=false;setText(this._status,()=>t('Сохранено'));pmCardHub(this._hass).nextStatus=0}catch(_){setText(this._status,()=>t('Сохранение не подтверждено'));this._button.disabled=false}finally{this._saving=false}};
    }
    const callback=hub=>{const device=this._config.device==='auto'?hub.devices[0]:hub.devices.find(d=>d.deviceId===this._config.device);this._device=device;const allowed=!!device?.interfaceControl;this._mode.disabled=!allowed;this._button.disabled=!allowed||!this._dirty||this._saving;this.shadowRoot.querySelector('a').href=device?.localUrl||'#';if(!this._dirty&&!this._saving&&device)this._mode.value=device.interfaceUrl?'ha':'esp';const message=hub.error||(!device?(hub.nextStatus?t('Подключите ESP через интеграцию'):t('Подключение…')):!allowed?t('Подключите ESP новым кодом для выбора интерфейса'):'');if(message){setText(this._status,()=>message);this._accessMessage=true}else if(this._accessMessage){setText(this._status,()=>'');this._accessMessage=false}};callback.device=this._config.device;this._unsub=pmCardHub(this._hass).subscribe(callback);
  }
  getCardSize(){return 4}
  getGridOptions(){return {columns:12,rows:'auto'}}
  static getStubConfig(){return {device:'auto'}}
  static getConfigElement(){return document.createElement('power-monitor-card-editor')}
}
class PowerMonitorCardEditor extends HTMLElement {
  constructor(){super();this.attachShadow({mode:'open'})}
  setConfig(config){this._config={...config};this.render()}
  set hass(hass){setProfileLanguage(hass.locale?.language||hass.language);this._hass=hass;if(this._loaded!==hass.connection){this._loaded=hass.connection;hass.callWS({type:'power_monitor_archive/query',action:'status'}).then(s=>{this._devices=s.devices;this.render()}).catch(()=>{})}this.render()}
  render(){
    if(!this._config)return;
    const history=this._config.type==='custom:power-monitor-history-card';
    const interfaceCard=this._config.type==='custom:power-monitor-interface-card';
    setMarkup(this.shadowRoot,"<style>label{display:flex;flex-direction:column;gap:8px;margin:16px 0;color:var(--primary-text-color)}input,select{font:inherit;padding:12px;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);color:var(--primary-text-color)}p{color:var(--secondary-text-color)}</style><label><!--pm-i18n:%D0%A3%D1%81%D1%82%D1%80%D0%BE%D0%B9%D1%81%D1%82%D0%B2%D0%BE-->Устройство<select id=\"device\"></select></label><label id=\"section-label\"><!--pm-i18n:%D0%91%D0%BB%D0%BE%D0%BA-->Блок<select id=\"section\"></select></label><label id=\"title-label\"><!--pm-i18n:%D0%97%D0%B0%D0%B3%D0%BE%D0%BB%D0%BE%D0%B2%D0%BE%D0%BA-->Заголовок<input id=\"title\" maxlength=\"120\"></label><label id=\"period-label\"><!--pm-i18n:%D0%9F%D0%B5%D1%80%D0%B8%D0%BE%D0%B4-->Период<select id=\"period\"></select></label><label id=\"metric-label\"><!--pm-i18n:%D0%93%D1%80%D0%B0%D1%84%D0%B8%D0%BA-->График<select id=\"metric\"></select></label><p><!--pm-i18n:%D0%9A%D0%BE%D0%BD%D1%84%D0%B8%D0%B3%D1%83%D1%80%D0%B0%D1%86%D0%B8%D1%8E%20%D0%BC%D0%BE%D0%B6%D0%BD%D0%BE%20%D1%80%D0%B5%D0%B4%D0%B0%D0%BA%D1%82%D0%B8%D1%80%D0%BE%D0%B2%D0%B0%D1%82%D1%8C%20%D0%B2%20YAML.%20%D0%94%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5%20%D1%87%D0%B8%D1%82%D0%B0%D0%B5%D1%82%20Home%20Assistant%3B%20%D0%BA%D0%B0%D1%80%D1%82%D0%BE%D1%87%D0%BA%D0%B8%20%D0%BD%D0%B5%20%D0%BF%D0%BE%D0%B4%D0%BA%D0%BB%D1%8E%D1%87%D0%B0%D1%8E%D1%82%D1%81%D1%8F%20%D0%BA%20ESP%20%D0%BD%D0%B0%D0%BF%D1%80%D1%8F%D0%BC%D1%83%D1%8E.-->Конфигурацию можно редактировать в YAML. Данные читает Home Assistant; карточки не подключаются к ESP напрямую.</p>");
    const select=(id,options,value)=>{const el=this.shadowRoot.getElementById(id);for(const [key,label]of options){const o=document.createElement('option');o.value=key;setText(o,()=>label);el.append(o)}el.value=value;el.onchange=()=>this.change(id,el.value)};
    select('device',[['auto',t('Первое подключённое устройство')],...(this._devices||[]).map(d=>[d.deviceId,d.name+' · '+d.deviceId])],this._config.device||'auto');
    select('section',Object.entries(PM_SECTIONS),this._config.section||'flow');
    select('period',[['1',t('24 часа')],['7',t('7 дней')],['30',t('30 дней')],['365',t('Год')],['all',t('Весь архив')]],String(this._config.period||'1'));
    select('metric',[['power',t('Мощность')],['energy',t('Энергия')],['voltage',t('Напряжения')],['temperature',t('Температура')],['soc','SOC']],this._config.metric||'power');
    this.shadowRoot.getElementById('section-label').hidden=history||interfaceCard;this.shadowRoot.getElementById('title-label').hidden=history||interfaceCard;
    this.shadowRoot.getElementById('period-label').hidden=!history;this.shadowRoot.getElementById('metric-label').hidden=!history;
    const title=this.shadowRoot.getElementById('title');title.value=this._config.title||'';title.onchange=()=>this.change('title',title.value);
  }
  change(key,value){this._config={...this._config,[key]:value};this.dispatchEvent(new CustomEvent('config-changed',{detail:{config:this._config},bubbles:true,composed:true}))}
}
for(const [name,type]of [['power-monitor-card',PowerMonitorCard],['power-monitor-history-card',PowerMonitorHistoryCard],['power-monitor-interface-card',PowerMonitorInterfaceCard],['power-monitor-card-editor',PowerMonitorCardEditor]])if(!customElements.get(name))customElements.define(name,type);
window.customCards=window.customCards||[];
for(const card of [{type:'power-monitor-card',name:'Power Monitor',description:'Потоки энергии, суточные итоги, банк батарей и BMS',preview:true},{type:'power-monitor-history-card',name:'Power Monitor · Архив',description:'Графики из архива интеграции на HA',preview:true},{type:'power-monitor-interface-card',name:'Power Monitor · Интерфейс',description:'Выбор основного входа ESP / Home Assistant',preview:true}])if(!window.customCards.some(c=>c.type===card.type))window.customCards.push(card);

if(typeof document!=='undefined'&&document.querySelector)autoProvisionDashboards();
