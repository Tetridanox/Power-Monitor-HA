import {validateSettings,validateRelay,validateTariff,validateTelegram} from './control-validation.js?v=1.0.236';
import {t,locale,setText,setMarkup,bindAttribute,setProfileLanguage,setLanguage,languagePreference,watchLanguage,refreshTranslations} from './i18n.js?v=1.0.236';
import {el,icon,button,errorText,eventTime,eventStamp,eventMeta,searchCities,sameValue,verifyPatch,layoutFields,telegramSettingsPatch,mqttStatus,mqttRetryAvailable,archiveStatus,formatUptime} from './control-ui.js?v=1.0.236';
import {RELAY_GROUPS,RELAY_KEYS,TARIFF_GROUPS,SETTINGS_GROUPS,TELEGRAM_GROUPS,MQTT_FIELDS,REASONS,INVERTER_PROFILES,PROTOCOL_LABELS,EVENT_LABELS,SEVERITY_LABELS,LOGGER_PHASES,DELIVERY_LABELS,pick} from './control-schema.js?v=1.0.236';
import {wait} from './control-api.js?v=1.0.236';
import {updateFirmware,softwareImageVersion} from './control-ota.js?v=1.0.236';
import {exportDialog,importSettings} from './control-backup.js?v=1.0.236';
const modeOf=r=>r.mode==='manual_on'?'on':r.mode==='manual_off'?'off':r.mode;
const finite=patch=>!Object.values(patch).some(v=>typeof v==='number'&&!Number.isFinite(v));
export const RelayViews={
  renderRelays(p){
    const relays=this.data.relays;if(!Array.isArray(relays))throw this.data['relays:error']||new Error(t('Нет данных реле'));
    const tabs=el('div','segments compact'),channels=el('div','stack'),tariff=el('div','stack');tariff.hidden=true;
    for(const [label,node,other]of [[t('Каналы'),channels,tariff],[t('Ночной тариф'),tariff,channels]]){const b=button(()=>(label),()=>{node.hidden=false;other.hidden=true;for(const x of tabs.children)x.setAttribute('aria-pressed',String(x===b))},'segment');b.setAttribute('aria-pressed',String(node===channels));tabs.append(b)}
    channels.append(this.stats([[t('Каналы'),relays.length,'','mdi:electric-switch','relay-count'],[t('Включено'),relays.filter(r=>r.on).length,'','mdi:power','relay-on'],[t('Автоматически'),relays.filter(r=>r.mode==='auto').length,'','mdi:autorenew','relay-auto'],[t('По расписанию'),relays.filter(r=>r.scheduleEnabled).length,'','mdi:clock-outline','relay-schedule']]));
    const grid=el('div','grid');
    for(const relay of relays){const c=el('section','card relay-card');c.dataset.slot=relay.slot;c.dataset.on=String(relay.on);const h=el('div','relay-head'),i=el('div','relay-icon');i.append(icon('mdi:electric-switch'));const name=el('div','relay-name');name.append(el('h2',null,()=>(relay.name||t('Реле ')+(relay.slot+1)),true),el('span','muted',()=>(t('Канал ')+(relay.slot+1))));const tag=el('span','tag'+(relay.on?' on':''),()=>(relay.on?t('Включено'):t('Выключено')));tag.dataset.role='relay-state';const edit=button(()=>(''),()=>this.editRelay(relay.slot),'icon-button','mdi:tune-variant');edit.setAttribute('aria-label',t('Настройки ')+(relay.name||t('реле')));h.append(i,name,tag,edit);
      const control=this.modeControl(modeOf(relay),m=>this.act('relay:'+relay.slot,async()=>{await this.api.post('relays/control',{slot:relay.slot,mode:m});this.data.relays=await this.api.get('relays');this.updateReadings('relays',p)},''),!relay.enabled||relay.externallyControlled);control.dataset.role='relay-mode';const foot=el('div','relay-foot'),reason=el('span','relay-reason');reason.dataset.role='relay-reason';foot.append(reason,el('span',null,()=>('GPIO '+relay.gpio)));c.append(h,control,foot);grid.append(c)}
    const actions=el('div','actions');actions.append(button(()=>(t('Выключить все')),()=>this.confirm(t('Выключить все реле?'),t('Доступные каналы выключатся и перейдут в ручной режим. Расписания и авторежим сохранятся.'),()=>this.act('all-off',async()=>{for(const r of this.data.relays.filter(r=>r.enabled&&!r.externallyControlled))await this.api.post('relays/control',{slot:r.slot,mode:'off'});this.data.relays=await this.api.get('relays');this.updateReadings('relays',p)},t('Реле выключены')),{confirmLabel:t('Выключить реле'),tone:'danger'}),'button danger','mdi:power'));
    channels.append(grid,actions);this.renderTariff(tariff);p.append(tabs,channels,tariff);
  },
  renderTariff(p){
    const data=this.data.tariff;if(!data?.settings){p.append(this.empty(t('Нет данных тарифа')));return}
    const c=this.card(t('Режим тарифа'),'mdi:weather-night',true);c.classList.add('tariff-mode');c.append(this.modeControl(modeOf(data.status),m=>this.act('tariff-mode',async()=>{await this.api.post('tariff/mode',{mode:m});this.data.tariff=await this.api.get('tariff');for(const b of c.querySelectorAll('.segment'))b.setAttribute('aria-pressed',String(b.dataset.mode===modeOf(this.data.tariff.status)))},''),!data.settings.enabled));p.append(c);
    const grid=el('div','grid');for(const [title,fields]of TARIFF_GROUPS){const card=this.formCard(title,fields,data.settings,async patch=>{const current=await this.api.get('tariff');validateTariff({...current.settings,...patch});const result=await this.api.post('tariff/settings',{...current.settings,...patch});this.data.tariff=await this.api.get('tariff');if(Object.entries(patch).some(([k,v])=>!sameValue(this.data.tariff.settings[k],v)))throw new Error(t('Сохранение не подтверждено чтением'));return result});if(title===TARIFF_GROUPS[0][0])card.classList.add('wide','tariff-config');grid.append(card)}p.append(grid);
  },
  editRelay(slot){
    const relay=this.data.relays.find(r=>r.slot===slot);if(!relay)return;
    const draft=pick(relay,RELAY_KEYS),patch={};this.modal(relay.name||t('Реле ')+(slot+1),d=>{const form=el('form');for(const [title,fields]of RELAY_GROUPS){const group=el('details');group.open=title==='Канал';group.append(el('summary',null,()=>(title)));const grid=el('div','form-grid');for(const desc of layoutFields(fields))grid.append(this.field(desc,draft,(k,v)=>{draft[k]=v;patch[k]=v}));group.append(grid);form.append(group)}
      const a=el('div','actions'),save=button(()=>(t('Сохранить')),null,'button primary');save.type='submit';a.append(save);form.append(a);form.onsubmit=async e=>{e.preventDefault();if(!finite(patch)){this.notify(new Error(t('Проверьте числовые поля')),true);return}save.disabled=true;try{await this.act('relay-save:'+slot,async()=>{validateRelay(draft);await this.api.post('relays/settings',{slot,...patch});this.data.relays=await this.api.get('relays');const actual=this.data.relays.find(r=>r.slot===slot);if(!actual||Object.entries(patch).some(([k,v])=>!sameValue(actual[k],v)))throw new Error(t('Сохранение не подтверждено чтением'));this.updateReadings('relays',this.pages.get('relays'))});d.close()}catch(_){save.disabled=false}};d.append(form)},true);
  },
  updateReadings(page,p){
    if(page==='relays'&&Array.isArray(this.data.relays)){
      const stale=!!this.data['relays:error'];
      const rs=this.data.relays;for(const [key,value]of Object.entries({'relay-count':rs.length,'relay-on':rs.filter(r=>r.on).length,'relay-auto':rs.filter(r=>r.mode==='auto').length,'relay-schedule':rs.filter(r=>r.scheduleEnabled).length})){const n=p.querySelector(`[data-live="${key}"]`);if(n)setText(n,()=>value)}
      for(const r of rs){const c=p.querySelector(`[data-slot="${r.slot}"]`);if(!c)continue;c.dataset.stale=String(stale);c.dataset.on=String(!stale&&r.on);setText(c.querySelector('h2'),()=>r.name||t('Реле ')+(r.slot+1));const tag=c.querySelector('[data-role=relay-state]');setText(tag,()=>stale?'—':r.on?t('Включено'):t('Выключено'));tag.classList.toggle('on',r.on);setText(c.querySelector('[data-role=relay-reason]'),()=>r.externallyControlled?t('Управляется тарифом'):r.transitionPending?t('Переключение…'):t(REASONS[r.reason])||t('Состояние уточняется'));for(const b of c.querySelectorAll('[data-mode]')){b.disabled=stale||!r.enabled||r.externallyControlled||this.busy.has('relay:'+r.slot);b.setAttribute('aria-pressed',String(b.dataset.mode===modeOf(r)))}}
    }
    if(page==='telegram')this.updateTelegramDelivery(p);
    if(page==='home-assistant')this.updateConnection(p);
    if(page==='events'&&!p.querySelector('[data-updating]')&&!p.contains(this.shadowRoot?.activeElement))this.renderEvents(p);
    if(page==='bms')this.updateBms(p);
    if(page==='inverter')this.updateInverter(p);
  }
};
export const SettingsViews={
  diagnosticsDialog(){this.modal(t('Система ESP'),d=>{const content=el('div');content.append(this.empty(t('Чтение…')));d.append(content);this.api.get('system').then(data=>{if(!d.open)return;content.replaceChildren();for(const [label,value]of [[t('Версия'),data.firmwareVersion],[t('Время работы'),()=>formatUptime(data.uptimeSeconds)],[t('Свободная память, КБ'),Math.round(data.freeHeapBytes/1024)],[t('Минимум памяти, КБ'),Math.round(data.minimumFreeHeapBytes/1024)]])this.stateRow(content,label,value);const detail=el('details');detail.append(el('summary',null,()=>(t('Диагностика'))),el('pre',null,()=>(JSON.stringify(data,null,2))));content.append(detail);const actions=el('div','actions');actions.append(button(()=>(t('Очистить журнал сбоев')),()=>this.confirm(t('Очистить журнал сбоев на ESP?'),t('Сохранённые сведения о сбоях будут удалены безвозвратно.'),()=>this.act('crash-clear',()=>this.api.post('system/crash-journal/clear',{}),t('Журнал очищен')),{confirmLabel:t('Очистить журнал'),tone:'danger'}),'button danger'));content.append(actions)}).catch(error=>{content.replaceChildren(this.empty(errorText(error)))})})},
  profileCard(settings){
    const card=this.card(t('Инвертор'),'mdi:solar-power'),draft={...settings},patch={};card.classList.add('form-card');
    const match=INVERTER_PROFILES.find(([, ,profile])=>profile.inverterProtocol===settings.inverterProtocol&&profile.inverterInterface===settings.inverterInterface);
    const options=[['custom',t('Текущий профиль')],...INVERTER_PROFILES.map(([id,label])=>[id,label])];
    const model=this.field({key:'profile',label:t('Модель и подключение'),type:'select',options},{profile:match?.[0]||'custom'},(_,value)=>{const profile=value==='custom'?pick(settings,SETTINGS_GROUPS.find(([scope])=>scope==='profile')[2].map(f=>f.key)):INVERTER_PROFILES.find(([id])=>id===value)?.[2];if(!profile)return;Object.keys(patch).forEach(k=>delete patch[k]);Object.assign(draft,profile);Object.assign(patch,profile);for(const input of detail.querySelectorAll('input,select')){if(profile[input.name]!==undefined)input.value=String(profile[input.name])}updateVisibility();save.disabled=false;setText(status,()=>'')});
    const detail=el('details');detail.append(el('summary',null,()=>(t('Параметры связи'))));const grid=el('div','form-grid');
    for(const desc of [{key:'inverterInterface',label:t('Интерфейс'),type:'select',options:[['auto',t('Автоматически')],['rs232','RS232'],['rs485','RS485'],['wifi','Wi-Fi (ANENJI)'],['wifi_tcp','Wi-Fi / TCP']]},{key:'inverterProtocol',label:t('Протокол'),type:'select',options:[...new Map(INVERTER_PROFILES.map(([, ,p])=>[p.inverterProtocol,[p.inverterProtocol,PROTOCOL_LABELS[p.inverterProtocol]||p.inverterProtocol]])).values()]},{key:'inverterBaudRate',label:t('Скорость, бод'),type:'select',numeric:true,options:[0,2400,4800,9600,19200,38400,57600,115200].map(n=>[n,n?String(n):t('Автоматически')])},{key:'inverterModbusAddress',label:t('Адрес Modbus'),type:'number',min:1,max:247,step:1,min:1,max:247},{key:'inverterIp',label:t('IP модуля'),type:'text'},{key:'inverterTcpPort',label:t('TCP порт'),type:'number',min:1,max:65535,step:1,min:1,max:65535}])grid.append(this.field(desc,draft,(k,v)=>{draft[k]=v;patch[k]=v;updateVisibility();save.disabled=false;setText(status,()=>'')}));detail.append(grid);const updateVisibility=()=>{const network=['wifi','wifi_tcp'].includes(draft.inverterInterface);for(const key of ['inverterIp','inverterTcpPort'])grid.querySelector('[name='+key+']').parentElement.hidden=!network;grid.querySelector('[name=inverterBaudRate]').parentElement.hidden=network;grid.querySelector('[name=inverterModbusAddress]').parentElement.hidden=draft.inverterProtocol==='pi30';for(const input of grid.querySelectorAll('input,select'))input.disabled=input.parentElement.hidden};updateVisibility();
    const form=el('form'),actions=el('div','actions'),status=el('span','muted'),save=button(()=>(t('Подключить')),null,'button primary');save.type='submit';save.disabled=true;status.setAttribute('role','status');actions.append(save,button(()=>(t('Wi-Fi модуль')),()=>this.loggerDialog(),'button','mdi:bluetooth'),status);form.append(model,detail,actions);card.append(form);
    form.onsubmit=async event=>{event.preventDefault();if(!form.reportValidity())return;save.disabled=true;try{await this.act('profile',async()=>{if(!finite(patch))throw new Error(t('Проверьте параметры связи'));validateSettings(patch);const result=await this.api.post('settings',patch);this.data.settings=await this.api.get('settings');verifyPatch(this.data.settings,patch);setText(status,()=>result.restartRequired?t('Сохранено · нужен перезапуск'):t('Профиль сохранён'));Object.keys(patch).forEach(k=>delete patch[k])},'')}catch(_){save.disabled=false;setText(status,()=>t('Профиль не подтверждён'))}};
    return card;
  },
  loggerDialog(){
    this.modal(t('Wi-Fi модуль инвертора'),d=>{const draft={mac:''},state=el('div'),list=el('div'),actions=el('div','actions');d.append(this.field({key:'mac',label:t('MAC модуля'),type:'text'},draft,(k,v)=>draft[k]=v),state,list,actions);let busy=false;
      const render=data=>{state.replaceChildren();for(const [label,value]of [[t('Состояние'),LOGGER_PHASES[data.phase]||t('Ожидание')],['PN',data.pn],[t('Текущий сервер'),data.currentEndpoint],[t('Целевой сервер'),data.targetEndpoint],[t('Данные LAN'),data.telemetryVerified?t('Подтверждены'):t('Ожидание')]])this.stateRow(state,label,value||'—');list.replaceChildren();for(const device of data.devices||[])list.append(button(()=>(`${device.pn||t('Модуль')} · ${device.mac}`),()=>{draft.mac=device.mac;d.querySelector('[name=mac]').value=device.mac},'button'))};
      const refresh=async()=>{if(busy||!d.open)return;busy=true;try{render(await this.api.get('inverter/ble-setup'))}catch(e){this.notify(e,true)}finally{busy=false}};
      for(const [action,label]of [['scan',t('Найти')],['probe',t('Проверить')],['configure',t('Настроить LAN')],['restore',t('Вернуть сервер')],['cancel',t('Остановить')]]){const b=button(()=>(label),()=>{const run=()=>this.act('logger',async()=>{const body={action};if(action!=='scan'&&draft.mac)body.mac=draft.mac;await this.api.post('inverter/ble-setup',body);await refresh()},'');if(['configure','restore'].includes(action))this.confirm(label+'?',action==='configure'?t('Модуль будет перенастроен на эту ESP.'):t('Будет восстановлен прежний сервер модуля.'),run,{confirmLabel:label});else run().catch(()=>{})},'button');actions.append(b)}
      const timer=setInterval(refresh,3000);d.addEventListener('close',()=>clearInterval(timer),{once:true});queueMicrotask(refresh);
    });
  },
  forecastCard(settings){
    const fields=SETTINGS_GROUPS.find(([scope])=>scope==='forecast')[2];
    const card=this.formCard(t('Прогноз генерации'),fields,settings,async patch=>{validateSettings(patch);const result=await this.api.post('settings',{...patch,scope:'forecast'});this.data.settings=await this.api.get('settings');verifyPatch(this.data.settings,Object.fromEntries(Object.entries(patch).filter(([k])=>!['wifiPassword','adminPassword','accessPointPassword','forecastApiKey','forecastServerToken'].includes(k))));return result},{glyph:'mdi:weather-sunny',wide:true});
    const form=card.querySelector('form'),city=form.querySelector('[name=forecastCity]'),latitude=form.querySelector('[name=forecastLatitude]'),longitude=form.querySelector('[name=forecastLongitude]'),status=el('div','muted'),results=el('div','city-results');
    status.setAttribute('role','status');results.setAttribute('aria-label',t('Найденные города'));results.id='pm-cities-'+Math.random().toString(36).slice(2);city.setAttribute('aria-controls',results.id);city.setAttribute('aria-autocomplete','list');city.autocomplete='off';city.parentElement.append(status,results);
    const source=form.querySelector('[name=forecastSource]');
    const visibility=()=>{for(const desc of fields){if(desc.key==='forecastSource')continue;const input=form.querySelector('[name='+desc.key+']');const custom=['forecastServerUrl','forecastServerToken'].includes(desc.key);input.closest('.field').hidden=source.value==='off'||(custom?source.value!=='custom':source.value!=='open_meteo');input.disabled=input.closest('.field').hidden}};
    source.addEventListener('change',visibility);visibility();
    let timer,controller,sequence=0,selected=city.value,manual=false;
    const search=async()=>{const query=city.value.trim(),own=++sequence;controller?.abort();results.replaceChildren();if(query.length<2){setText(status,()=>query?t('Введите хотя бы 2 символа'):'');return}setText(status,()=>t('Поиск города…'));controller=new AbortController();const timeout=setTimeout(()=>controller?.abort(),8000);
      try{const cities=await searchCities(query,controller.signal);if(own!==sequence||!card.isConnected)return;setText(status,()=>cities.length?t('Выберите город'):t('Город не найден'));
        for(const item of cities)results.append(button(()=>(item.label),()=>{city.value=item.name;city.dispatchEvent(new Event('input',{bubbles:true}));selected=item.name;for(const [input,value]of [[latitude,item.latitude],[longitude,item.longitude]]){input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}))}clearTimeout(timer);controller?.abort();++sequence;results.replaceChildren();setText(status,()=>t('Координаты подставлены'))},'button city-option',undefined,true));
      }catch(error){if(own===sequence&&card.isConnected)setText(status,()=>error.name==='AbortError'?t('Поиск не завершился. Повторите ввод'):t('Не удалось найти город. Проверьте интернет'))}finally{clearTimeout(timeout)}
    };
    city.addEventListener('input',()=>{clearTimeout(timer);controller?.abort();++sequence;selected='';manual=false;results.replaceChildren();timer=setTimeout(search,400)});
    for(const input of [latitude,longitude])input.addEventListener('input',()=>{manual=true});
    const submit=form.onsubmit;form.onsubmit=event=>{if(city.value.trim()!==String(settings.forecastCity||'').trim()&&!selected&&!manual){event.preventDefault();setText(status,()=>t('Выберите город из списка или задайте координаты'));city.focus();return}return submit(event)};
    city.addEventListener('keydown',event=>{if(event.key==='ArrowDown'&&results.firstChild){event.preventDefault();results.firstChild.focus()}if(event.key==='Escape'){clearTimeout(timer);controller?.abort();++sequence;results.replaceChildren();setText(status,()=>'')}});
    card.dataset.pmCleanup='';card._cleanup=()=>{clearTimeout(timer);controller?.abort();++sequence};return card;
  },
  renderSettings(p){
    const settings=this.data.settings;if(!settings)throw this.data['settings:error']||new Error(t('Нет настроек'));
    const grid=el('div','grid');
    for(const [scope,title,fields]of SETTINGS_GROUPS){if(scope==='profile'){grid.append(this.profileCard(settings));continue}if(scope==='forecast'){grid.append(this.forecastCard(settings));continue}const resolved=fields;grid.append(this.formCard(title,resolved,settings,async patch=>{validateSettings(patch);const result=await this.api.post('settings',{...patch,...(['device','forecast'].includes(scope)?{scope}:{})});this.data.settings=await this.api.get('settings');verifyPatch(this.data.settings,Object.fromEntries(Object.entries(patch).filter(([k])=>!['wifiPassword','adminPassword','accessPointPassword','forecastApiKey','forecastServerToken'].includes(k))));return result},{glyph:{device:'mdi:chip',profile:'mdi:solar-power',network:'mdi:wifi',security:'mdi:lock-outline',forecast:'mdi:weather-sunny'}[scope],wide:scope==='forecast',actions:scope==='network'?[button(()=>(t('Найти сети')),()=>this.scanWifi(),'button','mdi:magnify')]:[]}))}
    const service=this.card(t('Система'),'mdi:cog-outline',true),a=el('div','actions');a.append(button(()=>(t('Резервная копия')),()=>exportDialog(this),'button','mdi:download'),button(()=>(t('Восстановить')),()=>importSettings(this),'button','mdi:upload'),button(()=>(t('Диагностика')),()=>this.diagnosticsDialog(),'button','mdi:chip'),button(()=>(t('Перезапустить')),()=>this.confirm(t('Перезапустить ESP?'),t('Связь и автоматическое управление временно прервутся. Настройки сохраняются.'),()=>this.act('restart',()=>this.api.post('system/restart',{}),t('Перезапуск запрошен')),{confirmLabel:t('Перезапустить')}),'button','mdi:restart'));service.append(a);
    grid.append(service,this.softwareUpdateCard());p.append(grid);
  },
  softwareUpdateCard(){
    const card=this.card(t('Обновление ПО'),'mdi:chip',true);card.classList.add('firmware-card');
    card.append(el('p','firmware-description',()=>t('Выберите файл ПО .bin для вашей платы. Во время обновления не отключайте питание.')));
    const versionBlock=label=>{const block=el('div','software-version');block.append(el('span',null,()=>label),el('strong',null,()=>'—'));return block};
    const versions=el('div','software-versions'),current=versionBlock(t('Текущая версия')),candidate=versionBlock(t('Версия в файле'));versions.append(current,candidate);
    this.api.get('system').then(data=>{if(card.isConnected)setText(current.lastChild,()=>data.firmwareVersion||'—')}).catch(()=>{});
    const file=el('input');file.type='file';file.accept='.bin';file.hidden=true;file.setAttribute('aria-label',t('Файл ПО'));
    const label=el('div','field firmware-file'),chooser=el('div','software-file-choice'),identity=el('div','software-file-identity'),filename=el('strong',null,()=>t('Файл не выбран')),fileInfo=el('span','muted',()=>t('Файл ПО .bin'));identity.append(filename,fileInfo);
    const choose=button(()=>t('Выбрать файл'),()=>file.click(),'button','mdi:folder-open-outline'),clear=button(()=>t('Убрать'),()=>{file.value='';file.onchange()},'button');clear.hidden=true;
    chooser.append(icon('mdi:file-code-outline'),identity,choose,clear);label.append(el('span',null,()=>t('Файл ПО')),chooser,file);
    const transfer=el('div','software-progress');transfer.hidden=true;
    const stage=el('div','software-progress-heading'),stageText=el('strong',null,()=>t('Подготовка…')),percent=el('strong',null,()=>'0%');stage.append(stageText,percent);
    const progress=el('progress');progress.max=100;progress.value=0;
    const metrics=el('div','software-metrics'),sent=el('span'),speed=el('span'),remaining=el('span');metrics.append(sent,speed,remaining);transfer.append(stage,progress,metrics);
    const status=el('div','firmware-status');status.setAttribute('role','status');let selection=0,selectedFile=null;
    const upload=button(()=>t('Обновить'),()=>{
      const image=selectedFile;if(!image||image!==file.files?.[0])return;
      this.confirm(t('Обновить ПО?'),t('Не отключайте питание до завершения обновления.'),()=>this.act('firmware',async()=>{
        this._updatingFirmware=true;upload.disabled=true;file.disabled=true;choose.disabled=true;clear.disabled=true;transfer.hidden=false;setText(status,()=>'');
        try{await updateFirmware(this.api,image,(pct,message,info)=>{
          progress.value=pct;setText(percent,()=>pct+'%');setText(stageText,()=>info?.stage==='upload'?t('Передача ПО'):message);
          if(!info){setText(status,()=>message);return}
          const elapsed=info.elapsedMs/1000,rate=elapsed>0?info.received/elapsed:0,eta=rate>0?Math.ceil((info.total-info.received)/rate):null;
          setText(sent,()=>t('Передано')+' '+(info.received/1048576).toLocaleString(locale(),{maximumFractionDigits:2})+' / '+(info.total/1048576).toLocaleString(locale(),{maximumFractionDigits:2})+' '+t('МБ'));
          setText(speed,()=>t('Скорость')+': '+(rate/1024).toLocaleString(locale(),{maximumFractionDigits:1})+' '+t('КБ/с'));
          setText(remaining,()=>info.stage==='upload'?t('Осталось')+': '+(eta===null?'—':Math.floor(eta/60)+':'+String(eta%60).padStart(2,'0')):'');
        })}finally{this._updatingFirmware=false;upload.disabled=!selectedFile;file.disabled=false;choose.disabled=false;clear.disabled=false}
      },t('ПО обновлено')),{closeOnConfirm:true});
    },'button primary');upload.disabled=true;
    file.onchange=async()=>{
      const own=++selection,image=file.files?.[0];selectedFile=null;upload.disabled=true;transfer.hidden=true;progress.value=0;clear.hidden=!image;chooser.dataset.selected=String(!!image);
      setText(filename,()=>image?.name||t('Файл не выбран'));setText(fileInfo,()=>image?(image.size/1048576).toLocaleString(locale(),{maximumFractionDigits:2})+' '+t('МБ') :t('Файл ПО .bin'));
      setText(candidate.lastChild,()=>image?t('Чтение…'):'—');setText(status,()=>'');if(!image)return;
      try{
        const version=await softwareImageVersion(image);if(own!==selection||!card.isConnected)return;
        setText(candidate.lastChild,()=>version||t('Не определена'));
        setText(status,()=>version?'':t('В файле нет доступной информации о версии.'));
        selectedFile=image;upload.disabled=false;
      }catch(error){if(own!==selection||!card.isConnected)return;setText(candidate.lastChild,()=>'—');setText(status,()=>errorText(error))}
    };
    const actions=el('div','actions');actions.append(upload);card.append(versions,label,actions,transfer,status);return card;
  },
  scanWifi(){
    this.modal(t('Сети Wi-Fi'),d=>{
      const results=el('div','wifi-results'),status=el('p','muted');status.setAttribute('role','status');
      const retry=button(()=>(t('Повторить поиск')),()=>start(),'button','mdi:refresh'),actions=el('div','actions');actions.append(retry);d.append(status,results,actions);
      const epoch=this.epoch;
      const start=()=>{if(this.busy.has('wifi-scan'))return;retry.disabled=true;results.replaceChildren();setText(status,()=>t('Поиск сетей…'));
        this.run('wifi-scan',async()=>{
          try{
            await this.api.post('wifi/scan',{});
            for(let i=0;i<30&&d.open&&epoch===this.epoch;i++){
              await wait(1000);const data=await this.api.get('wifi/networks');if(!d.open||epoch!==this.epoch)return;
              results.replaceChildren();
              for(const n of (data.networks||[]).filter(n=>n.ssid).sort((a,b)=>b.rssi-a.rssi)){
                const b=button(()=>(n.ssid),()=>{const input=this.pages.get('settings')?.querySelector('[name=wifiSSID]');if(!input)return;input.value=n.ssid;input.dispatchEvent(new Event('input',{bubbles:true}));d.close();input.focus();setText(input.closest('form').querySelector('[role=status]'),()=>t('Сеть выбрана · сохраните настройки'))},'button wifi-network',n.secure?'mdi:wifi-lock':'mdi:wifi',true);
                b.append(el('span','muted',()=>(n.rssi+' dBm')));results.append(b);
              }
              setText(status,()=>data.scanning?t('Поиск сетей…'):results.children.length?t('Выберите сеть'):t('Сети не найдены'));
              if(!data.scanning)return;
            }
            if(d.open)setText(status,()=>t('Поиск не завершился. Повторите попытку'));
          }catch(error){if(d.open)setText(status,()=>errorText(error))}finally{retry.disabled=false}
        },'');
      };
      // modal() calls its builder before showModal(); start after d.open is true.
      queueMicrotask(start);
    });
  }

};
export const IntegrationViews={
  async saveTelegram(patch){const current=this.data.telegram||{};validateTelegram({...current,...current.thresholds,...patch});patch=telegramSettingsPatch(patch);const result=await this.api.post('telegram/settings',patch);const data=this.data.telegram=await this.api.get('telegram');verifyPatch({...data,...data.notifications,...data.thresholds},Object.fromEntries(Object.entries(patch).filter(([k])=>k!=='token')));return result},
  renderTelegram(p){
    const commands=el('power-monitor-telegram-commands');commands.device=this._device.deviceId;commands.hass=this._hass;p.append(commands);
    const data=this.data.telegram;if(!data){p.append(this.notice(t('Нет данных Telegram')));return}
    const flat={...data,...data.notifications,...data.thresholds},grid=el('div','grid');
    const bot=this.formCard(TELEGRAM_GROUPS[0][0],TELEGRAM_GROUPS[0][1],flat,patch=>this.saveTelegram(patch),{glyph:'mdi:send',wide:true,leading:['enabled']});bot.classList.add('telegram-bot');grid.append(bot);
    const profiles=this.card(t('Получатели'),'mdi:account-multiple-outline',true),list=el('div','recipient-list'),values=(data.profiles||[]).map(x=>({...x}));
    const save=button(()=>(t('Сохранить')),()=>this.run('profiles',async()=>{await this.saveTelegram({profiles:values});save.disabled=true},t('Получатели сохранены')),'button primary');save.disabled=true;
    const changed=()=>{save.disabled=false};
    const render=(openIndex=-1)=>{add.disabled=values.length>=10;list.replaceChildren();values.forEach((profile,index)=>{
      const row=el('details','recipient');row.open=index===openIndex;const heading=el('summary'),identity=el('span','recipient-identity'),name=el('strong',null,()=>(profile.name||t('Получатель ')+(index+1)),true),id=el('span','muted',()=>(profile.chatId||t('ID чата не указан'))),status=el('span','tag'+(profile.enabled?' on':''),()=>(profile.enabled?t('Включён'):t('Выключен')));identity.append(name,id);heading.append(identity,status);row.append(heading);
      const fields=el('div','form-grid');for(const desc of [{key:'name',label:t('Имя'),type:'text',required:true},{key:'chatId',label:t('ID чата'),type:'text',required:true,maxLength:23},{key:'enabled',label:t('Получать сообщения'),type:'switch'}])fields.append(this.field(desc,profile,(k,v)=>{profile[k]=v;changed();setText(name,()=>profile.name||t('Получатель ')+(index+1));setText(id,()=>profile.chatId||t('ID чата не указан'));setText(status,()=>profile.enabled?t('Включён'):t('Выключен'));status.classList.toggle('on',profile.enabled)}));
      const permissionGrid=el('div','recipient-permissions');[t('Пропала сеть'),t('Сеть восстановлена'),t('Низкий заряд'),t('Полный заряд'),t('BMS отключена'),t('BMS подключена'),t('Инвертор отключён'),t('Инвертор подключён'),t('Перезапуск'),t('Ежедневный отчёт'),t('Недельный отчёт'),null,null,t('Состояние реле')].forEach((label,bit)=>{if(label===null)return;permissionGrid.append(this.field({key:String(bit),label,type:'switch'},{[bit]:!!(profile.permissions&(1<<bit))},(_,on)=>{profile.permissions=on?profile.permissions|(1<<bit):profile.permissions&~(1<<bit);changed()}))});
      row.append(fields,el('h3','recipient-caption',()=>(t('Уведомления и доступ'))),permissionGrid,button(()=>(t('Удалить получателя')),()=>{values.splice(index,1);changed();render()},'button danger','mdi:delete-outline'));list.append(row)
    });if(!values.length)list.append(el('p','compact-empty',()=>(t('Получателей пока нет'))))};
    const actions=el('div','actions');const add=button(()=>(t('Добавить получателя')),()=>{if(values.length>=10)return;values.push({name:'',chatId:'',enabled:true,permissions:16383});changed();render(values.length-1)},'button','mdi:plus');actions.append(add,save,button(()=>(t('Тестовое сообщение')),()=>this.run('telegram-test',()=>this.api.post('telegram/test',{}),t('Сообщение поставлено в очередь'))));render();profiles.append(list,actions);grid.append(profiles);
    const thresholds=this.formCard(TELEGRAM_GROUPS[2][0],TELEGRAM_GROUPS[2][1],flat,patch=>this.saveTelegram(patch),{glyph:'mdi:tune-variant',wide:true});thresholds.classList.add('telegram-thresholds');grid.append(thresholds);
    const delivery=this.card(t('Доставка'),'mdi:message-check-outline',true),body=el('div');body.dataset.telegramDelivery='';delivery.append(body);grid.append(delivery);const notifications=el('details','card wide');notifications.style.marginTop='20px';notifications.append(el('summary',null,()=>t('Уведомления ESP')),grid);p.append(notifications);this.updateTelegramDelivery(p);
  },
  updateTelegramDelivery(p){
    const data=this.data.telegram,journal=p.querySelector('[data-telegram-delivery]');if(!journal||!data)return;
    const signature=JSON.stringify([data.queueSize,data.log]);if(journal.dataset.signature===signature)return;const wasOpen=!!journal.querySelector('details')?.open;journal.dataset.signature=signature;journal.replaceChildren();
    const queue=el('div','delivery-status');queue.append(el('span','muted',()=>(t('В очереди'))),el('strong',null,()=>(Number(data.queueSize)||0)));
    const clear=button(()=>(t('Очистить очередь')),()=>this.run('telegram-clear',async()=>{await this.api.post('telegram/clear',{});this.data.telegram=await this.api.get('telegram');this.updateTelegramDelivery(p)},t('Очередь очищена')),'button');clear.disabled=!(Number(data.queueSize)>0);queue.append(clear);journal.append(queue);
    const entries=(data.log||[]).slice(0,30);if(entries.length){const history=el('details');history.append(el('summary',null,()=>(t('Последние сообщения'))));const log=el('div','log');for(const e of entries){const row=el('div','log-item');row.append(el('time',null,()=>(e.timestamp?new Date(e.timestamp*1000).toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit'}):'—')),el('span',null,()=>(e.text||e.chatId),true),el('span','tag',()=>(DELIVERY_LABELS[e.status]||t('Статус уточняется'))));log.append(row)}history.open=wasOpen;history.append(log);journal.append(history)}else if(!Number(data.queueSize)){setText(queue.firstChild,()=>t('Сообщений пока нет'));queue.querySelector('strong').hidden=true}
  },
  renderConnection(p){
    const archive=this.data.archive,mqtt=this.data['home-assistant/settings'],grid=el('div','grid'),native=this.card(t('Подключение и доступ'),'mdi:home-assistant');this.stateRow(native,t('Устройство'),this._device.name,true);this.stateRow(native,t('Доступ'),archiveStatus(archive,this.data['archive:error']).label).lastChild.dataset.connectionStatus='native';this.stateRow(native,t('История'),t('Архив HA'));const local=el('a','button',()=>(t('Открыть ESP')));local.href=this._device.localUrl;local.target='_blank';local.rel='noopener';const a=el('div','actions');a.append(local);native.append(a);grid.append(native);
    grid.append(this.formCard(t('Основной интерфейс'),[{key:'mode',label:t('Открывать pm.local в'),type:'select',options:[['ha','Home Assistant'],['esp',t('На ESP')]]}],{mode:archive?.interfaceUrl?'ha':'esp'},patch=>this._hass.callWS({type:'power_monitor_archive/query',action:'interface',device:this._device.deviceId,url:patch.mode==='ha'?window.location.origin+'/power-monitor?device='+this._device.deviceId:''}),{glyph:'mdi:monitor-dashboard'}));
    const disclosure=(title,description,glyph,key)=>{const details=el('details','card wide integration-disclosure'),summary=el('summary'),identity=el('span','integration-identity'),status=el('span','tag');identity.append(el('strong',null,()=>title),el('span','muted',()=>description));status.dataset.connectionStatus=key;status.setAttribute('role','status');summary.append(icon(glyph),identity,status);details.append(summary);const body=el('div','integration-body');details.append(body);grid.append(details);return body};
    const mqttBody=disclosure('MQTT',t('Дополнительное подключение через брокер'),'mdi:connection','mqtt');
    if(mqtt){mqttBody.append(this.formCard(t('Брокер'),MQTT_FIELDS,mqtt,async patch=>{const result=await this.saveMqtt(patch);this.updateConnection(p);return result},{actions:[button(()=>(t('Повторить подключение')),()=>this.run('mqtt-retry',async()=>{await this.retryMqtt();this.updateConnection(p)},t('Подключение запрошено')),'button mqtt-retry')]}))}else mqttBody.append(this.empty(t('Нет свежих данных')));
    const advanced=disclosure(t('Доступ интеграции'),t('Подключение по коду и отзыв доступа Home Assistant'),'mdi:shield-key-outline','archive');const actions=el('div','actions');actions.append(button(()=>(t('Новый код')),()=>this.run('pair-code',async()=>{const result=await this.api.post('archive',undefined,{'X-Archive-Command':'begin'});this.modal(t('Код подключения'),d=>{const input=el('input','file');input.value=result.pairingCode;input.readOnly=true;input.setAttribute('aria-label',t('Код подключения'));const a=el('div','actions');a.append(button(()=>(t('Скопировать')),async()=>{try{await navigator.clipboard.writeText(input.value);this.notify(t('Код скопирован'))}catch(_){input.focus();input.select()}},'button primary'));d.append(input,el('p','muted',()=>(t('Действует 2 минуты'))),a)})},''),'button','mdi:key-outline'),button(()=>(t('Отозвать доступ')),()=>this.confirm(t('Отозвать доступ HA?'),t('Управление из HA прекратится. Для подключения потребуется новый код с ESP. Архив измерений сохранится.'),()=>this.act('revoke',async()=>{const current=await this.api.get('archive');await this.api.post('archive',{revision:current.revision},{'X-Archive-Command':'revoke'})},t('Отзыв запрошен')),{confirmLabel:t('Отозвать доступ'),tone:'danger'}),'button danger'));advanced.append(actions);p.append(grid);this.updateConnection(p);
  },
  async retryMqtt(){
    await this.api.post('home-assistant/retry');
    this.data['home-assistant/settings']=await this.api.get('home-assistant/settings');
    this.data['home-assistant/settings:error']=null;
  },
  async saveMqtt(patch){
    const current=await this.api.get('home-assistant/settings');
    const body={enabled:current.enabled,port:current.port,...patch};
    const result=await this.api.post('home-assistant/settings',body);
    this.data['home-assistant/settings']=await this.api.get('home-assistant/settings');
    this.data['home-assistant/settings:error']=null;
    verifyPatch(this.data['home-assistant/settings'],Object.fromEntries(Object.entries(body).filter(([k])=>k!=='password')));
    return result;
  },
  updateConnection(p){
    const retry=p.querySelector('.mqtt-retry');if(retry)retry.disabled=!mqttRetryAvailable(this.data['home-assistant/settings'],this.data['home-assistant/settings:error']);
    const mqtt=mqttStatus(this.data['home-assistant/settings'],this.data['home-assistant/settings:error']),archive=archiveStatus(this.data.archive,this.data['archive:error']);
    for(const node of p.querySelectorAll('[data-connection-status]')){const status=node.dataset.connectionStatus==='mqtt'?mqtt:archive;setText(node,()=>status.label);node.classList.toggle('on',status.tone==='online');node.dataset.tone=status.tone}
  },
  renderEvents(p){
    const data=this.data.events;p.replaceChildren();p.dataset.updating='true';
    const c=this.card(t('Журнал'),'mdi:history',true),actions=el('div','actions event-actions');
    actions.append(button(()=>(t('Обновить')),()=>this.refresh(),'button','mdi:refresh'),button(()=>(t('Очистить')),()=>this.confirm(t('Очистить журнал событий на ESP?'),t('Будет удалён журнал событий устройства. Архив измерений (история графиков) не затрагивается.'),()=>this.act('events-clear',async()=>{await this.api.post('events/clear',{});this.data.events=await this.api.get('events');this.renderEvents(p)},t('Журнал очищен')),{confirmLabel:t('Очистить журнал'),tone:'danger'}),'button danger','mdi:delete-outline'));
    if(!data){c.append(this.empty(errorText(this.data['events:error'])));p.append(c);delete p.dataset.updating;return}
    const levels={info:[t('Информация'),'mdi:information-outline'],warning:[t('Предупреждение'),'mdi:alert-outline'],critical:[t('Критично'),'mdi:alert-octagon-outline'],recovery:[t('Восстановление'),'mdi:check-circle-outline']};
    const categories={all:t('Все'),grid:t('Сеть'),inverter:t('Инвертор'),bms:'BMS',wifi:'Wi-Fi',system:t('Система')};
    const filters=p._eventFilters||(p._eventFilters={hidden:new Set(),category:'all'}),events=[...(data.events||[])].reverse().map(e=>{
      const stamp=eventStamp(e,data),rawStamp=Number(e.timestamp)||0;
      // UX-09: a stamp derived from the uptime counter is honest but
      // approximate — mark it instead of presenting it as recorded time.
      return {...e,...eventMeta(e),stamp,reconstructed:stamp>=1700000000&&rawStamp<1700000000};});
    const summary=el('div','event-levels'),sources=el('div','segments compact event-sources'),list=el('div','event-timeline'),count=el('span','muted');count.setAttribute('role','status');actions.append(count);
    const tools=el('div','form-grid event-search');
    for(const [key,label,type]of [['search','Поиск событий','search'],['from','Дата с','date'],['to','Дата по','date']]){
      const field=el('label','field'),input=el('input');input.type=type;input.value=filters[key]||'';bindAttribute(input,'aria-label',()=>t(label));
      field.append(el('span',null,()=>t(label)),input);tools.append(field);input.oninput=()=>{filters[key]=input.value;draw()};
    }
    const draw=()=>{list.replaceChildren();const shown=events.filter(e=>{
      if(filters.hidden.has(e.severity)||(filters.category!=='all'&&e.category!==filters.category))return false;
      if(filters.search&&!`${t(EVENT_LABELS[e.code])} ${categories[e.category]} ${e.measurement}`.toLocaleLowerCase().includes(filters.search.trim().toLocaleLowerCase()))return false;
      if(filters.from||filters.to){if(e.stamp<1700000000)return false;const date=new Date(e.stamp*1000),day=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;if(filters.from&&day<filters.from||filters.to&&day>filters.to)return false}return true;
    });setText(count,()=>shown.length+' / '+events.length);
      let previousDay;for(const event of shown){const synced=event.stamp>=1700000000,date=synced?new Date(event.stamp*1000):null,day=date?date.toLocaleDateString(locale(),{day:'numeric',month:'long',year:'numeric'}):t('До синхронизации времени');
        if(day!==previousDay){list.append(el('h3','event-day',()=>(day)));previousDay=day}
        const row=el('div','event-entry '+event.severity),symbol=el('div','event-symbol');symbol.append(icon(levels[event.severity][1]));const body=el('div','event-body');body.append(el('strong',null,()=>(t(EVENT_LABELS[event.code])||t('Событие устройства'))),el('span','muted',()=>(categories[event.category]+(event.measurement?' · '+event.measurement:''))));
        const time=el('time',null,()=>(date?(event.reconstructed?t('≈ ')+date.toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit',second:'2-digit'}):date.toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit',second:'2-digit'})):'+'+(Number(event.uptimeSeconds)||0)+t(' с')));
        if(date){time.dateTime=date.toISOString();if(event.reconstructed)time.title=t('Время восстановлено по счётчику аптайма — приблизительное')}row.append(symbol,body,time);list.append(row)}
      if(!shown.length)list.append(el('p','compact-empty',()=>(events.length?t('Нет событий по выбранным фильтрам'):t('Событий пока нет'))));
    };
    for(const [key,[label,glyph]]of Object.entries(levels)){const b=button(()=>(''),()=>{filters.hidden.has(key)?filters.hidden.delete(key):filters.hidden.add(key);b.setAttribute('aria-pressed',String(!filters.hidden.has(key)));draw()},'event-level '+key,glyph);b.append(el('span',null,()=>(label)),el('strong',null,()=>(events.filter(e=>e.severity===key).length)));b.setAttribute('aria-pressed',String(!filters.hidden.has(key)));summary.append(b)}
    for(const [key,label]of Object.entries(categories)){const b=button(()=>(label),()=>{filters.category=key;for(const n of sources.children)n.setAttribute('aria-pressed',String(n===b));draw()},'segment');b.setAttribute('aria-pressed',String(filters.category===key));sources.append(b)}
    c.append(summary,sources,tools,actions,list);draw();p.append(c);delete p.dataset.updating;
  }
};
