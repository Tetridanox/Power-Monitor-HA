import {validateUtf8} from './control-validation.js?v=1.0.236';
import {t,technical,locale,setText,setMarkup,bindAttribute,setProfileLanguage,setLanguage,languagePreference,watchLanguage,refreshTranslations} from './i18n.js?v=1.0.236';
import {el,icon,button,fmt,sameValue,errorText,inverterInputValue} from './control-ui.js?v=1.0.236';
import {BMS_GROUPS,LABELS,inverterOptions,inverterValue,PROTOCOL_LABELS,INTERFACE_LABELS} from './control-schema.js?v=1.0.236';
import {wait,ticketResult} from './control-api.js?v=1.0.236';
const near=(a,b)=>Number.isFinite(Number(a))&&Number.isFinite(Number(b))?sameValue(Number(a),Number(b)):String(a)===String(b);
const bmsSettingWritable=key=>!['voltageCalibration','currentCalibration','emergencyEnabled'].includes(key);
export const inverterSettingsUnsupported=error=>(error?.data?.error||error?.message)==='inverter_profile_not_pi30';
export function inverterParameterGroups(settings){
  const supported=new Set(settings.writableFields||settings.supportedFields||[]),editable=[],reference=[];
  for(const entry of Object.entries(settings.values||{})){
    if(entry[1]===null||entry[1]===undefined||!LABELS[entry[0]])continue;
    (settings.supportsWrite&&supported.has(entry[0])?editable:reference).push(entry);
  }
  return {editable,reference};
}
const inverterViewKey=data=>{const s=data['inverter/settings'],error=data['inverter/settings:error'];return JSON.stringify([s?.source,s?.profile,s?.available,s?.supportsWrite,s?.expertUnlocked,Object.keys(s?.values||{}),data['inverter/link']?.configuredProtocol,error?.data?.error||error?.message||''])};
export function bmsDiscoveryItems(result,selected=''){
  const unique=new Map();
  for(const item of (Array.isArray(result)?result:result?.devices||[])){
    const address=String(item.address||item.mac||item.macAddress||'').toUpperCase();
    if(!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(address))continue;
    const current=unique.get(address);
    if(!current||Number(item.rssi??-200)>Number(current.rssi??-200))unique.set(address,{...item,address});
  }
  const chosen=String(selected||'').toUpperCase();
  return [...unique.values()].sort((a,b)=>Number(b.address===chosen)-Number(a.address===chosen)||Number(b.rssi??-200)-Number(a.rssi??-200)||a.address.localeCompare(b.address));
}
export const INVERTER_READINGS=[
 ['gridVoltage','Grid voltage','V',1],['gridFrequency','Grid frequency','Hz',1],
 ['outputVoltage','Output voltage','V',1],['outputFrequency','Output frequency','Hz',1],
 ['acOutputPower','AC output power','W',0],['loadApparentPower','Apparent power','VA',0],
 ['loadPercent','Load','%',0],['loadPowerFactor','Power factor','',2],
 ['pvVoltage','PV voltage','V',1],['pvCurrent','PV current','A',2],
 ['inverterBatteryVoltage','Inverter battery voltage','V',2],['batteryChargingCurrent','Charging current','A',1],
 ['batteryDischargingCurrent','Discharging current','A',1],['sccBatteryVoltage','SCC battery voltage','V',2],
 ['inverterBatteryCapacity','Inverter SOC','%',0],['busVoltage','BUS voltage','V',0]
];
export const HardwareViews={
  renderInverter(p){
    p.dataset.inverterView=inverterViewKey(this.data);
    const settings=this.data['inverter/settings:error']?null:this.data['inverter/settings'],link=this.data['inverter/link'];
    const readings=this.data['telemetry?channel=inverter']?.payload,live=readings?.available?readings:null;
    p.append(this.stats([[t('Нагрузка'),fmt(live?.loadPower),t('Вт'),'mdi:home-lightning-bolt','inv-load'],[t('Сеть'),fmt(live?.gridVoltage,1),t('В'),'mdi:transmission-tower','inv-grid'],[t('Солнце'),fmt(live?.pvPower),t('Вт'),'mdi:solar-power','inv-pv'],[t('Температура'),fmt(live?.inverterTemperature,1),'°C','mdi:thermometer','inv-temperature']]));
    const grid=el('div','grid'),connection=this.card(t('Подключение'),'mdi:solar-power',true);
    this.stateRow(connection,t('Профиль'),settings?.profile||PROTOCOL_LABELS[link?.configuredProtocol]||'—',true);this.stateRow(connection,t('Обмен'),link?.responding?t('Данные поступают'):t('Нет данных'));this.stateRow(connection,t('Интерфейс'),INTERFACE_LABELS[link?.configuredInterface]||'—');grid.append(connection);
    this.stateRow(connection,t('Настройки'),settings?(settings.supportsWrite?t('Чтение и запись'):t('Только чтение')):inverterSettingsUnsupported(this.data['inverter/settings:error'])?t('Мониторинг'):t('Недоступны'));
    const monitoring=this.card(t('Показатели'),'mdi:chart-line',true),readingsGrid=el('div','readings');
    for(const [key,label,unit,digits]of INVERTER_READINGS){const reading=el('div','reading');reading.append(el('span',null,label,true),el('strong'));const value=reading.lastChild;value.dataset.inverterReading=key;value.dataset.unit=unit;value.dataset.digits=digits;setText(value,()=>fmt(live?.[key],digits)+(Number.isFinite(live?.[key])&&unit?' '+unit:''));readingsGrid.append(reading)}monitoring.append(readingsGrid);grid.append(monitoring);
    if(!settings){if(!inverterSettingsUnsupported(this.data['inverter/settings:error']))connection.append(this.notice(t('Настройки инвертора временно недоступны.')));p.append(grid);return}
    const c=this.card(t('Параметры инвертора'),'mdi:tune',true),actions=el('div','actions');actions.style.marginTop='0';actions.style.marginBottom='22px';
    const unlock=button(()=>(settings.expertUnlocked?t('Заблокировать'):t('Разблокировать')),()=>{if(settings.expertUnlocked){this.run('inv-lock',async()=>{await this.api.post('inverter/expert',{confirmation:'LOCK'});this.data['inverter/settings']=await this.api.get('inverter/settings');this.renderPage('inverter',true)},'');return}this.modal(t('Экспертный доступ'),d=>{d.append(this.notice(t('Изменение параметров может прервать питание или повредить батарею.')));const draft={confirmation:''},field=this.field({key:'confirmation',label:t('Введите UNLOCK'),type:'text'},draft,(k,v)=>draft[k]=v);const a=el('div','actions');a.append(button(()=>(t('Разблокировать')),()=>this.run('inv-unlock',async()=>{if(draft.confirmation!=='UNLOCK')throw new Error(t('Введите UNLOCK'));await this.api.post('inverter/expert',{confirmation:'UNLOCK'});this.data['inverter/settings']=await this.api.get('inverter/settings');this.renderPage('inverter',true);d.close()},''),'button primary'));d.append(field,a)})},'button',settings.expertUnlocked?'mdi:lock-open-outline':'mdi:lock-outline');unlock.disabled=!settings.available||!settings.supportsWrite;
    const refresh=button(()=>(''),()=>this.run('inv-refresh',async()=>{this.data['inverter/settings']=await this.refreshInverterSettings();this.renderPage('inverter',true)},t('Данные обновлены')),'icon-button','mdi:refresh');refresh.title=t('Обновить параметры');refresh.setAttribute('aria-label',t('Обновить параметры'));c.querySelector('.card-head>ha-icon')?.remove();c.querySelector('.card-head').append(refresh);
    const groups=inverterParameterGroups(settings),reference=this.card(t('Справочные данные'),'mdi:information-outline',true),referenceDetails=el('details','inverter-reference');
    referenceDetails.append(el('summary',null,()=>t('Характеристики и состояние')));reference.append(referenceDetails);
    if(groups.editable.length){actions.append(unlock);c.append(actions)}else{reference.querySelector('.card-head>ha-icon')?.remove();reference.querySelector('.card-head').append(refresh)}
    const supported=new Set(settings.writableFields||settings.supportedFields||[]);
    for(const [key,value]of [...groups.editable,...groups.reference]){
      if(value===null||value===undefined||!LABELS[key])continue;
      const row=el('div','setting-row'),label=el('label',null,()=>(t(LABELS[key]||key)),true);row.dataset.inverterKey=key;label.title=key;row.append(label);const editable=settings.available&&supported.has(key)&&settings.supportsWrite&&settings.expertUnlocked;
      if(!settings.supportsWrite||!supported.has(key)){row.classList.add('readonly-row');row.append(el('span','muted',()=>(inverterValue(settings,key,value)),true));referenceDetails.append(row);continue}
      const options=inverterOptions(settings,key);
      const draft={[key]:Number.isFinite(Number(value))?Number(value):value};const field=this.field({key,label:LABELS[key]||key,type:options?'select':'number',numeric:true,options,...settings.constraints?.[key]},draft,(k,v)=>{draft[k]=v;row.dataset.dirty='true';apply.disabled=!editable||near(v,this.data['inverter/settings']?.values?.[key])},!editable);field.firstChild.hidden=true;
      const apply=button(()=>(t('Применить')),()=>this.confirm(t('Изменить параметр инвертора?'),`${t(LABELS[key])}: ${inverterValue(settings,key,this.data['inverter/settings']?.values?.[key]??value)} → ${inverterValue(settings,key,draft[key])}`,()=>this.act('inverter-write',async()=>{if(!Number.isFinite(Number(draft[key])))throw new Error(t('Введите число'));await this.writeInverter(key,draft[key]);this.data['inverter/settings']=await this.api.get('inverter/settings');apply.disabled=true;delete row.dataset.dirty},t('Значение подтверждено чтением')),{confirmLabel:t('Записать')}),'button');apply.disabled=true;row.append(field,apply);c.append(row);
    }
    if(groups.editable.length)grid.append(c);if(groups.reference.length)grid.append(reference);const diagnostic=this.card(t('Диагностика'),'mdi:information-outline',true),details=el('details');details.style.margin='0';details.style.border='0';details.append(el('summary',null,()=>(t('Данные протокола'))));const pre=el('pre',null,()=>(JSON.stringify({values:settings.values,diagnostics:settings.diagnostics,protocolData:settings.protocolData},null,2)));details.append(pre);diagnostic.append(details);grid.append(diagnostic);p.append(grid);
  },
  async refreshInverterSettings(){const before=await this.api.get('inverter/settings');await this.api.post('inverter/settings/refresh',{});const deadline=Date.now()+65000;while(Date.now()<deadline){await wait(1000);const data=await this.api.get('inverter/settings');if(data.ratingFresh&&!data.refreshing&&Number(data.ratingUpdatedAt)!==Number(before.ratingUpdatedAt))return data}throw new Error(t('Инвертор не вернул свежую карту настроек'))},
  async writeInverter(key,value){
    let before=await this.api.get('inverter/settings');if(!before.ratingFresh||before.refreshing)before=await this.refreshInverterSettings();
    if(!before.supportsWrite||!before.expertUnlocked)throw new Error(t('Экспертный доступ закрыт'));
    const queued=await this.api.post('inverter/settings',{key,value:Number(value)});if(!queued.id)throw new Error(t('Инвертор не подтвердил операцию'));
    const deadline=Date.now()+65000;let ack=false;
    while(Date.now()<deadline){await wait(750);const current=await this.api.get('inverter/settings');if(current.operation?.id===queued.id&&!current.operation.pending){if(current.operation.result!=='ACK')throw new Error(t('Инвертор отклонил запись: ')+current.operation.result);ack=true}if(ack&&Number(current.updatedAt)>Number(before.updatedAt)&&near(current.values?.[key],value))return current}
    throw new Error(t('Чтение не подтвердило запись. Проверьте значение перед повтором'));
  },
  updateInverter(p){if(p.dataset.inverterView!==inverterViewKey(this.data)){this.renderPage('inverter',true);return}const data=this.data['inverter/settings:error']?null:this.data['inverter/settings'],snapshot=this.data['telemetry?channel=inverter']?.payload,live=snapshot?.available&&!this.data['telemetry?channel=inverter:error']?snapshot:null;for(const [key,value]of Object.entries({'inv-load':fmt(live?.loadPower),'inv-grid':fmt(live?.gridVoltage,1),'inv-pv':fmt(live?.pvPower),'inv-temperature':fmt(live?.inverterTemperature,1)})){const n=p.querySelector(`[data-live="${key}"]`);if(n){setText(n,()=>value);const unit=n.parentElement.querySelector(".stat-unit");if(unit)unit.hidden=value==="—"}}for(const node of p.querySelectorAll('[data-inverter-reading]')){const value=live?.[node.dataset.inverterReading];setText(node,()=>fmt(value,Number(node.dataset.digits))+(Number.isFinite(value)&&node.dataset.unit?' '+node.dataset.unit:''))}
    if(!data)return;for(const row of p.querySelectorAll('[data-inverter-key]')){const key=row.dataset.inverterKey,value=data.values?.[key],input=row.querySelector('input,select');if(!input){setText(row.querySelector('.muted'),()=>inverterValue(data,key,value));continue}const writable=data.available&&data.expertUnlocked&&data.supportsWrite&&!this.busy.has('inverter-write');input.disabled=!writable;if(!row.dataset.dirty&&value!==undefined)input.value=inverterInputValue(value);const apply=row.querySelector('button');if(apply)apply.disabled=!writable||!row.dataset.dirty||near(Number(input.value),Number(value))}},
  renderBms(p){
    this._bmsView??='bank';const core=this.data.settings,tabs=el('div','segments compact');
    for(const [key,label]of [['bank',t('Банк')],['0',core?.bmsSlots?.[0]?.name||'BMS 1'],['1',core?.bmsSlots?.[1]?.name||'BMS 2']]){
      const b=button(()=>(label),()=>{if(this._bmsView===key)return;this._bmsView=key;if(key!=='bank')this._slot=Number(key);for(const button of tabs.children)button.setAttribute('aria-pressed',String(button.dataset.bmsTab===key));for(const view of p.querySelectorAll('[data-bms-view]'))view.hidden=view.dataset.bmsView!==key;this.refresh()},'segment');b.dataset.bmsTab=key;b.setAttribute('aria-pressed',String(this._bmsView===key));tabs.append(b);
    }
    const bank=el('div','stack');bank.dataset.bmsView='bank';bank.hidden=this._bmsView!=='bank';this.renderBmsBank(bank);p.append(tabs,bank);
    this.updateBms(p);
  },
  renderBmsBank(p){
    p.append(this.stats([[t('Заряд'),'—','%','mdi:battery-medium','bank-soc'],[t('Напряжение'),'—',t('В'),'mdi:sine-wave','bank-voltage'],[t('Ток'),'—',t('А'),'mdi:current-dc','bank-current'],[t('Мощность'),'—',t('Вт'),'mdi:flash','bank-power']]));
    const grid=el('div','grid');grid.append(this.formCard(t('Банк батарей'),[{key:'bmsBankMode',label:t('Режим соединения'),type:'select',options:[['parallel',t('Параллельно')],['series',t('Последовательно')]]}],this.data.settings||{},async patch=>{
      const accepted=await this.api.post('bms/bank',{mode:patch.bmsBankMode});await ticketResult(this.api,'bms/bank/result',accepted.ticket);this.data.settings=await this.api.get('settings');if(this.data.settings.bmsBankMode!==patch.bmsBankMode)throw new Error(t('Сохранение не подтверждено чтением'));return {saved:true};
    },{glyph:'mdi:battery-multiple'}));
    const summary=this.card(t('Состояние банка'),'mdi:battery-heart-variant');
    for(const [key,label]of [['remaining_capacity',t('Остаточная ёмкость')],['cell_delta',t('Разброс ячеек')],['bms1_available','BMS 1'],['bms2_available','BMS 2']])this.stateRow(summary,label,'—').lastChild.dataset.bankValue=key;
    grid.append(summary);p.append(grid);
  },
  renderBmsSlot(view,slot){
    const snapshot=this.data[`bms?slot=${slot}`],settings=this.data[`bms/settings?slot=${slot}`],core=this.data.settings;
    view.dataset.bmsSlot=slot;const data=snapshot?.available?snapshot.data:null;
    // UX-06/13: an unconfigured slot is a compact empty state, not a wall
    // of dashes. Connecting stays the first action; disconnect is hidden
    // because there is nothing to disconnect yet.
    if(!snapshot?.connected&&!core?.bmsSlots?.[slot]?.macAddress){
      const empty=this.card(t('BMS ')+(slot+1),'mdi:battery-off-outline',true);
      empty.classList.add('bms-empty');
      empty.append(el('p','muted',()=>(t('Слот не настроен. Подключите BMS, чтобы видеть заряд, ячейки и защиты.'))));
      const a=el('div','actions');a.append(button(()=>(t('Подключить BMS ')+(slot+1)),()=>this.connectBmsDialog(slot),'button primary','mdi:bluetooth'));
      empty.append(a);view.append(empty);return;
    }
    view.append(this.stats([[t('Заряд'),fmt(data?.stateOfCharge),'%','mdi:battery-medium','bms-soc'],[t('Напряжение'),fmt(data?.totalVoltage,2),t('В'),'mdi:sine-wave','bms-voltage'],[t('Ток'),fmt(data?.current,2),t('А'),'mdi:current-dc','bms-current'],[t('Мощность'),fmt(data?.power),t('Вт'),'mdi:flash','bms-power']]));
    const grid=el('div','grid'),connection=this.card(t('Подключение'),'mdi:bluetooth-connect');this.stateRow(connection,t('Состояние'),'—').lastChild.dataset.bmsState='connection';this.stateRow(connection,t('Модель'),'—').lastChild.dataset.bmsState='model';this.stateRow(connection,t('Адрес'),'—').lastChild.dataset.bmsState='address';const a=el('div','actions');a.append(Object.assign(button(()=>(t('Подключить')),()=>this.connectBmsDialog(slot),'button','mdi:bluetooth'),{ariaLabel:t('Подключить BMS ')+(slot+1)}));if(snapshot?.connected)a.append(button(()=>(t('Отключить')),()=>this.confirm(t('Отключить BMS?'),t('Показания этой батареи станут недоступны. Настройки слота сохраняются.'),()=>this.act('bms-disconnect',async()=>{const result=await this.api.post('bms/disconnect',{slot});await ticketResult(this.api,'bms/connect/result',result.ticket);delete this._bmsTokens?.[slot];await this.waitBmsState(slot,false);this.renderPage('bms',true)},t('BMS отключена')),{confirmLabel:t('Отключить'),tone:'danger'}),'button danger'));connection.append(a);grid.append(connection);
    grid.append(this.formCard(t('Название BMS'),[{key:'name',label:t('Название'),type:'text',maxLength:32}],{name:core?.bmsSlots?.[slot]?.name||''},async patch=>{await this.api.post('settings',{bmsSlots:[{slot,name:patch.name}]});this.data.settings=await this.api.get('settings');if(this.data.settings.bmsSlots?.[slot]?.name!==patch.name)throw new Error(t('Сохранение не подтверждено чтением'));const tab=this.pages.get('bms')?.querySelector(`[data-bms-tab="${slot}"]`);if(tab)setText(tab,()=>patch.name||'BMS '+(slot+1));return {saved:true}},{glyph:'mdi:rename-box-outline'}));
    const cells=this.card(t('Ячейки'),'mdi:grid',true),list=el('div','cells');list.dataset.role='cells';cells.append(list);grid.append(cells);
    const measurements=this.card(t('Батарея'),'mdi:battery-heart-variant',true),readings=el('div','readings');for(const [key,label,unit,digits]of [['power',t('Мощность'),t('Вт'),0],['remainingCapacity',t('Остаточная ёмкость'),t('А·ч'),1],['nominalCapacity',t('Ёмкость'),t('А·ч'),1],['stateOfHealth',t('Здоровье батареи'),'%',1],['cycleCount',t('Циклы'),'',0],['balanceCurrent',t('Балансировка'),t('А'),2],['temperature1',t('Датчик 1'),'°C',1],['temperature2',t('Датчик 2'),'°C',1]]){const r=el('div','reading');r.append(el('span',null,()=>(label)),el('strong',null,()=>(fmt(data?.[key],digits)+(data?.[key]!=null?' '+unit:''))));r.lastChild.dataset.bmsValue=key;r.lastChild.dataset.digits=digits;r.lastChild.dataset.unit=unit;readings.append(r)}measurements.dataset.role='bms-measurements';measurements.hidden=!data;measurements.append(readings);grid.append(measurements);
    const configHost=el('div','wide');configHost.dataset.role='bms-settings';configHost.dataset.signature=String(!!settings?.available)+':'+String(!!snapshot?.connected);this.renderBmsSettings(configHost,slot,settings,snapshot);grid.append(configHost);
    const diagnostic=this.card(t('Диагностика'),'mdi:information-outline',true),details=el('details');details.style.margin='0';details.style.border='0';details.append(el('summary',null,()=>(t('Состояние подключения'))));const safe={...snapshot};delete safe.data;details.append(el('pre',null,()=>(JSON.stringify(safe,null,2))));if(settings){const ro=el('pre',null,()=>(JSON.stringify(Object.fromEntries(Object.entries(settings).filter(([key])=>['userData1','userData2','wireResistance','deviceAddress','dataStorePeriod','lcdBuzzerTriggerValue','lcdBuzzerReleaseValue'].includes(key))),null,2)));details.append(ro)}diagnostic.append(details);grid.append(diagnostic);view.append(grid);
  },
  renderBmsSettings(host,slot,settings,snapshot){
    if(settings?.available&&snapshot?.connected){
      const config=this.card(t('Параметры BMS'),'mdi:tune',true),actions=el('div','actions');actions.style.marginTop='0';const unlock=button(()=>(t('Разблокировать')),()=>this.modal(t('Доступ к BMS'),d=>{const draft={password:''},form=el('form');form.append(this.field({key:'password',label:t('Пароль BMS'),type:'password',required:true},draft,(k,v)=>draft[k]=v));const a=el('div','actions'),submit=button(()=>(t('Разблокировать')),null,'button primary');submit.type='submit';a.append(submit);form.append(a);form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;try{await this.act('bms-unlock',()=>this.unlockBms(slot,draft.password),'');d.close();this.renderPage('bms',true)}catch(_){submit.disabled=false}};d.append(form)}),'button','mdi:lock-outline');const unlocked=this._bmsTokens?.[slot]?.until>Date.now();if(unlocked){setText(unlock,()=>t('Заблокировать'));unlock.onclick=()=>{delete this._bmsTokens[slot];this.renderPage('bms',true)}}const refresh=button(()=>(''),()=>this.run('bms-refresh',async()=>{const before=await this.api.get(`bms/settings?slot=${slot}`);await this.api.post('bms/refresh-settings',{slot});const until=Date.now()+25000;let fresh;while(Date.now()<until){await wait(1000);fresh=await this.api.get(`bms/settings?slot=${slot}`);if(fresh.available&&fresh.settingsUpdatedAt!==before.settingsUpdatedAt)break}if(!fresh?.available||fresh.settingsUpdatedAt===before.settingsUpdatedAt)throw new Error(t('BMS не вернула свежие настройки'));this.data[`bms/settings?slot=${slot}`]=fresh;this.renderPage('bms',true)},t('Настройки BMS обновлены')),'icon-button','mdi:refresh');bindAttribute(refresh,'aria-label','Обновить параметры');bindAttribute(refresh,'title','Обновить параметры');config.querySelector('.card-head>ha-icon')?.remove();config.querySelector('.card-head').append(refresh);actions.append(unlock);config.append(actions);
      for(const [title,keys]of BMS_GROUPS){const group=el('details');group.append(el('summary',null,()=>(technical(title)),true));for(const key of keys.split(' ')){if(settings[key]===undefined&&!key.endsWith('Calibration'))continue;const row=el('div','setting-row'),label=el('label',null,()=>(t(LABELS[key]||key)),true);if(!bmsSettingWritable(key)){row.dataset.bmsUnsupported=key;row.append(label,el('span','muted',()=>t('Обратное чтение этого параметра не поддерживается')));group.append(row);continue}let value=settings[key]??0;const draft={[key]:value};const isBoolean=typeof value==='boolean';const field=this.field({key,label:LABELS[key]||key,type:isBoolean?'select':'number',options:[[0,'Disabled'],[1,'Enabled']],numeric:true},{[key]:isBoolean?Number(value):value},(k,v)=>{draft[k]=v;row.dataset.dirty='true';apply.disabled=!this._bmsTokens?.[slot]||this._bmsTokens[slot].until<=Date.now()||this.data[`bms/settings?slot=${slot}`]?.unlocked===false||near(Number(v),Number(this.data[`bms/settings?slot=${slot}`]?.[key]??value))},!unlocked);field.firstChild.hidden=true;const apply=button(()=>(t('Записать')),()=>this.confirm(t('Изменить параметр BMS?'),`${t(LABELS[key])}: ${inverterValue(settings,key,this.data[`bms/settings?slot=${slot}`]?.[key]??value)} → ${inverterValue(settings,key,draft[key])}`,()=>this.act('bms-write',async()=>{const result=await this.writeBmsSetting(slot,key,Number(draft[key]));const actual=this.data[`bms/settings?slot=${slot}`]?.[key];if(actual!==undefined){draft[key]=actual;field.querySelector('input,select').value=String(typeof actual==='boolean'?Number(actual):Number(Number(actual).toFixed(6)))}apply.disabled=true;delete row.dataset.dirty;this.notify(result.reconciled?t('Значение подтверждено повторным чтением'):t('Значение подтверждено чтением'))},''),{confirmLabel:t('Записать')}),'button');apply.disabled=true;row.dataset.bmsKey=key;row.append(label,field,apply);group.append(row)}config.append(group)}host.append(config);
    }else if(snapshot?.connected){const c=this.card(t('Параметры BMS'),'mdi:tune',true);c.append(this.notice(t('Ожидается карта настроек BMS.')));host.append(c)}
  },
  updateBms(p){
    if(this._bmsView==='bank'){const bank=p.querySelector('[data-bms-view="bank"]');if(bank)this.updateBmsBank(bank);return}
    if(this._bmsView!==undefined){let view=p.querySelector('[data-bms-view="'+this._bmsView+'"]');if(!view){view=el('div','stack');view.dataset.bmsView=this._bmsView;this.renderBmsSlot(view,Number(this._bmsView));p.append(view)}p=view}
    const slot=Number(p.dataset?.bmsSlot??p.querySelector('[data-bms-slot]')?.dataset.bmsSlot??-1);if(slot<0)return;const snapshot=this.data[`bms?slot=${slot}`],data=snapshot?.available&&!this.data[`bms?slot=${slot}:error`]?snapshot.data:null;const stale=!!this.data[`bms?slot=${slot}:error`],saved=this.data.settings?.bmsSlots?.[slot]||{};for(const [key,value]of Object.entries({connection:stale?t('Нет связи с ESP'):snapshot?.connected?(snapshot.available?t('Подключено'):t('Ожидание данных')):['connecting','discovering','subscribing','authenticating'].includes(snapshot?.state)?t('Подключение…'):t('Отключено'),model:snapshot?.model||saved.model||'—',address:snapshot?.macAddress||saved.macAddress||'—'})){const n=p.querySelector(`[data-bms-state="${key}"]`);if(n)setText(n,()=>value,key==='connection')}const host=p.querySelector('[data-role=bms-settings]'),settings=this.data[`bms/settings?slot=${slot}`];if(settings?.unlocked===false)delete this._bmsTokens?.[slot];const signature=String(!stale&&!!settings?.available)+':'+String(!stale&&!!snapshot?.connected)+':'+String(!!this._bmsTokens?.[slot]&&this._bmsTokens[slot].until>Date.now());if(host&&host.dataset.signature!==signature){host.dataset.signature=signature;host.replaceChildren();this.renderBmsSettings(host,slot,stale?null:settings,stale?null:snapshot)}for(const [key,value]of Object.entries({'bms-soc':fmt(data?.stateOfCharge),'bms-voltage':fmt(data?.totalVoltage,2),'bms-current':fmt(data?.current,2),'bms-power':fmt(data?.power)})){const n=p.querySelector(`[data-live="${key}"]`);if(n){setText(n,()=>value);const unit=n.parentElement.querySelector(".stat-unit");if(unit)unit.hidden=value==="—"}}for(const n of p.querySelectorAll('[data-bms-value]'))setText(n,()=>fmt(data?.[n.dataset.bmsValue],Number(n.dataset.digits))+(data?.[n.dataset.bmsValue]!=null?' '+n.dataset.unit:''));const cells=p.querySelector('[data-role=cells]');if(!cells)return;const values=data?.cellVoltages||[];cells.closest('.card').hidden=!values.length;const measurements=p.querySelector('[data-role=bms-measurements]');if(measurements)measurements.hidden=!data;if(cells.children.length!==values.length){cells.replaceChildren();for(let i=0;i<values.length;i++){const c=el('div','cell');c.append(el('span',null,()=>(String(i+1).padStart(2,'0'))),el('strong'),el('small'));cells.append(c)}}values.forEach((v,i)=>{setText(cells.children[i].querySelector('strong'),()=>fmt(v,3)+t(' В'));setText(cells.children[i].querySelector('small'),()=>data.cellResistances?.[i]?fmt(data.cellResistances[i]*1000,2)+t(' мОм'):'')});const canEdit=!!this._bmsTokens?.[slot]&&this._bmsTokens[slot].until>Date.now()&&settings?.unlocked!==false&&!this.busy.has('bms-write');for(const row of p.querySelectorAll('[data-bms-key]')){const input=row.querySelector('input,select'),actual=settings?.[row.dataset.bmsKey];input.disabled=!canEdit;if(!row.dataset.dirty&&actual!==undefined)input.value=String(typeof actual==='boolean'?Number(actual):Number(Number(actual).toFixed(6)));row.querySelector('button').disabled=!canEdit||!row.dataset.dirty||actual!==undefined&&near(Number(input.value),Number(actual))}for(const b of p.querySelectorAll('.setting-row button'))if(!canEdit)b.disabled=true},
  updateBmsBank(p){
    const current=this.data['bms-bank-current'],fresh=current?.available&&Date.now()/1000-current.at<35&&!this.data['bms-bank-current:error'],values=fresh?current.values||{}:{},v=values.bms_available?values:{};
    for(const [key,value]of Object.entries({'bank-soc':fmt(v.battery_soc),'bank-voltage':fmt(v.battery_voltage,2),'bank-current':fmt(v.battery_current,2),'bank-power':fmt(v.battery_power)})){
      const n=p.querySelector(`[data-live="${key}"]`);if(n){setText(n,()=>value);const unit=n.parentElement.querySelector('.stat-unit');if(unit)unit.hidden=value==='—'}
    }
    for(const n of p.querySelectorAll('[data-bank-value]')){const key=n.dataset.bankValue;setText(n,()=>key.endsWith('_available')?typeof values[key]==='boolean'?(values[key]?t('Подключено'):t('Отключено')):'—':fmt(v[key],key==='cell_delta'?3:1)+(v[key]!=null?(key==='cell_delta'?t(' В'):t(' А·ч')):''))}
    const mode=p.querySelector('[name=bmsBankMode]');if(mode&&!mode.closest('.card').dataset.dirty)mode.value=this.data.settings?.bmsBankMode||'parallel';
  },
  async unlockBms(slot,password){
    const result=await this.api.post('bms/settings/unlock',{slot,password});
    const fresh=await this.api.get(`bms/settings?slot=${slot}`);
    if(!fresh?.unlocked)throw new Error(t('Разблокируйте BMS заново'));
    this.data[`bms/settings?slot=${slot}`]=fresh;
    this._bmsTokens??={};
    this._bmsTokens[slot]={token:result.token,until:Date.now()+result.expiresIn*1000};
  },
  async writeBmsSetting(slot,key,value){
    if(!bmsSettingWritable(key))throw new Error(t('Обратное чтение этого параметра не поддерживается'));
    const token=this._bmsTokens?.[slot];if(!token||token.until<=Date.now())throw new Error(t('Разблокируйте BMS заново'));
    const path=`bms/settings?slot=${slot}`,before=await this.api.get(path);
    const accepted=await this.api.post('bms/settings',{slot,key,value:Number(value),token:token.token});
    let reconciled=false,completion;
    try{completion=await ticketResult(this.api,'bms/settings/result',accepted.ticket)}
    catch(error){
      // A readback timeout is ambiguous: the write may already have applied.
      // Request a fresh read only. Never repeat the setting write here.
      if(error.data?.result!=='timeout'||typeof before[key]!=='boolean')throw error;
      reconciled=true;await this.api.post('bms/refresh-settings',{slot});
    }
    const deadline=Date.now()+(reconciled?25000:7000);
    while(Date.now()<deadline){
      const fresh=await this.api.get(path);this.data[path]=fresh;
      const verified=!reconciled&&fresh.writeState==='verified'&&fresh.writeAddress===completion?.address&&Number(fresh.writeCompletedAt)>Number(before.writeCompletedAt||0);
      if(fresh.available&&(verified||reconciled&&Number(fresh.settingsUpdatedAt)>Number(before.settingsUpdatedAt))){
        if(reconciled&&!near(Number(fresh[key]),Number(value)))throw new Error(t('BMS вернула другое значение. Запись не подтверждена'));
        return {reconciled};
      }
      await wait(1000);
    }
    throw new Error(t('Не получены свежие настройки BMS после записи. Прочитайте настройки перед повтором'));
  },
  async waitBmsState(slot,connected){
    const deadline=Date.now()+35000;
    while(Date.now()<deadline){
      const snapshot=await this.api.get(`bms?slot=${slot}`);this.data[`bms?slot=${slot}`]=snapshot;this.data[`bms?slot=${slot}:error`]=null;
      const page=this.pages.get('bms');if(page)this.updateBms(page);
      if(connected?(snapshot.connected&&snapshot.available):(!snapshot.connected&&!snapshot.available)){
        try{this.data[`bms/settings?slot=${slot}`]=await this.api.get(`bms/settings?slot=${slot}`);this.data[`bms/settings?slot=${slot}:error`]=null}catch(error){this.data[`bms/settings?slot=${slot}:error`]=error}
        return snapshot;
      }
      await wait(1000);
    }
    throw new Error(connected?t('Команда принята, но свежие данные BMS не поступили'):t('Команда принята, но отключение BMS не подтверждено'));
  },
  connectBmsDialog(slot){
    const current=this.data.settings?.bmsSlots?.[slot]||{};
    this.modal(t('Подключить BMS ')+(slot+1),d=>{
      d.classList.add('bms-connect-dialog');
      const epoch=this.epoch,draft={...current,password:''},form=el('form'),grid=el('div','form-grid');
      const discovery=el('section','bms-discovery'),toolbar=el('div','bms-scan-actions'),status=el('p','muted bms-scan-status'),devices=el('div','bms-device-list');
      status.setAttribute('role','status');devices.setAttribute('aria-label',t('Найденные устройства Bluetooth'));
      const updateSelection=()=>{for(const row of devices.children){const selected=row.dataset.address===String(draft.macAddress||'').toUpperCase();row.setAttribute('aria-pressed',String(selected));row.querySelector('ha-icon').setAttribute('icon',selected?'mdi:check-circle':'mdi:bluetooth')}};
      for(const desc of [{key:'macAddress',label:t('MAC-адрес'),type:'text',required:true,maxLength:17},{key:'model',label:t('Название BMS'),type:'text',maxLength:32},{key:'password',label:t('Пароль BMS'),type:'password'}]){
        const field=this.field(desc,draft,(k,v)=>{draft[k]=v;if(k==='macAddress')updateSelection()});
        if(desc.key==='password')field.classList.add('bms-password');
        if(desc.key==='macAddress')field.querySelector('input').pattern='(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}';
        grid.append(field);
      }
      let signature='';
      const renderDevices=result=>{
        const list=bmsDiscoveryItems(result,draft.macAddress),next=JSON.stringify(list.map(x=>[x.address,x.name,x.rssi]));
        if(signature!==next){signature=next;devices.replaceChildren();
          for(const item of list){const address=item.address,name=item.name||t('Без имени'),row=button(()=>(''),()=>{
            draft.macAddress=address;draft.model=name==='Без имени'?'BMS':name;
            form.querySelector('[name=macAddress]').value=address;form.querySelector('[name=model]').value=draft.model;updateSelection();setText(status,()=>t('Устройство выбрано'));
          },'button bms-device','mdi:bluetooth');
            row.dataset.address=address;const info=el('span','bms-device-info');info.append(el('span','bms-device-name',()=>(name),true),el('span','bms-device-address',()=>(address),true));row.append(info);
            if(Number.isFinite(item.rssi))row.append(el('span','bms-device-signal',()=>(item.rssi+' dBm')));
            devices.append(row);
          }
        }
        updateSelection();return list.length;
      };
      const scan=button(()=>(t('Найти BMS')),()=>{
        if(this.busy.has('bms-scan'))return;
        scan.disabled=true;setText(status,()=>t('Поиск устройств…'));
        this.run('bms-scan',async()=>{
          try{
            await this.api.post('bms/scan',{});
            for(let i=0;i<20&&d.open&&epoch===this.epoch;i++){
              await wait(1500);const result=await this.api.get('bms/devices');if(!d.open||epoch!==this.epoch)return;
              const count=renderDevices(result);setText(status,()=>result.scanning?t('Поиск устройств…'):count?t('Выберите свою BMS'):t('Устройства не найдены'));
              if(!result.scanning)return;
            }
            if(d.open)setText(status,()=>t('Поиск не завершился. Повторите попытку'));
          }catch(error){if(d.open)setText(status,()=>errorText(error))}
          finally{scan.disabled=false;setText(scan.lastChild,()=>t('Повторить поиск'))}
        },'');
      },'button','mdi:magnify');
      toolbar.append(scan,status);discovery.append(toolbar,devices);
      const actions=el('div','actions bms-form-actions'),save=button(()=>(t('Подключить')),null,'button primary','mdi:bluetooth');save.type='submit';actions.append(save,button(()=>(t('Отмена')),()=>d.close()));form.append(discovery,grid,actions);
      form.onsubmit=async e=>{e.preventDefault();if(!form.reportValidity())return;save.disabled=true;
        try{await this.act('bms-connect',async()=>{
          validateUtf8(draft.model||'BMS',32);validateUtf8(draft.password||'',32);const body={slot,address:draft.macAddress,model:draft.model||'BMS'};if(draft.password)body.password=draft.password;
          const result=await this.api.post('bms/connect',body);await ticketResult(this.api,'bms/connect/result',result.ticket);
          if(this._bmsTokens)delete this._bmsTokens[slot];await this.waitBmsState(slot,true);this.renderPage('bms',true);
        },t('BMS подключена'));d.close()}catch(_){save.disabled=false}
      };
      d.append(form);d.addEventListener('close',()=>{if(this.busy.has('bms-scan'))this.api.post('bms/stop-scan',{}).catch(()=>{})},{once:true});
    });
  }

};
