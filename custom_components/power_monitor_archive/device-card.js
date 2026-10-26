import {t,locale,setText,setMarkup,bindAttribute,setProfileLanguage,setLanguage,languagePreference,watchLanguage,refreshTranslations} from './i18n.js?v=1.0.236';
/* Native HA frontend. No embedded firmware document or browser LAN traffic. */
import {PAGES} from './control-schema.js?v=1.0.236';
import './telegram-card.js?v=1.0.236';
import {DeviceApi} from './control-api.js?v=1.0.236';
import {RelayViews,SettingsViews,IntegrationViews} from './control-views.js?v=1.0.236';
import {HardwareViews,inverterSettingsUnsupported} from './control-hardware.js?v=1.0.236';
import {el,icon,button,fmt,timeValue,errorText,inputNumber,storedNumber,layoutFields} from './control-ui.js?v=1.0.236';
class PowerMonitorDeviceCard extends HTMLElement {
  constructor(){super();this.attachShadow({mode:'open'});this.pages=new Map();this.data={};this.busy=new Set();this.epoch=0;this._page='relays';this._bmsView='bank';this._visibility=()=>{if(!document.hidden)this.refresh()}}
  setConfig(config){
    if(config.device&&config.device!=='auto'&&!/^[0-9a-f]{12}$/.test(config.device))throw new Error(t('Неверный идентификатор ESP'));
    if(config.page&&!PAGES[config.page])throw new Error(t('Неизвестный раздел'));
    if(this._config&&this._config.device!==config.device){if(this.busy.size)throw new Error(t('Дождитесь завершения операции устройства'));this.dispose();this.data={}}
    this._config={...config};if(!this._started)this._page=config.page||'relays';this.connect();
  }
  set hass(hass){setProfileLanguage(hass.locale?.language||hass.language);this._hass=hass;if(this.api)this.api.hass=hass;this.connect()}
  connectedCallback(){this._languageUnsub?.();this._languageUnsub=watchLanguage(this,()=>{if(this._languageSelect)this._languageSelect.value=languagePreference();const page=this.pages.get(this._page);if(page)this.updateReadings(this._page,page)});document.addEventListener('visibilitychange',this._visibility);this.connect()}
  disconnectedCallback(){this._languageUnsub?.();this._languageUnsub=null;document.removeEventListener('visibilitychange',this._visibility);this.dispose()}
  dispose(){for(const n of this.shadowRoot.querySelectorAll('[data-pm-cleanup]'))n._cleanup?.();clearInterval(this._timer);clearTimeout(this._toastTimer);this.epoch++;this._started=false;this._connecting=false;this._refreshing=false;for(const d of this.shadowRoot.querySelectorAll('dialog')){d.close();d.remove()}this._dialog=null;this._bmsTokens={};this.pages.clear();this.shadowRoot.replaceChildren();this.api=null}
  async connect(){
    if(!this.isConnected||!this._hass||!this._config||this._started||this._connecting)return;
    this._connecting=true;const epoch=this.epoch;
    try{
      const status=await this._hass.callWS({type:'power_monitor_archive/query',action:'status'});
      if(!this.isConnected||epoch!==this.epoch)return;
      const device=this._config.device&&this._config.device!=='auto'?status.devices.find(d=>d.deviceId===this._config.device):status.devices[0];
      this.buildShell();
      if(!device||!device.deviceControl){this.content.append(this.empty(device?t('Подключите управление новым кодом ESP'):t('Подключите Power Monitor')));return}
      this._device=device;this.api=new DeviceApi(this._hass,device.deviceId);this._started=true;setText(this.nameNode,()=>device.name);this.selectPage(this._page,false);
      clearInterval(this._timer);this._timer=setInterval(()=>{if(!document.hidden)this.refresh(true)},500);this.refresh();
    }catch(error){if(this.isConnected&&epoch===this.epoch){this.buildShell();this.content.append(this.empty(t('Нет связи с интеграцией')));this.notify(error,true)}}
    finally{if(epoch===this.epoch)this._connecting=false}
  }
  buildShell(){
    this.shadowRoot.replaceChildren();const style=el('link');style.rel='stylesheet';style.href='/power_monitor_archive/control.css?v=1.0.236';this.shadowRoot.append(style);
    const shell=el('div','shell'),nav=this.nav=el('nav','navigation');nav.setAttribute('role','tablist');nav.setAttribute('aria-label',t('Управление Power Monitor'));
    for(const [key,[label,glyph]]of Object.entries(PAGES).filter(([key])=>key!=='events')){const b=button(()=>(label),()=>this.selectPage(key),'nav',glyph);b.dataset.page=key;b.id='tab-'+key;b.setAttribute('role','tab');b.setAttribute('aria-controls','page-'+key);nav.append(b)}
    nav.onkeydown=event=>{const all=[...nav.children],index=all.indexOf(event.target);if(index<0)return;let next;if(event.key==='ArrowRight')next=(index+1)%all.length;if(event.key==='ArrowLeft')next=(index+all.length-1)%all.length;if(event.key==='Home')next=0;if(event.key==='End')next=all.length-1;if(next!==undefined){event.preventDefault();all[next].focus();all[next].click()}};
    const heading=el('div','heading'),left=el('div');left.append(this.titleNode=el('h1',null,()=>(PAGES[this._page][0])));
    const connection=el('div','connection');this.dotNode=el('span','dot');this.nameNode=el('span','device-name');this.stateNode=el('span',null,()=>(t('Подключение')));connection.append(this.dotNode,this.nameNode,this.stateNode);const languageLabel=el('label','language-select'),languageIcon=icon('mdi:translate'),languageSelect=this._languageSelect=el('select');bindAttribute(languageSelect,'aria-label','Язык интерфейса');for(const [value,label]of [['auto','Язык Home Assistant'],['ru','Русский'],['uk','Українська'],['en','English']]){const option=el('option',null,()=>label);option.value=value;languageSelect.append(option)}languageSelect.value=languagePreference();languageSelect.onchange=()=>setLanguage(languageSelect.value);languageLabel.append(languageIcon,languageSelect);heading.append(left,languageLabel);
    this.content=el('div');nav.hidden=!!this._config.hide_navigation;shell.append(nav,heading,this.content);this.shadowRoot.append(shell);this.toast=el('div','toast');this.toast.hidden=true;this.toast.setAttribute('role','status');this.shadowRoot.append(this.toast);
  }
  selectPage(page,load=true){
    if(!PAGES[page])return;this._page=page;setText(this.titleNode,()=>t(PAGES[this._page][0]));
    for(const b of this.nav.children){const active=b.dataset.page===page;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;if(active)b.scrollIntoView({inline:'nearest',block:'nearest',behavior:'smooth'})}
    for(const [key,p]of this.pages)p.hidden=key!==page;
    let p=this.pages.get(page);if(!p){p=el('section','page');p.id='page-'+page;p.setAttribute('role','tabpanel');if(page==='events'||this._config.hide_navigation)bindAttribute(p,'aria-label',()=>PAGES[page][0]);else p.setAttribute('aria-labelledby','tab-'+page);p.append(el('div','loader'));this.pages.set(page,p);this.content.append(p)}
    p.hidden=false;p.classList.remove('entering');void p.offsetWidth;p.classList.add('entering');if(load&&this.api)this.refresh();
  }
  async refresh(liveOnly=false){
    if(!this.api||this._refreshing||!this.isConnected||this._updatingFirmware)return;
    const epoch=this.epoch,page=this._page,bmsView=this._bmsView;this._refreshing=true;
    try{
      const full=!liveOnly||Date.now()>=(this._nextFullRefresh||0);
      let paths={relays:['relays','tariff'],inverter:['inverter/settings','inverter/link','telemetry?channel=inverter'],bms:bmsView==='bank'?['settings']:[`bms?slot=${this._slot||0}`,`bms/settings?slot=${this._slot||0}`,'settings'],settings:['settings','inverter/link'],telegram:['telegram'],'home-assistant':['home-assistant/settings','archive'],events:['events']}[page];
      if(full)this._nextFullRefresh=Date.now()+10000;
      else{paths={relays:['relays'],inverter:['telemetry?channel=inverter'],bms:bmsView==='bank'?[]:[`bms?slot=${this._slot||0}`]}[page]||[];if(!paths.length&&!(page==='bms'&&bmsView==='bank'))return}
      for(const path of paths){try{this.data[path]=await this.api.get(path);this.data[path+':error']=null}catch(error){this.data[path+':error']=error}}
      if(page==='bms'&&bmsView==='bank'){
        try{this.data['bms-bank-current']=await this._hass.callWS({type:'power_monitor_archive/query',action:'current',device:this._device.deviceId});this.data['bms-bank-current:error']=null}catch(error){this.data['bms-bank-current:error']=error}
      }
      if(epoch!==this.epoch||!this.isConnected||page==='bms'&&bmsView!==this._bmsView)return;
      const failed=paths.some(path=>this.data[path+':error']&&!(page==='inverter'&&path==='inverter/settings'&&inverterSettingsUnsupported(this.data[path+':error'])))||(page==='bms'&&this._bmsView==='bank'&&!!this.data['bms-bank-current:error']);this.dotNode.classList.toggle('online',!failed);this.stateNode.parentElement.dataset.failed=String(failed);this.stateNode.parentElement.title=this._device?.name||'ESP';setText(this.stateNode,()=>failed?t('Нет свежих данных'):t('На связи'));this.renderPage(page);
    }finally{if(epoch===this.epoch){this._refreshing=false;if(this._page!==page||page==='bms'&&bmsView!==this._bmsView)this.refresh()}}
  }
  renderPage(page,force=false){
    const p=this.pages.get(page);if(!p)return;
    if(p.dataset.ready&&!force){this.updateReadings(page,p);return}
    for(const n of p.querySelectorAll('[data-pm-cleanup]'))n._cleanup?.();p.replaceChildren();p.dataset.ready='true';
    try{this[({relays:'renderRelays',inverter:'renderInverter',bms:'renderBms',settings:'renderSettings',telegram:'renderTelegram','home-assistant':'renderConnection',events:'renderEvents'})[page]](p)}
    catch(error){delete p.dataset.ready;p.replaceChildren(this.empty(errorText(error)))}this.updateReadings(page,p);
  }
  empty(text){const n=el('div','empty');n.append(icon('mdi:connection'),el('div',null,()=>(text)));return n}
  notice(text){const n=el('div','notice');n.append(icon('mdi:information-outline'),el('span',null,()=>(text)));return n}
  card(title,glyph,wide=false){const n=el('section','card'+(wide?' wide':'')),h=el('div','card-head');h.append(el('h2',null,()=>(title)));if(glyph)h.append(icon(glyph));n.append(h);return n}
  stats(values){const n=el('div','stats');for(const [label,value,unit,glyph,key]of values){const item=el('div','stat'),v=el('span','stat-value',()=>(value));if(key)v.dataset.live=key;item.append(el('span','stat-label',()=>(label)),v);if(unit){const u=el('span','stat-unit',()=>(unit));u.hidden=value==='—';item.append(u)}if(glyph)item.append(icon(glyph));n.append(item)}return n}
  async act(key,action,success=t('Сохранено')){
    if(this.busy.has(key))throw new Error(t('Операция уже выполняется'));this.busy.add(key);const epoch=this.epoch;
    try{const result=await action();if(epoch===this.epoch&&this.isConnected&&success)this.notify(success);return result}
    catch(error){if(epoch===this.epoch&&this.isConnected)this.notify(error,true);throw error}
    finally{this.busy.delete(key)}
  }
  run(key,action,success){return this.act(key,action,success).catch(()=>{})}
  notify(value,error=false){if(!this.toast)return;setText(this.toast,()=>error?errorText(value):String(value));this.toast.classList.toggle('error',error);this.toast.hidden=false;clearTimeout(this._toastTimer);this._toastTimer=setTimeout(()=>{this.toast.hidden=true},error?9000:3500)}
  field(desc,data,onchange,disabled=false){
    const {key,label,type='number'}=desc,n=el(type==='days'?'div':'label',type==='switch'?'switch-field':'field');if(desc.fullWidth)n.classList.add('full-width');n.append(el('span',null,()=>(label),!!desc.technical));
    if(type==='days'){n.setAttribute('role','group');bindAttribute(n,'aria-label',()=>label);const days=el('div','days');let mask=Number(data[key])||0;for(const [bit,name]of [[1,t('Пн')],[2,t('Вт')],[3,t('Ср')],[4,t('Чт')],[5,t('Пт')],[6,t('Сб')],[0,t('Вс')]]){const b=button(()=>(name),()=>{mask^=1<<bit;b.setAttribute('aria-pressed',String(!!(mask&(1<<bit))));onchange(key,mask)},'day');b.disabled=disabled;b.setAttribute('aria-pressed',String(!!(mask&(1<<bit))));days.append(b)}n.append(days);return n}
    const input=el(type==='select'?'select':'input');input.name=key;bindAttribute(input,'aria-label',()=>label,!!desc.technical);input.disabled=disabled;
    if(type==='select'){for(const [value,text]of desc.options||[]){const option=el('option',null,()=>(text),!!desc.technical);option.value=String(value);input.append(option)}input.value=String(data[key]??desc.options?.[0]?.[0]??'')}
    else if(type==='switch'){input.type='checkbox';input.checked=!!data[key]}
    else{input.type=type;input.value=type==='password'?'':type==='time'?timeValue(data[key]):type==='number'?inputNumber(data[key],desc):String(data[key]??'');if(type==='number')input.step=String(desc.step??'any');if(type==='password'){input.autocomplete='new-password';bindAttribute(input,'placeholder','Оставить прежний')}for(const prop of ['min','max','maxLength','placeholder','required'])if(desc[prop]!==undefined)input[prop]=desc[prop]}
    input.addEventListener(type==='switch'||type==='select'?'change':'input',()=>{let value;if(type==='switch')value=input.checked;else if(type==='time'){const [h,m]=input.value.split(':').map(Number);value=h*60+m}else if(type==='number'||desc.numeric)value=storedNumber(input.value,desc);else value=input.value;onchange(key,value)});n.append(input);return n;
  }
  formCard(title,fields,data,save,{glyph='mdi:tune',wide=false,actions=[],leading=[]}={}){
    const card=this.card(title,glyph,wide),form=el('form'),grid=el('div','form-grid'),patch={};
    let baseline={...data},saving=false;card.classList.add('form-card');
    const controls=el('div','actions'),status=el('span','muted');status.setAttribute('role','status');
    const submit=button(()=>t('Сохранить'),null,'button primary');submit.type='submit';submit.disabled=true;
    const cancel=button(()=>t('Отмена'),()=>{
      if(saving)return;Object.keys(patch).forEach(k=>delete patch[k]);delete card.dataset.dirty;
      submit.disabled=true;cancel.hidden=true;setText(status,()=>'');renderFields();
    });cancel.hidden=true;
    const renderFields=()=>{
      grid.replaceChildren();
      for(const desc of layoutFields(fields,leading))grid.append(this.field(desc,baseline,(key,value)=>{
        if(saving)return;
        if(Object.is(value,baseline[key])||(desc.type==='password'&&value===''))delete patch[key];else patch[key]=value;
        const dirty=Object.keys(patch).length>0;submit.disabled=!dirty;cancel.hidden=!dirty;
        if(dirty)card.dataset.dirty='true';else delete card.dataset.dirty;setText(status,()=>'');
      }));
    };
    renderFields();controls.append(submit,cancel,...actions,status);form.append(grid,controls);card.append(form);
    form.onsubmit=async event=>{
      event.preventDefault();if(saving||submit.disabled||!form.reportValidity())return;
      if(Object.values(patch).some(v=>typeof v==='number'&&!Number.isFinite(v))){setText(status,()=>t('Проверьте числовые поля'));return}
      saving=true;submit.disabled=true;cancel.disabled=true;form.setAttribute('aria-busy','true');
      const inputs=[...grid.querySelectorAll('input,select,button')];inputs.forEach(input=>input.disabled=true);
      setText(status,()=>t('Сохранение…'));
      try{
        const body=Object.fromEntries(Object.entries(patch).filter(([k,v])=>fields.find(f=>f.key===k)?.type!=='password'||v!==''));
        const result=await this.act('form:'+title,()=>save(body),'');baseline={...baseline,...body};
        Object.keys(patch).forEach(k=>delete patch[k]);delete card.dataset.dirty;cancel.hidden=true;
        setText(status,()=>result?.restartRequired?t('Сохранено · нужен перезапуск'):t('Сохранено'));
        for(const input of form.querySelectorAll('input[type=password]'))input.value='';
      }catch(_){setText(status,()=>t('Сохранение не подтверждено'));submit.disabled=false}
      finally{saving=false;cancel.disabled=false;inputs.forEach(input=>input.disabled=false);form.setAttribute('aria-busy','false')}
    };return card;
  }
  modal(title,build,rawTitle=false){this._dialog?.close();this._dialog?.remove();const d=this._dialog=el('dialog'),h=el('div','heading');h.append(el('h1',null,()=>(title),rawTitle),Object.assign(button(()=>(''),()=>d.close(),'icon-button','mdi:close'),{ariaLabel:t('Закрыть')}));d.append(h);build(d);d.addEventListener('close',()=>{d.remove();if(this._dialog===d)this._dialog=null},{once:true});this.shadowRoot.append(d);d.showModal();return d}
  async confirm(title,text,action,{closeOnConfirm=false,confirmLabel=t('Подтвердить'),tone='primary'}={}){
    return new Promise(resolve=>{
      const parent=this._dialog,opener=this.shadowRoot.activeElement||globalThis.document?.activeElement;
      let busy=false,started=false,cancel,accept;
      this._dialog=null;
      const d=this.modal(title,dialog=>{
        dialog.append(el('p','muted',()=>text));
        const actions=el('div','actions');
        cancel=button(()=>t('Отмена'),()=>{if(!busy)dialog.close()});
        accept=button(()=>confirmLabel,async()=>{
          if(started)return;started=true;busy=true;
          accept.disabled=true;cancel.disabled=true;dialog.setAttribute('aria-busy','true');
          const close=dialog.querySelector('.heading button');if(close)close.disabled=true;
          if(closeOnConfirm){resolve(true);dialog.close()}
          try{await action();resolve(true);dialog.close()}
          catch(error){
            if(closeOnConfirm){this.notify(error,true);return}
            const message=el('p','error');message.dataset.confirmError='true';message.setAttribute('role','alert');
            setText(message,()=>errorText(error));dialog.append(message);
            // An ambiguous response may follow an applied command. No replay
            // from this dialog; the user must close it and inspect fresh state.
          }finally{
            busy=false;cancel.disabled=false;if(close)close.disabled=false;
            dialog.setAttribute('aria-busy','false');if(dialog.open)cancel.focus?.();
          }
        },'button '+(tone==='danger'?'danger':'primary'));
        actions.append(cancel,accept);dialog.append(actions);
        dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault()});
      });
      cancel.focus?.();
      d.addEventListener('close',()=>{
        if(parent?.open&&this.isConnected)this._dialog=parent;
        if(opener?.isConnected)opener.focus?.();resolve(false);
      },{once:true});
    });
  }
  modeControl(value,action,disabled=false){const n=el('div','segments');for(const [mode,label]of [['off',t('Выключено')],['auto',t('Авто')],['on',t('Включено')]]){const b=button(()=>(label),async()=>{for(const x of n.children)x.disabled=true;try{await action(mode)}catch(_){}finally{for(const x of n.children)x.disabled=disabled}},'segment');b.dataset.mode=mode;b.setAttribute('aria-pressed',String(value===mode));b.disabled=disabled;n.append(b)}return n}
  stateRow(parent,label,value,rawValue=false){const r=el('div','state-row');r.append(el('span',null,()=>(label)),el('strong',null,()=>{const current=typeof value==='function'?value():value;return current===null||current===undefined?'—':String(current)},rawValue));parent.append(r);return r}
  getCardSize(){return 12}
  getGridOptions(){return {columns:12,rows:'auto',min_columns:6}}
  static getStubConfig(){return {device:'auto',page:'relays'}}
  static getConfigElement(){return document.createElement('power-monitor-device-card-editor')}
}
Object.assign(PowerMonitorDeviceCard.prototype,RelayViews,SettingsViews,IntegrationViews,HardwareViews);
class PowerMonitorDeviceCardEditor extends HTMLElement{
  constructor(){super();this.attachShadow({mode:'open'})}
  setConfig(config){this._config={...config};this.render()}
  set hass(hass){this._hass=hass;if(!this._loading&&!this._devices){this._loading=true;hass.callWS({type:'power_monitor_archive/query',action:'status'}).then(s=>{this._devices=s.devices;this.render()}).catch(()=>{}).finally(()=>this._loading=false)}}
  render(){if(!this._config)return;this.shadowRoot.replaceChildren();for(const [key,label,options]of [['device',t('Устройство'),[['auto',t('Автоматически')],...(this._devices||[]).map(d=>[d.deviceId,d.name])]],['page',t('Начальный раздел'),Object.entries(PAGES).map(([k,[v]])=>[k,v])]]){const l=el('label',null,()=>(label));l.style.cssText='display:grid;gap:8px;margin:16px 0';const s=el('select');s.style.cssText='font:inherit;padding:12px;border-radius:8px;background:var(--card-background-color);color:var(--primary-text-color);border:1px solid var(--divider-color)';for(const [id,title]of options){const o=el('option',null,()=>(title));o.value=id;s.append(o)}s.value=this._config[key]||(key==='device'?'auto':'relays');s.onchange=()=>{this._config={...this._config,[key]:s.value};this.dispatchEvent(new CustomEvent('config-changed',{detail:{config:this._config},bubbles:true,composed:true}))};l.append(s);this.shadowRoot.append(l)}}
}
for(const [name,type]of [['power-monitor-device-card',PowerMonitorDeviceCard],['power-monitor-device-card-editor',PowerMonitorDeviceCardEditor]])if(!customElements.get(name))customElements.define(name,type);
window.customCards=window.customCards||[];if(!window.customCards.some(c=>c.type==='power-monitor-device-card'))window.customCards.push({type:'power-monitor-device-card',name:'Power Monitor · Управление',description:'Реле, инвертор, BMS и настройки устройства',preview:true});
