import {t,locale} from './i18n.js?v=1.0.256';

const NS='http://www.w3.org/2000/svg';
const names={history:'История мощности и энергии',battery:'История BMS',jk_logbook:'Внутренний журнал JK',metadata:'Служебные данные',combined_archive:'Архив мощности, энергии и BMS'};
const colors={history:'var(--primary-color,#03a9f4)',battery:'var(--success-color,#43a047)',jk_logbook:'var(--warning-color,#e6a23c)',metadata:'var(--secondary-text-color,#888)',combined_archive:'var(--primary-color,#03a9f4)'};
const datasets={minute:'Минутная история',daily:'Суточная энергия',battery:'История BMS',jk_logbook:'Внутренний журнал JK'};
const clearScopes={local:'Память приставки (сервер HA)',external:'Внешний накопитель'};
const metadataHelp='Служебные данные включают статусы хранения, настройки и метки синхронизации. Очистка сбрасывает только диагностические статусы на сервере HA или освобождает пустые страницы внешней базы. Настройки и метки синхронизации сохраняются.';
const folderPolicy='После проверенного копирования на отдельный диск локальные копии очищаются. Для папки на диске HA сохраняется 30 дней. При заполнении архива удаляются самые старые записи.';
export const bytes=value=>{
 if(typeof value!=='number'||!Number.isFinite(value)||value<0)return '—';
 const units=['B','KiB','MiB','GiB','TiB'];let index=0;while(value>=1024&&index<units.length-1){value/=1024;index++}
 return value.toLocaleString(locale(),{maximumFractionDigits:index?2:0})+' '+units[index];
};
export function ringSegments(categories){
 const valid=(categories||[]).filter(c=>Number.isFinite(c.bytes)&&c.bytes>0),total=valid.reduce((sum,c)=>sum+c.bytes,0);let offset=0;
 return valid.map(c=>{const size=c.bytes/total*100,item={...c,size,offset};offset+=size;return item});
}
const node=(tag,value,className)=>{const n=document.createElement(tag);if(value!==undefined)n.textContent=value;if(className)n.className=className;return n};
const date=value=>new Date(value*1000).toLocaleString(locale());
export function deviceTime(value){
 const days=Math.floor(value/86400),h=Math.floor(value%86400/3600),m=Math.floor(value%3600/60),s=value%60;
 return `${days} ${t('дн.')} ${[h,m,s].map(v=>String(v).padStart(2,'0')).join(':')}`;
}
export const JK_EVENTS={7:"Дистанционное выключение заряда",8:"Дистанционное включение заряда",9:"Дистанционное выключение разряда",10:"Дистанционное включение разряда",40:"Защита от КЗ разряда II",41:"Ручное включение аварийного режима",42:"Ручное выключение аварийного режима",43:"Автоматическое выключение аварийного режима",47:"Выключение через RS485",48:"CAN: заряд выключен",49:"CAN: заряд включён",50:"CAN: разряд выключен",51:"CAN: разряд включён",52:"RS485: заряд выключен",53:"RS485: заряд включён",54:"RS485: разряд выключен",55:"RS485: разряд включён",67:"Заводские настройки LION",68:"Заводские настройки LFP",69:"Заводские настройки LTO",70:"Дистанционный аварийный режим включён",71:"Дистанционный аварийный режим выключен",
1:'Запуск БМС',2:'Выключение БМС',3:'Приложение: заряд выключен',4:'Приложение: заряд включён',5:'Приложение: разряд выключен',6:'Приложение: разряд включён',
 11:'Перегрев MOS',12:'Перегрев MOS снят',13:'Ошибка датчика тока',14:'Ошибка датчика тока снята',15:'Ошибка связи сопроцессора',16:'Ошибка связи сопроцессора снята',
 17:'Перенапряжение ячейки',18:'Перенапряжение ячейки снято',19:'Перенапряжение батареи',20:'Перенапряжение батареи снято',21:'Сверхток заряда',22:'Сверхток заряда снят',
 23:'Короткое замыкание при заряде',24:'Защита от КЗ при заряде снята',25:'Перегрев при заряде',26:'Перегрев при заряде снят',27:'Низкая температура заряда',28:'Защита по низкой температуре заряда снята',
 29:'Низкое напряжение ячейки',30:'Защита по напряжению ячейки снята',31:'Низкое напряжение батареи',32:'Защита по напряжению батареи снята',33:'Сверхток разряда',34:'Сверхток разряда снят',
 35:'Короткое замыкание при разряде',36:'Защита от КЗ при разряде снята',37:'Перегрев при разряде',38:'Перегрев при разряде снят',39:'Сброс watchdog БМС',
 44:'Выключение из приложения',45:'Выключение кнопкой',46:'Не удалось включить разряд',56:'Переход в сон',57:'Неисправность MOS заряда',58:'Неисправность MOS разряда',59:'Коррекция времени БМС',60:'Неверное число ячеек',
 61:'Аварийное включение кнопкой',62:'Аварийное выключение кнопкой',63:'Принудительный нагрев кнопкой',64:'Сверхток разряда II',65:'Сверхток разряда III',66:'Не удалось снять защиту от КЗ',
 72:'Низкая температура разряда',73:'Защита по низкой температуре разряда снята'};

export function jkEventName(code){
 if(code>=0x64&&code<=0x83)return t(JK_EVENTS[17])+' '+(code-0x63);
 if(code>=0xc8&&code<=0xe7)return t(JK_EVENTS[29])+' '+(code-0xc7);
 return JK_EVENTS[code]?t(JK_EVENTS[code]):t('Событие JK');
}
export function orderedJkEntries(window){
 const entries=Array.isArray(window?.entries)?window.entries:[];
 // A1 exposes physical ring slots. Its counter identifies the next slot;
 // device timestamps can go backwards after a clock change or restart.
 const start=entries.length===50&&Number.isInteger(window.reportedCount)&&window.reportedCount>=50?window.reportedCount%50:0;
 return [...entries.slice(start),...entries.slice(0,start)].reverse();
}

const csvCell=value=>'"'+String(value??'').replaceAll('"','""')+'"';
export async function collectExport(request,choice,alive,progress=()=>{}){
 let after=0,upper=0,total=null,count=0,size=3,columns=null,archiveId=null;const chunks=['\ufeff'];
 const eventNames=Array.from({length:256},(_,code)=>jkEventName(code)),unknownEvent=t('Событие JK');
 do{
  if(!alive())throw Error('export_cancelled');
  const page=await request({...choice,after,upper,total:total??0});
  if(!alive())throw Error('export_cancelled');
  if(page.generation!==choice.generation||page.scope!==choice.scope||!Array.isArray(page.rows)||!Array.isArray(page.columns)||
    !Number.isSafeInteger(page.total)||page.total<0||!Number.isSafeInteger(page.upper)||page.upper<upper||
    !Number.isSafeInteger(page.after)||page.after<after||typeof page.more!=='boolean')throw Error('export_changed');
  const jk=choice.dataset==='jk_logbook';
  if(total===null){total=page.total;upper=page.upper;columns=page.columns;archiveId=page.archiveId??null;chunks.push([...columns,...(jk?['event_name']:[])].map(csvCell).join(';')+'\r\n')}
  if((page.archiveId??null)!==archiveId)throw Error('export_changed');
  if(page.total!==total||page.upper!==upper||(page.rows.length&&JSON.stringify(page.columns)!==JSON.stringify(columns))||
    (page.more&&page.after<=after))throw Error('export_changed');
  const chunk=page.rows.map(row=>{if(!Array.isArray(row)||row.length!==columns.length)throw Error('export_changed');const code=row[7],label=code===null?'':eventNames[code]||unknownEvent;return [...row,...(jk?[label]:[])].map(csvCell).join(';')+'\r\n'}).join('');
  size+=new TextEncoder().encode(chunk).byteLength;if(size>64*1024*1024)throw Error('export_too_large');
  chunks.push(chunk);after=page.after;count+=page.rows.length;if(count>total)throw Error('export_changed');progress(count,total);
  if(!page.more){if(count!==total)throw Error('export_changed');return chunks}
 }while(true);
}
function download(chunks,name,type){
 const url=URL.createObjectURL(new Blob(chunks,{type})),a=node('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function exportData(host){
 if(host._storageExport)return;
 const token={device:host._device,cancelled:false};host._storageExport=token;host._storageExportMessage='';
 const choice={scope:'local',dataset:'minute',period:'30',...host._storageChoice},end=Math.floor(Date.now()/1000);
 const range={scope:choice.scope,dataset:choice.dataset,start:choice.period==='all'?0:end-Number(choice.period)*86400,end,generation:host._storageData.generation};
 const alive=()=>!token.cancelled&&host.isConnected&&host._storageExport===token&&host._device===token.device;
 host.render();
 try{
  const chunks=await collectExport(args=>{const {generation,...query}=args;return host.request('storage_export',query)},range,alive,(count,total)=>{
   host._exportProgress=count+' / '+total;const output=host.shadowRoot.querySelector('.pm-export-status');if(output)output.textContent=host._exportProgress;
  });
  if(alive()){download(chunks,`power-monitor-${token.device}-${choice.scope}-${choice.dataset}.csv`,'text/csv;charset=utf-8');host._storageExportMessage=t('Файл выгружен')}
 }catch(error){
  if(host._storageExport===token&&host._device===token.device)host._storageExportMessage=t(error.message==='export_cancelled'?'Выгрузка отменена':error.message==='export_too_large'?'Выберите меньший период: файл превышает 64 MiB':'Выгрузка не завершена. Данные не удалены. Повторите выгрузку.');
 }finally{if(host._storageExport===token){host._storageExport=null;host._exportProgress='';if(host.isConnected)host.render()}}
}

function storageDisk(value,title){
 const box=node('div',undefined,'pm-storage-disk');box.append(node('h4',title));
 if(!value?.available){box.append(node('p',t('Архив недоступен. Проверьте подключение и путь хранения.'),'muted'));return box}
 const chart=node('div',undefined,'pm-storage-chart'),ring=node('div',undefined,'pm-storage-ring');
 const svg=document.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 120 120');svg.setAttribute('role','img');svg.setAttribute('aria-label',`${title}: ${bytes(value.totalBytes)}`);
 const base=document.createElementNS(NS,'circle');for(const [k,v]of Object.entries({cx:60,cy:60,r:48,fill:'none',stroke:'var(--divider-color)', 'stroke-width':12}))base.setAttribute(k,v);svg.append(base);
 for(const segment of ringSegments(value.categories)){
  const arc=base.cloneNode();arc.setAttribute('pathLength','100');arc.setAttribute('stroke',colors[segment.key]||colors.metadata);
  arc.setAttribute('stroke-dasharray',`${segment.size} ${100-segment.size}`);arc.setAttribute('stroke-dashoffset',String(-segment.offset));arc.setAttribute('transform','rotate(-90 60 60)');
  const hint=document.createElementNS(NS,'title');hint.textContent=`${t(names[segment.key]||'Служебные данные')}: ${bytes(segment.bytes)}`;arc.append(hint);svg.append(arc);
 }
 const center=node('div',undefined,'pm-storage-center');center.append(node('strong',bytes(value.totalBytes)),node('span',t('Данные')));ring.append(svg,center);chart.append(ring);
 const legend=node('dl',undefined,'pm-storage-legend');for(const category of value.categories||[]){
  const item=node('div'),label=node('dt'),dot=node('i');dot.style.background=colors[category.key]||colors.metadata;dot.setAttribute('aria-hidden','true');label.append(dot,document.createTextNode(t(names[category.key]||'Служебные данные')));item.append(label,node('dd',bytes(category.bytes)));legend.append(item);
 }chart.append(legend);box.append(chart);
 if(value.filesystem)box.append(node('p',`${t('Свободно на диске')}: ${bytes(value.filesystem.freeBytes)} / ${bytes(value.filesystem.totalBytes)}`,'muted'));
 return box;
}

export function renderStorage(host){
 const card=host.card(t('Память и данные'));card.classList.add('pm-storage');
 const actions=node('div',undefined,'pm-storage-actions');
 const settings=host.button(t('Настройки хранения'),()=>openStorageSettings(host));settings.dataset.storageFocus='settings';settings.disabled=Boolean(host._storageExport||host._storageClear);actions.append(settings);
 const clear=host.button(t('Очистить данные'),()=>{
  host._storageClear={scope:'',categories:new Set(),device:host._device,archiveId:host._storageData?.external?.archiveId};
  host._storageClearMessage='';host.render();
 });
 clear.dataset.storageFocus='clear';clear.disabled=Boolean(!host._storageData||host._storageError||host._storageExport||host._storageClear||host._storageSettingsOpen);actions.append(clear);
 card.querySelector('header')?.append(actions);
 const style=node('style',`.pm-storage h4{font-size:15px;margin:0 0 14px}.pm-storage-disks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.pm-storage-disk{min-width:0}.pm-storage-chart{display:flex;gap:20px;align-items:center;flex-wrap:wrap}.pm-storage-ring{position:relative;width:172px;max-width:100%;flex-shrink:0}.pm-storage-ring svg{width:100%;height:auto}.pm-storage-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;pointer-events:none}.pm-storage-center strong{font-size:20px;font-variant-numeric:tabular-nums}.pm-storage-center span{font-size:12px;color:var(--secondary-text-color)}.pm-storage-legend{margin:0;flex:1;min-width:150px;display:grid;gap:12px;font-size:12px}.pm-storage-legend>div{display:flex;justify-content:space-between;gap:12px}.pm-storage-legend dt{display:flex;gap:8px;align-items:center;line-height:1.5}.pm-storage-legend i{height:9px;width:9px;border-radius:50%;flex-shrink:0}.pm-storage-legend dd{margin:0;white-space:nowrap;font-variant-numeric:tabular-nums}.pm-storage-note{margin-top:18px!important}.pm-storage-export{display:flex;flex-wrap:wrap;align-items:end;gap:12px;margin-top:20px;padding-top:18px;border-top:1px solid var(--pm-border)}.pm-storage-export label{min-width:130px;flex:1}.pm-storage button{min-height:44px}.pm-export-status{margin-top:12px!important;font-size:12px}.pm-jk-log{margin-top:24px;padding-top:22px;border-top:1px solid var(--pm-border)}.pm-jk-log p{margin-top:10px}.pm-jk-table{margin-top:14px;max-height:340px;overflow:auto}.pm-jk-table table{font-size:12px;min-width:100%;width:100%}.pm-jk-table th,.pm-jk-table td{white-space:normal;text-align:left;padding:10px 8px;border-bottom:1px solid var(--pm-border)}.pm-jk-table td:first-child{white-space:nowrap;font-variant-numeric:tabular-nums}.pm-jk-table th{position:sticky;top:0;background:var(--ha-card-background,var(--card-background-color))}@media(max-width:850px){.pm-storage-disks{grid-template-columns:minmax(0,1fr)}}@media(max-width:420px){.pm-storage-chart{gap:16px;justify-content:center}.pm-storage-legend{min-width:100%}.pm-storage-export label{min-width:100%}}`);
 style.textContent+=' .pm-storage .card-heading,.pm-storage-actions{display:flex;flex-wrap:wrap;gap:8px}';card.append(style);const data=host._storageData;
 if(!data){card.append(node('p',t(host._storageError?'Не удалось обновить данные':'Загрузка…'),'muted'));return card}
 if(host._storageError)card.append(node('p',t('Не удалось обновить данные'),'error'));
 if(host._storageClearMessage){const status=node('p',t(host._storageClearMessage),'muted');status.setAttribute('role','status');card.append(status)}
 if(data.local?.recordingPaused)card.append(node('p',t('Запись истории приостановлена: мало места на сервере HA.'),'error'));
 const archiveState=data.external?.policy?.reason;
 if(archiveState==='full'||archiveState==='reclaiming')card.append(node('p',t(archiveState==='full'?'Архив заполнен. Освободите место или увеличьте лимит.':'Освобождается место для новых записей.'),archiveState==='full'?'error':'muted'));
 if(archiveState==='writer_failed'||archiveState==='unavailable')card.append(node('p',t('Не удалось обновить архив. Проверьте хранилище.'),'error'));
 const disks=node('div',undefined,'pm-storage-disks');disks.append(storageDisk(data.local,t('На сервере Home Assistant')));
 if(data.external?.configured)disks.append(storageDisk(data.external,t(data.external.locationKind==='server'?'Архив на сервере HA':'Внешний архив')));card.append(disks);
 const choice=host._storageChoice??={scope:'local',dataset:'minute',period:'30'};
 const externalLogbook=Boolean(data.external?.datasets?.jk_logbook);
 const controls=node('div',undefined,'pm-storage-export');
 const select=(label,items,key)=>{const row=node('label'),input=node('select');input.dataset.storageFocus=key;row.append(node('span',t(label)));input.setAttribute('aria-label',t(label));for(const [v,title]of items){const option=node('option',t(title));option.value=v;input.append(option)}input.value=choice[key];input.disabled=Boolean(host._storageExport);input.onchange=()=>{choice[key]=input.value;if(choice.scope==='external'&&choice.dataset==='jk_logbook'&&!externalLogbook)choice.dataset='minute';host.render()};row.append(input);return row};
 const scopes=[['local','Сервер HA']];if(data.external?.available)scopes.push(['external','Внешний архив']);
 if(!scopes.some(([key])=>key===choice.scope)&&!host._storageExport)choice.scope='local';
 controls.append(select('Хранилище',scopes,'scope'),select('Данные',Object.entries(datasets).filter(([key])=>choice.scope==='local'||key!=='jk_logbook'||externalLogbook),'dataset'),
  select('Период',[['1','Сутки'],['7','7 дней'],['30','30 дней'],['365','Год'],['all','Весь архив']],'period'));
 const save=host.button(t('Скачать CSV'),()=>exportData(host));save.disabled=Boolean(host._storageExport);controls.append(save);
 const report=host.button(t('Отчёт о памяти'),()=>download([JSON.stringify(data,null,2)],'power-monitor-storage.json','application/json'));report.disabled=Boolean(host._storageExport);controls.append(report);
 if(host._storageExport){const cancel=host.button(t('Отмена'),()=>{host._storageExport.cancelled=true;host._exportProgress=t('Отмена выгрузки…');host.render()});cancel.disabled=host._storageExport.cancelled;controls.append(cancel)}card.append(controls);
 const output=node('p',t(host._exportProgress||host._storageExportMessage||''), 'pm-export-status');output.setAttribute('role','status');card.append(output);
 const selected=(choice.scope==='local'?data.local:data.external)?.datasets?.[choice.dataset];
 if(selected)card.append(node('p',`${t(choice.dataset==='jk_logbook'?'Сохранённых окон журнала':'Сохранённых записей')}: ${selected.rows.toLocaleString(locale())} · ${t('Исходные данные')}: ${bytes(selected.payloadBytes)}`,'muted'));
 const logs=node('section',undefined,'pm-jk-log');logs.append(node('h4',t('Внутренний журнал JK')+' · BMS '+(host._slot+1)));
 const state=data.logbook?.states?.find(s=>s.slot===host._slot),window=data.logbook?.windows?.find(w=>w.slot===host._slot);
 const status=data.logbook?.error?'Не удалось сохранить журнал JK. Проверьте хранилище.':state?.state==='offline'?'Сбор журнала остановлен: HA или БМС недоступны.':state?.state==='firmware_required'?'Для чтения журнала JK требуется обновление ESP.':state?.state==='no_response'?'БМС не ответила на запрос журнала.':state?.state==='recording'?'':'Ожидаем журнал JK от подключённой БМС.';
 if(status)logs.append(node('p',t(status),'muted'));
 if(window){
  logs.append(node('p',`${t('Впервые сохранено в HA')}: ${date(window.observed)} · ${window.identity}`,'muted'));
  const scroll=node('div',undefined,'pm-jk-table'),table=node('table'),head=node('thead'),hr=node('tr');hr.append(node('th',t('Время БМС')),node('th',t('Событие')));head.append(hr);table.append(head);const body=node('tbody');
  for(const entry of orderedJkEntries(window)){const row=node('tr');row.append(node('td',deviceTime(entry.deviceTimeSeconds)),node('td',jkEventName(entry.code)+' · 0x'+entry.code.toString(16).padStart(2,'0').toUpperCase()));body.append(row)}table.append(body);scroll.append(table);logs.append(scroll);
  if(!window.entries.length)logs.append(node('p',t('Журнал JK пуст'),'muted'));
 }
 card.append(logs);return card;
}

async function openStorageSettings(host){
 if(host._storageSettingsOpen)return;
 const device=host._device;host._storageSettingsOpen=true;host._storageSettingsLoading=true;host._storageSettingsError='';host.render();
 try{const value=await host.request('storage_configuration');if(host._device===device){host._storageConfiguration=value;host._storageDraft=storageDraft(value)}}
 catch{if(host._device===device)host._storageSettingsError=t('Не удалось загрузить настройки хранения')}
 finally{if(host._device===device){host._storageSettingsLoading=false;if(host.isConnected)host.render()}}
}
function closeStorageSettings(host){
 if(host._storageSettingsSaving)return;
 host._storageSettingsOpen=false;host._storageDraft=null;host._storageSettingsError='';host.render();
 host._storageDialogFocus=null;
 host._storageAdvancedOpen=false;
 queueMicrotask(()=>host.shadowRoot.querySelector('[data-storage-focus="settings"]')?.focus({preventScroll:true}));
}
export function captureStorageDialog(host){
 const dialog=host.shadowRoot.querySelector('[data-storage-dialog]'),form=dialog?.querySelector('form');
 if(host._storageSettingsOpen&&dialog?.open&&form&&!host._storageSettingsSaving){host._storageDraft={...host._storageDraft,...Object.fromEntries(new FormData(form))};const field=host.shadowRoot.activeElement;if(form.contains(field))host._storageDialogFocus={name:field.name,start:field.selectionStart,end:field.selectionEnd}}
 const advanced=form?.querySelector('[data-storage-advanced]');if(advanced)host._storageAdvancedOpen=advanced.open;
}
export function storageDraft(value){
 const saved=value.settings;return {...saved,location:saved.mode==='folder'?(value.currentLocation||'custom'):saved.mode,limitGiB:saved.limitBytes/1024**3};
}
export function storageSelection(draft,configuration){
 const limitBytes=Math.round(Number(draft.limitGiB)*1024**3),location=draft.location;
 if(location==='local'||location==='legacy'){const value={mode:location,path:'',limitBytes};return {settings:value,expected:value}}
 if(location==='custom'){const value={mode:'folder',path:draft.path||'',limitBytes};return {settings:value,expected:value}}
 const selected=configuration.locations?.find(item=>item.id===location&&item.available);
 if(!selected)throw Error('storage_unavailable');
 const expected={mode:'folder',path:selected.archivePath,limitBytes};return {settings:{...expected,locationId:selected.id},expected};
}
async function refreshStorageLocations(host){
 if(host._storageSettingsSaving||host._storageSettingsLoading)return;
 const device=host._device;host._storageSettingsLoading=true;host._storageSettingsError='';host.render();
 try{const value=await host.request('storage_configuration');if(host._device===device){host._storageConfiguration=value;if(!host._storageDraft)host._storageDraft=storageDraft(value)}}
 catch{if(host._device===device)host._storageSettingsError=t('Не удалось загрузить настройки хранения')}
 finally{if(host._device===device){host._storageSettingsLoading=false;if(host.isConnected)host.render()}}
}
async function saveStorageSettings(host,form){
 if(host._storageSettingsSaving||!form.reportValidity())return;
 const values={...host._storageDraft,...Object.fromEntries(new FormData(form))},device=host._device;
 host._storageDraft=values;host._storageSettingsSaving=true;host._storageSettingsError='';host.render();
 try{
  const {settings,expected}=storageSelection(values,host._storageConfiguration);
  let result;
  try{result=await host.request('configure_storage',{storageSettings:settings})}
  catch(error){
   // A lost result is resolved by readback; never replay the write.
   result=await host.request('storage_configuration');
   if(Object.entries(expected).some(([key,value])=>result.settings[key]!==value))throw error;
  }
  if(host._device!==device)return;
  host._storageConfiguration=result;host._storageSettingsSaving=false;closeStorageSettings(host);await host.load();
 }catch{if(host._device===device)host._storageSettingsError=t('Не удалось сохранить. Проверьте путь, доступ к папке и свободное место.')}
 finally{if(host._device===device){host._storageSettingsSaving=false;if(host.isConnected)host.render()}}
}
export function renderStorageDialog(host){
 const dialog=node('dialog');dialog.dataset.storageDialog='';dialog.setAttribute('aria-labelledby','storage-settings-title');
 const heading=node('header',undefined,'dialog-heading'),title=node('h3',t('Настройки хранения'));title.id='storage-settings-title';heading.append(title);
 const close=host.button('×',()=>closeStorageSettings(host));close.setAttribute('aria-label',t('Закрыть'));close.disabled=Boolean(host._storageSettingsSaving);heading.append(close);dialog.append(heading);
 const form=node('form',undefined,'tariff-form');dialog.append(form);
 if(host._storageSettingsLoading)form.append(node('p',t('Загрузка…'),'muted'));
 else if(host._storageDraft){
  const draft=host._storageDraft,configuration=host._storageConfiguration||{},places=configuration.locations||[];
  const select=node('select');select.name='location';select.setAttribute('aria-label',t('Место хранения архива'));
  const add=(value,label)=>{const option=node('option',label);option.value=value;select.append(option)};
  add('local',t('Только сервер HA')+(configuration.server?' · '+bytes(configuration.server.totalBytes):''));
  for(const place of places)add(place.id,t(place.kind==='network'?'Сетевое хранилище':'Внешний накопитель')+(place.label?' · '+place.label:'')+' · '+bytes(place.totalBytes));
  if(configuration.legacyAvailable)add('legacy',t('Прежняя служба архива'));
  add('custom',t('Другая папка'));
  if(![...select.options].some(option=>option.value===draft.location))add(draft.location,t('Накопитель недоступен'));
  select.value=draft.location;
  const modeRow=node('label');modeRow.append(node('span',t('Место хранения архива')),select);form.append(modeRow);
  const capacity=node('p','', 'form-help');capacity.setAttribute('role','status');form.append(capacity);
  const refresh=host.button(t('Обновить накопители'),()=>refreshStorageLocations(host));refresh.disabled=Boolean(host._storageSettingsSaving);form.append(refresh);
  const advanced=node('details');advanced.dataset.storageAdvanced='';advanced.open=Boolean(host._storageAdvancedOpen)||draft.location==='custom';advanced.append(node('summary',t('Дополнительно')));
  const pathRow=node('label'),path=node('input');path.name='path';path.type='text';path.value=draft.path||'';path.maxLength=512;path.autocomplete='off';path.setAttribute('list','pm-archive-folders');path.setAttribute('aria-label',t('Папка архива'));
  const choices=node('datalist');choices.id='pm-archive-folders';for(const folder of configuration.folders||[]){const option=node('option');option.value=folder;choices.append(option)}pathRow.append(node('span',t('Папка архива')),path,choices);advanced.append(pathRow);
  const edit=host.button(t('Выбрать другую папку'),()=>{select.value='custom';advanced.open=true;refreshFields();path.focus()});advanced.append(edit);form.append(advanced);
  const limitRow=node('label'),limit=node('input');limit.type='number';limit.name='limitGiB';limit.min=.0625;limit.max=1024;limit.step='any';limit.value=draft.limitGiB;limit.required=true;limit.setAttribute('aria-label',t('Лимит архива, GiB'));limitRow.append(node('span',t('Лимит архива, GiB')),limit);form.append(limitRow);
  const policy=node('p',t(folderPolicy),'form-help');form.append(policy);
  const moved=node('p',t('Смена папки сохраняет прежний архив на месте.'),'form-help');form.append(moved);
  const refreshFields=()=>{
   const selected=places.find(item=>item.id===select.value),folder=select.value!=='local'&&select.value!=='legacy',custom=select.value==='custom';
   if(selected)path.value=selected.archivePath;
   if(custom)advanced.open=true;
   advanced.hidden=limitRow.hidden=!folder;path.required=custom;path.disabled=!folder;path.readOnly=!custom;edit.hidden=custom;
   limit.disabled=!folder;
   const usage=select.value==='local'?configuration.server:selected;
   capacity.textContent=usage?`${t('Свободно на диске')}: ${bytes(usage.freeBytes)}`:custom&&draft.path===configuration.settings?.path?t(configuration.currentKind==='server'?'На сервере Home Assistant':configuration.currentKind==='external'?'Внешний накопитель':'Накопитель недоступен'):'';
   if(!places.length&&select.value==='local')capacity.textContent+=' · '+t('Внешние накопители не найдены');
   policy.textContent=t(folder?folderPolicy:select.value==='local'?'История хранится на сервере HA.':'Правила хранения задаёт прежняя служба архива.');
   moved.hidden=!(folder&&configuration.settings?.mode==='folder'&&path.value!==configuration.settings.path);
   host._storageDraft={...host._storageDraft,location:select.value,path:path.value};
  };select.onchange=refreshFields;refreshFields();
  if(host._storageSettingsSaving)for(const field of form.querySelectorAll('input,select'))field.disabled=true;
 }
 if(host._storageSettingsError){const error=node('p',host._storageSettingsError,'error');error.setAttribute('role','alert');form.append(error)}
 const actions=node('div',undefined,'form-actions'),cancel=host.button(t('Отмена'),()=>closeStorageSettings(host));cancel.disabled=Boolean(host._storageSettingsSaving);actions.append(cancel);
 if(host._storageDraft){const save=node('button',t(host._storageSettingsSaving?'Сохранение…':'Сохранить'),'primary');save.type='submit';save.disabled=Boolean(host._storageSettingsSaving);actions.append(save)}form.append(actions);form.onsubmit=event=>{event.preventDefault();saveStorageSettings(host,form)};
 dialog.oncancel=event=>{event.preventDefault();closeStorageSettings(host)};
 if(host._storageSettingsOpen)queueMicrotask(()=>{if(!dialog.isConnected||!host._storageSettingsOpen)return;dialog.showModal();const focus=host._storageDialogFocus;host._storageDialogFocus=null;if(focus){const field=form.elements.namedItem(focus.name);field?.focus({preventScroll:true});if(focus.start!==null)try{field.setSelectionRange(focus.start,focus.end)}catch{}}});
 return dialog;
}

export function renderClearDialog(host){
 const draft=host._storageClear;
 if(!draft)return null;
 const dialog=node('dialog');dialog.dataset.storageClear='';dialog.setAttribute('aria-labelledby','storage-clear-title');
 const heading=node('header',undefined,'dialog-heading'),title=node('h3',t('Очистить данные'));title.id='storage-clear-title';
 const closeDialog=()=>{
  if(draft.busy)return;
  host._storageClear=null;host.render();
  queueMicrotask(()=>host.shadowRoot.querySelector('[data-storage-focus="clear"]')?.focus({preventScroll:true}));
 };
 const close=host.button('×',closeDialog);close.setAttribute('aria-label',t('Закрыть'));close.disabled=Boolean(draft.busy);heading.append(title,close);dialog.append(heading);
 const form=node('form',undefined,'tariff-form');
 form.append(node('p',t('Выбранные данные будут удалены для всех устройств Power Monitor только в указанном хранилище. Удаление необратимо.'),'form-help'));
 const label=node('label'),scope=node('select');scope.name='scope';scope.required=true;
 const external=host._storageData?.external;
 for(const [value,name] of [['','Выберите хранилище'],...Object.entries(clearScopes)]){
  const option=node('option',t(value==='external'&&external?.locationKind==='server'?'Архив на сервере HA':name));option.value=value;
  if(value==='external')option.disabled=!(external?.clearable&&external.archiveId===draft.archiveId);
  scope.append(option);
 }
 scope.value=draft.scope;scope.disabled=Boolean(draft.busy);label.append(node('span',t('Хранилище')),scope);form.append(label);
 const list=node('fieldset',undefined,'pm-clear-categories');list.disabled=Boolean(draft.busy);
 list.append(node('legend',t('Какие данные удалить')));
 for(const [key,name] of Object.entries(names).filter(([key])=>key!=='combined_archive')){
  const row=node('label'),input=node('input');input.name=key;input.type='checkbox';input.checked=draft.categories.has(key);
  input.onchange=()=>{if(input.checked)draft.categories.add(key);else draft.categories.delete(key);update()};
  row.append(input,node('span',t(key==='jk_logbook'?'Логи BMS (журнал JK)':name)));list.append(row);
 }
 form.append(list,node('p',t(metadataHelp),'form-help'));
 if(draft.error){const error=node('p',t(draft.error),'error');error.setAttribute('role','alert');form.append(error)}
 const actions=node('div',undefined,'form-actions'),cancel=host.button(t('Отмена'),closeDialog);
 cancel.name='cancel';cancel.autofocus=true;cancel.disabled=Boolean(draft.busy);
 const submit=node('button',t(draft.busy?'Очистка…':'Удалить выбранное'),'pm-clear-confirm');submit.name='submit';submit.type='submit';
 const update=()=>{submit.disabled=Boolean(draft.busy||draft.error||!draft.scope||!draft.categories.size||scope.value!==draft.scope||scope.selectedOptions[0]?.disabled)};
 scope.onchange=()=>{draft.scope=scope.value;update()};update();actions.append(cancel,submit);form.append(actions);dialog.append(form);
 form.onsubmit=async event=>{
  event.preventDefault();if(submit.disabled||draft.busy)return;
  draft.busy=true;host.render();
  try{
   const result=await host.request('clear_storage',{scope:draft.scope,clearCategories:[...draft.categories],...(draft.scope==='external'?{archiveId:draft.archiveId}:{})});
   if(host._storageClear!==draft||host._device!==draft.device)return;
   if(result.failed?.length)draft.error='Часть данных не удалось удалить. Проверьте обновлённые размеры хранилищ.';
   else host._storageClearMessage=result.compacting||result.reclaimDeferred?.length?'Очистка завершена. Освобождение места может занять время.':'Очистка завершена.';
  }catch{
   if(host._storageClear===draft)draft.error='Результат очистки не подтверждён. Проверьте обновлённые данные перед повтором.';
  }finally{
   if(host._storageClear===draft){draft.busy=false;if(!draft.error)closeDialog();else host.render();await host.load()}
  }
 };
 dialog.oncancel=event=>{event.preventDefault();closeDialog()};
 queueMicrotask(()=>{
  if(!dialog.isConnected||host._storageClear!==draft)return;
  dialog.showModal();
  if(draft.focus)form.elements.namedItem(draft.focus)?.focus({preventScroll:true});
 });
 return dialog;
}
