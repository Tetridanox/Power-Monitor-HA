import {t,locale,setText,setProfileLanguage,watchLanguage} from './i18n.js?v=1.0.236';

const text=(tag,value)=>{const node=document.createElement(tag);setText(node,()=>value);return node};
const number=(value,digits=2)=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString(locale(),{maximumFractionDigits:digits}):'—';
const NS='http://www.w3.org/2000/svg';
export class PowerMonitorInsightsCard extends HTMLElement {
 constructor(){super();this.attachShadow({mode:'open'});this._period=30;this._slot=0;this._metric='deltaMax';this._revision=0}
 setConfig(config){if(this._config?.device!==config.device){++this._revision;this._priceDraft=null;this._battery=null;this._costs=null;this._loaded=false;this.shadowRoot.replaceChildren()}this._config={device:'auto',...config};if(this._hass&&this.isConnected)this.load()}
 set hass(hass){setProfileLanguage(hass.locale?.language||hass.language);this._hass=hass;if(this.isConnected&&!this._loaded)this.load()}
 set paused(value){this._paused=Boolean(value);if(!this._paused&&this.isConnected)this.load()}
 connectedCallback(){this._unsubscribe?.();this._unsubscribe=watchLanguage(this,()=>this.render());this._plotObserver?.disconnect();this._plotObserver=new ResizeObserver(entries=>{const width=Math.floor(entries[0]?.contentRect.width||0);if(width>0&&Math.abs(width-(this._graphWidth||0))>2){this._graphWidth=width;cancelAnimationFrame(this._resizeFrame);this._resizeFrame=requestAnimationFrame(()=>{this._resizeFrame=null;if(this.isConnected)this.render()})}});this._timer=setInterval(()=>{if(!document.hidden)this.load()},60000);if(this._hass)this.load()}
 disconnectedCallback(){clearInterval(this._timer);cancelAnimationFrame(this._resizeFrame);this._plotObserver?.disconnect();this._unsubscribe?.();++this._revision;this._loaded=false}
 async request(action,extra={}){return this._hass.callWS({type:'power_monitor_archive/query',action,device:this._device,...extra})}
 async load(){
  if(!this._hass||!this.isConnected||this._paused)return;
  if(this._busy){this._reload=true;return;}
  this._busy=true;const revision=++this._revision;
  try{
   const status=await this._hass.callWS({type:'power_monitor_archive/query',action:'status'});
   this._device=this._config?.device==='auto'||!this._config?.device?status.devices[0]?.deviceId:this._config.device;
   if(!this._device)throw Error('unknown_device');
   const end=Math.floor(Date.now()/1000),range={start:end-this._period*86400,end,maximum:1000};
   // Server readers share the archive and its one ESP owner. No device API here.
   const [battery,costs]=await Promise.all([this.request('analytics',{...range,slot:this._slot}),this.request('costs',range)]);
   if(revision!==this._revision||!this.isConnected)return;
   this._battery=battery;this._costs=costs;this._loaded=true;this._error=null;
  }catch(error){if(revision===this._revision)this._error=error.code||'archive_unavailable'}
  finally{this._busy=false;if(this.isConnected){this.render();if(this._reload){this._reload=false;this.load()}}}
 }
 select(label,items,value,change){
  const row=document.createElement('label');row.append(text('span',label));
  const select=document.createElement('select');for(const [key,name]of items){const option=document.createElement('option');option.value=key;option.textContent=name;select.append(option)}
  select.value=String(value);select.setAttribute('aria-label',label);select.disabled=this._busy;select.onchange=()=>change(select.value);row.append(select);return row;
 }
 button(label,run){const button=text('button',label);button.type='button';button.disabled=this._busy;button.onclick=run;return button}
 async savePrices(form){
  if(this._saving||!form.reportValidity())return;
  this._saving=true;this._priceError=false;form.querySelector('[type=submit]').disabled=true;
  try{
   const values=new FormData(form),minute=value=>{const [h,m]=value.split(':').map(Number);return h*60+m};
   await this.request('analysis_settings',{costSettings:{mode:values.get('mode'),dayPrice:Number(values.get('dayPrice')),
    nightPrice:Number(values.get('nightPrice')),nightStart:minute(values.get('nightStart')),nightEnd:minute(values.get('nightEnd')),
    currency:values.get('currency'),timeZone:values.get('timeZone')==='__ha__'?(this._hass.config.time_zone||'Europe/Kyiv'):values.get('timeZone'),timeZoneMode:values.get('timeZone')==='__ha__'?'home_assistant':'manual'}});
   this.shadowRoot.querySelector('dialog')?.close();form.remove();this._pricesOpen=false;this._priceDraft=null;await this.load();
  }catch{this._priceError=true}finally{this._saving=false;this.render()}
 }
 icon(name){const icon=document.createElement('ha-icon');icon.setAttribute('icon',name);return icon}
 card(title,subtitle){const card=document.createElement('ha-card'),header=document.createElement('header');header.className='card-heading';const words=document.createElement('div');words.append(text('h3',title));if(subtitle){const note=text('p',subtitle);note.className='muted';words.append(note)}header.append(words);card.append(header);return card}
 openPrices(){this._pricesOpen=true;this._priceError=false;this.shadowRoot.querySelector('dialog')?.showModal()}
 closePrices(){const dialog=this.shadowRoot.querySelector('dialog');dialog?.close();dialog?.querySelector('form')?.remove();this._pricesOpen=false;this._priceDraft=null;this.render()}
 render(){
  if(!this.shadowRoot)return;
  const old=this.shadowRoot.querySelector('form'),oldDialog=this.shadowRoot.querySelector('dialog');
  if(oldDialog?.open&&old)this._priceDraft=Object.fromEntries(new FormData(old));
  if(oldDialog)this._pricesOpen=oldDialog.open;
  const advanced=this.shadowRoot.querySelector('[data-advanced]');if(advanced)this._advancedOpen=advanced.open;
  const focused=this.shadowRoot.activeElement;
  const restore=old?.contains(focused)?{name:focused.name,start:focused.selectionStart,end:focused.selectionEnd}:null;
  this.shadowRoot.replaceChildren();
  const style=text('style',`
   :host{display:block;color:var(--primary-text-color);font:14px var(--paper-font-body1_-_font-family,system-ui);--pm-border:var(--ha-card-border-color,var(--divider-color));--pm-accent:var(--primary-color,#03a9f4)}
   *{box-sizing:border-box}[hidden]{display:none!important}h2,h3,p{margin:0}h2{font-size:24px;letter-spacing:-.5px;font-weight:650}h3{font-size:16px;font-weight:600;line-height:1.4}.page{padding:24px;display:grid;gap:18px}.page-heading{display:flex;justify-content:space-between;align-items:center;gap:20px}.page-heading p{margin-top:5px}.muted,.source{font-size:12px;line-height:1.6;color:var(--secondary-text-color)}.toolbar{display:flex;align-items:end;gap:12px;flex-wrap:wrap}.toolbar label{min-width:96px}.periods{display:flex;gap:3px;background:var(--secondary-background-color);padding:4px;border:1px solid var(--pm-border);border-radius:12px;align-self:end}.periods button{border:0;background:transparent;padding:8px 12px;font-size:13px}.periods .selected{background:var(--card-background-color);box-shadow:0 1px 4px #0002;color:var(--pm-accent)}
   ha-card{display:block;background:var(--ha-card-background,var(--card-background-color));border:1px solid var(--pm-border);border-radius:16px;padding:20px;box-shadow:var(--ha-card-box-shadow,none)}.card-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.card-heading p{margin-top:4px}.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.stat{display:flex;align-items:center;gap:15px}.stat-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:color-mix(in srgb,var(--pm-accent) 12%,transparent);color:var(--pm-accent);flex-shrink:0}.stat-icon ha-icon{--mdc-icon-size:22px}.stat-label{display:block;font-size:12px;color:var(--secondary-text-color);margin-bottom:6px}.stat strong{font-size:28px;letter-spacing:-.6px;line-height:1.2}.stat .unit{font-size:14px;color:var(--secondary-text-color);margin-left:5px;font-weight:400}
   label{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;font-size:12px;color:var(--secondary-text-color)}input,select,button{font:inherit;border-radius:10px;color:var(--primary-text-color);border:1px solid var(--pm-border);background:var(--secondary-background-color);max-width:100%}input,select{padding:10px 12px;min-width:0;min-height:40px}button{cursor:pointer;padding:9px 14px;font-size:13px;min-height:38px}button:hover{filter:brightness(1.08)}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--pm-accent);outline-offset:3px}button:disabled{opacity:.5;cursor:default}.icon-button{width:40px;padding:8px;display:grid;place-items:center;background:transparent}.icon-button ha-icon{--mdc-icon-size:20px}.primary{background:var(--pm-accent);border-color:var(--pm-accent);color:var(--text-primary-color,#fff)}.text-button{background:transparent;border-color:transparent}.plot{min-width:0}svg{display:block;width:100%;height:280px}.chart-card .card-heading{margin-bottom:8px}.chart-card .card-heading label>span{display:none}.chart-card select{min-width:170px}.chart-range{text-align:right;margin-top:0}.lower{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:18px;align-items:start}.lower>ha-card{min-width:0}.heatmap{overflow:auto;max-height:320px}table{border-collapse:collapse;font-size:12px;width:max-content;min-width:100%}th,td{padding:7px 6px;text-align:center;white-space:nowrap}th{font-weight:500;color:var(--secondary-text-color)}th:first-child{text-align:left}tr:first-child th{position:sticky;top:0;background:var(--ha-card-background,var(--card-background-color))}td button{min-width:38px;min-height:36px;padding:5px;font-size:12px}@media(hover:none) and (pointer:coarse){td button{min-width:44px;min-height:44px}}.cell-selection:empty{display:none}.cell-selection{font-size:12px;margin-top:10px;color:var(--secondary-text-color)}details{font-size:12px;margin-top:14px}summary{cursor:pointer;color:var(--secondary-text-color);line-height:1.6}.source{margin-top:14px}.empty{padding:55px 16px;text-align:center;color:var(--secondary-text-color)}.money-label{font-size:12px;color:var(--secondary-text-color);margin-bottom:8px}.money{display:flex;align-items:baseline;gap:8px;font-size:36px;font-weight:650;letter-spacing:-.8px;line-height:1.25}.money small{font-size:16px;font-weight:400;letter-spacing:0;color:var(--secondary-text-color)}.cost-breakdown{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:22px;padding-top:18px;border-top:1px solid var(--pm-border)}.cost-breakdown span{display:block;color:var(--secondary-text-color);font-size:12px;line-height:1.5;margin-bottom:7px}.cost-breakdown strong{font-size:19px;font-weight:550}.cost-footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;margin-top:20px;font-size:12px;color:var(--secondary-text-color)}.cost-note{font-size:12px;color:var(--secondary-text-color);line-height:1.65;margin-top:10px}.page-footer{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;padding:0 2px}.page-footer a{color:var(--pm-accent);text-decoration:none;font-size:12px}.page-footer a:hover{text-decoration:underline}.error{color:var(--error-color);font-size:13px;padding:12px;border-radius:10px;background:color-mix(in srgb,var(--error-color) 8%,transparent)}
   dialog{padding:0;width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 40px);overflow:auto;position:fixed;border:1px solid var(--pm-border);border-radius:20px;background:var(--card-background-color);color:var(--primary-text-color);box-shadow:0 20px 70px #0005}dialog::backdrop{background:#0008;backdrop-filter:blur(3px)}.dialog-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 24px 16px}.dialog-heading h3{font-size:20px}.dialog-heading p{margin-top:5px}.tariff-form{display:grid;gap:20px;padding:0 24px 24px}.tariff-form input,.tariff-form select{width:100%;font-size:14px}.form-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.field-hint{font-size:11px;color:var(--secondary-text-color);font-weight:400}.night-fields{display:grid;gap:20px}.night-fields[hidden]{display:none}.form-actions{display:flex;justify-content:flex-end;gap:10px;padding-top:16px;border-top:1px solid var(--pm-border)}.tariff-form details{margin-top:0}.tariff-form details label{margin-top:12px}.form-pair .full{grid-column:1/-1}.form-help{font-size:12px;color:var(--secondary-text-color);line-height:1.6}
   @media(min-width:1600px){.page{padding:28px 32px;gap:20px}.lower{grid-template-columns:minmax(0,1.2fr) minmax(0,1fr)}}@media(max-width:850px){.lower{grid-template-columns:minmax(0,1fr)}.page-heading{align-items:start;flex-direction:column;gap:16px}.toolbar{width:100%}.toolbar label{flex:1}.stats{gap:10px}.stat{gap:10px}.stat-icon{width:34px;height:34px}.stat strong{font-size:24px}}@media(max-width:500px){.page{padding:14px;gap:12px}h2{font-size:22px}ha-card{padding:16px;border-radius:14px}.stats{gap:8px}.stat{display:block;padding:12px}.stat-icon{display:none}.stat strong{font-size:23px}.stat .unit{font-size:11px;margin-left:3px}.stat-label{font-size:11px;min-height:28px;margin-bottom:4px}.card-heading{gap:10px}.chart-card .card-heading{align-items:start}.chart-card select{min-width:0;max-width:150px;font-size:12px}.periods button{padding:8px 10px}.toolbar{gap:8px}.toolbar label{min-width:75px}.money{font-size:32px}.dialog-heading{padding:18px}.tariff-form{padding:0 18px 18px;gap:18px}.form-pair{gap:12px}.page-footer{align-items:start;flex-direction:column}.page-footer .muted{font-size:11px}}
  `);
  const page=document.createElement('main');page.className='page';
  const heading=document.createElement('header');heading.className='page-heading';const title=document.createElement('div');title.append(text('h2',t('Аналитика')),text('p',t('Батарея и энергия')));title.lastChild.className='muted';
  const toolbar=document.createElement('div');toolbar.className='toolbar';const periods=document.createElement('div');periods.className='periods';periods.setAttribute('role','group');periods.setAttribute('aria-label',t('Период'));
  for(const [value,label]of [[30,t('30 дней')],[365,t('Год')]]){const b=this.button(label,()=>{this._period=value;this.load()});b.classList.toggle('selected',this._period===value);b.setAttribute('aria-pressed',String(this._period===value));periods.append(b)}
  toolbar.append(periods,this.select(t('Батарея'),[['0','BMS 1'],['1','BMS 2']],this._slot,value=>{this._slot=Number(value);this.load()}));const refresh=this.button('',()=>this.load());refresh.className='icon-button';refresh.append(this.icon('mdi:refresh'));refresh.title=t('Обновить');refresh.setAttribute('aria-label',t('Обновить'));toolbar.append(refresh);heading.append(title,toolbar);page.append(heading);
  if(this._error){const error=text('p',t('Не удалось обновить данные'));error.className='error';error.setAttribute('role','alert');page.append(error)}
  const stats=document.createElement('div');stats.className='stats';this.renderStats(stats);page.append(stats);
  const chart=this.card(t('Динамика батареи'));chart.className='chart-card';chart.querySelector('header').append(this.select(t('График'),[['deltaMax',t('Разброс ячеек ΔV, mV')],['stateOfHealth',t('Здоровье SOH, %')],['cycleCount',t('Циклы')]],this._metric,value=>{this._metric=value;this.render()}));
  const plot=document.createElement('div');plot.className='plot';this.renderGraph(plot);chart.append(plot);page.append(chart);
  const lower=document.createElement('div');lower.className='lower';const cells=this.card(t('Ячейки'),t('Отклонение от среднего · mV'));this.renderCells(cells);const costs=this.card(t('Энергия и стоимость'));this.renderCosts(costs);lower.append(cells,costs);page.append(lower);
  const footer=document.createElement('footer');footer.className='page-footer';const note=text('span',t('История BMS обновляется каждые 5 минут'));note.className='muted';const link=text('a',t('Открыть панель энергии'));link.href='/energy';footer.append(note,link);page.append(footer);
  const dialog=this.renderTariffDialog();this.shadowRoot.append(style,page,dialog);this._plotObserver?.disconnect();this._plotObserver?.observe(plot);
  Promise.all([chart.updateComplete,costs.updateComplete]).then(()=>{if(!dialog.isConnected)return;if(this._pricesOpen&&!dialog.open)dialog.showModal();if(restore){const field=dialog.querySelector('form')?.elements.namedItem(restore.name);if(field?.isConnected){field.focus({preventScroll:true});if(restore.start!==null)try{field.setSelectionRange(restore.start,restore.end)}catch{}}}});
 }
 renderStats(parent){
  const points=this._battery?.points||[],last=points.at(-1),values=points.map(p=>p.deltaMax).filter(v=>typeof v==='number'&&Number.isFinite(v));
  const delta=values.length?Math.max(...values)*1000:null;
  for(const [label,value,unit,icon]of [['SOH',number(last?.stateOfHealth,1),'%','mdi:battery-heart-outline'],[t('Циклы'),number(last?.cycleCount,0),'','mdi:history'],['ΔV max',number(delta,1),'mV','mdi:arrow-expand-vertical']]){
   const card=document.createElement('ha-card');card.className='stat';const badge=document.createElement('div');badge.className='stat-icon';badge.append(this.icon(icon));const data=document.createElement('div');const caption=text('span',label);caption.className='stat-label';const strong=text('strong',value);if(unit){const suffix=text('span',unit);suffix.className='unit';strong.append(suffix)}data.append(caption,strong);card.append(badge,data);parent.append(card);
  }
 }
 renderGraph(card){
  const data=this._battery||{},points=data.points||[];
  if(points.length){
   const width=Math.max(280,this._graphWidth||1000),left=46,right=width-16,bottom=235,height=280;
   const svg=document.createElementNS(NS,'svg');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('role','img');svg.setAttribute('aria-label',t({deltaMax:'Разброс ячеек ΔV, mV',stateOfHealth:'Здоровье SOH, %',cycleCount:'Циклы'}[this._metric]||this._metric));
   const values=points.map(p=>typeof p[this._metric]==='number'?p[this._metric]*(this._metric==='deltaMax'?1000:1):null);
   const high=this._metric==='stateOfHealth'?100:Math.max(1,...values.filter(v=>v!==null));
   const first=points[0].timestamp,span=Math.max(1,points.at(-1).timestamp-first);
   let path='',pen=false,prior=null;points.forEach((p,i)=>{const v=values[i];if(v===null){pen=false;return}if(prior!==null&&p.timestamp-prior>Math.max(600,(data.downsampleSeconds||300)*2))pen=false;
    path+=(pen?'L':'M')+(left+(p.timestamp-first)/span*(right-left)).toFixed(1)+' '+(bottom-v/high*210).toFixed(1)+' ';pen=true;prior=p.timestamp});
   const line=document.createElementNS(NS,'path');line.setAttribute('d',path);line.setAttribute('fill','none');line.setAttribute('stroke','var(--primary-color)');line.setAttribute('stroke-width','2');svg.append(line);
   for(let i=0;i<=4;i++){const label=document.createElementNS(NS,'text');label.setAttribute('x','2');label.setAttribute('y',String(bottom+4-i*52.5));label.setAttribute('fill','var(--secondary-text-color)');label.setAttribute('font-size','12');label.textContent=number(high*i/4,1);svg.append(label)}
   for(let i=0;i<=2;i++){const label=document.createElementNS(NS,'text');label.setAttribute('x',String(left+(right-left)*i/2));label.setAttribute('y','265');label.setAttribute('text-anchor',i===0?'start':i===2?'end':'middle');label.setAttribute('fill','var(--secondary-text-color)');label.setAttribute('font-size','11');label.textContent=span<172800?new Date((first+span*i/2)*1000).toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit'}):new Date((first+span*i/2)*1000).toLocaleDateString(locale(),{month:'2-digit',day:'2-digit'});svg.append(label)}
   if(this._metric==='stateOfHealth'){const eol=document.createElementNS(NS,'line');for(const [k,v]of Object.entries({x1:left,x2:right,y1:bottom-168,y2:bottom-168,stroke:'var(--warning-color)', 'stroke-dasharray':'5 5'}))eol.setAttribute(k,v);svg.append(eol)}
   const dates=text('p',new Date(first*1000).toLocaleDateString(locale())+' — '+new Date(points.at(-1).timestamp*1000).toLocaleDateString(locale()));dates.className='muted';card.append(svg,dates);
  }else{const empty=text('p',t('История батареи ещё накапливается'));empty.className='empty';card.append(empty)}
  const info=document.createElement('details');info.append(text('summary',t('О показателях батареи')));const note=text('p',t('SOH передаёт BMS; линия 80% — справочный уровень. ΔV зависит от SOC, тока и температуры. Прогноз отказа не выполняется.'));note.className='cost-note';info.append(note);card.append(info);
 }
 renderCells(card){
  const data=this._battery||{};
  const days=(data.heatmap||[]).slice(-31);
  if(!days.length){const empty=text('p',t('Нет данных от выбранной BMS'));empty.className='empty';card.append(empty)}
  if(days.length){
   const wrap=document.createElement('div');wrap.className='heatmap';
   const cellCount=Number.isInteger(data.cellCount)&&data.cellCount>=0&&data.cellCount<=32?data.cellCount:0;
   const table=document.createElement('table'),head=document.createElement('tr');head.append(text('th',t('Дата')));for(let i=1;i<=cellCount;i++)head.append(text('th',String(i)));table.append(head);
   const selection=text('p','');selection.className='cell-selection';selection.setAttribute('role','status');
   for(const day of days){const row=document.createElement('tr');row.append(text('th',day.date));day.deviationMv.slice(0,cellCount).forEach((v,i)=>{
    const cell=document.createElement('td'),button=this.button(number(v,1),()=>{selection.textContent=day.date+' · '+(i+1)+': '+number(v,2)+' mV'});
    button.title=day.date+' · '+(i+1)+': '+number(v,2)+' mV';button.setAttribute('aria-label',button.title);
    if(typeof v==='number')button.style.background=`color-mix(in srgb,${v<0?'var(--info-color,#42a5f5)':'var(--warning-color,#ffb52e)'} ${Math.min(70,Math.abs(v)*3)}%,transparent)`;
    cell.append(button);row.append(cell)});table.append(row)}wrap.append(table);card.append(wrap,selection);
   const heatNote=text('p',t('Последние 31 день выбранного периода. Цвет показывает среднее отклонение в наблюдавшихся состояниях батареи.'));heatNote.className='muted';card.append(heatNote);
  }
  const source=text('p','BMS '+(this._slot+1)+(data.cellCount>0?' · '+number(data.cellCount,0)+' '+t('ячеек'):''));source.className='source';if(data.identity)source.title='MAC: '+data.identity;card.append(source);
  const details=document.createElement('details');details.append(text('summary',t('Наблюдения балансировки')));
  for(const event of data.balancing||[])details.append(text('p',new Date(event.timestamp*1000).toLocaleString(locale())+' · '+t(event.active?'Включено':'Выключено')+(event.afterGap?' · '+t('После пропуска данных'):'')));
  const balanceNote=text('p',t('Проверка раз в 5 минут: это наблюдения состояния, время реального переключения может отличаться.'));balanceNote.className='muted';details.append(balanceNote);card.append(details);
 }
 renderCosts(card){
  const data=this._costs||{},currency=data.settings?.currency||'UAH';
  const prices=this.button(t('Тарифы'),()=>this.openPrices());prices.disabled=false;card.querySelector('header').append(prices);
  card.append(text('p',t('Стоимость энергии из сети')));card.lastChild.className='money-label';const money=text('div',data.configured?number(data.cost):'—');money.className='money';money.append(text('small',currency));card.append(money);
  const breakdown=document.createElement('div');breakdown.className='cost-breakdown';
  for(const [label,value]of [[t('Энергия из сети'),number(data.gridKwh)+' kWh'],[t('Оценка стоимости генерации PV (по тарифу)'),(data.configured?number(data.pvValueEstimate):'—')+' '+currency]]){const box=document.createElement('div');box.append(text('span',label),text('strong',value));breakdown.append(box)}card.append(breakdown);
  const footer=document.createElement('div');footer.className='cost-footer';footer.append(text('span',t('Покрытие измерениями')+': '+number(data.coveredSeconds/3600,1)+' h'));if(!data.configured)footer.append(text('span',t('Укажите тариф для расчёта')));card.append(footer);
  const help=document.createElement('details');help.append(text('summary',t('Как считается стоимость')));const note=text('p',t('Цены формы применяются ко всему выбранному периоду. Это оценка по данным Power Monitor, не счёт поставщика. Стоимость PV не равна измеренной экономии. Для день/ночь учитываются только сохранившиеся минутные интервалы.'));note.className='cost-note';help.append(note);card.append(help);
 }
 renderTariffDialog(){
  const settings={...(this._costs?.settings||{}),...(this._priceDraft||{})};const dialog=document.createElement('dialog');dialog.setAttribute('aria-labelledby','tariff-title');
  const heading=document.createElement('header');heading.className='dialog-heading';const words=document.createElement('div'),title=text('h3',t('Тарифы на электроэнергию'));title.id='tariff-title';words.append(title,text('p',t('Цены для расчёта стоимости')));words.lastChild.className='muted';const close=this.button('',()=>this.closePrices());close.disabled=false;close.className='icon-button';close.append(this.icon('mdi:close'));close.setAttribute('aria-label',t('Закрыть'));heading.append(words,close);dialog.append(heading);
  const form=document.createElement('form');form.className='tariff-form';
  const mode=this.select(t('Тариф'),[['flat',t('Одна цена')],['day_night',t('День / ночь')]],settings.mode||'flat',()=>{});mode.querySelector('select').disabled=false;mode.querySelector('select').name='mode';const tariffRow=document.createElement('div');tariffRow.className='form-pair';form.append(tariffRow);
  const field=(key,label,type,fallback)=>{const row=document.createElement('label'),input=document.createElement('input');row.append(text('span',label));input.name=key;input.type=type;input.required=true;let value=settings[key]??fallback;if(type==='time'&&typeof value==='number')value=String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');input.value=String(value);if(type==='number'){input.min='0';input.max='10000';input.step='0.0001'}if(key==='currency'){input.maxLength=3;input.pattern='[A-Z]{3}'}if(key==='timeZone')input.maxLength=64;row.append(input);return row};
  const main=document.createElement('div');main.className='form-pair';const day=field('dayPrice',t('Цена за kWh'),'number',''),currency=field('currency',t('Валюта'),'text','UAH'),nightPrice=field('nightPrice',t('Ночная цена'),'number',0);tariffRow.append(mode,currency);main.append(day,nightPrice);form.append(main);
  const night=document.createElement('div');night.className='night-fields';const hours=document.createElement('div');hours.className='form-pair';hours.append(field('nightStart',t('Начало ночи'),'time','23:00'),field('nightEnd',t('Конец ночи'),'time','07:00'));night.append(hours);form.append(night);
  const updateMode=()=>{const split=mode.querySelector('select').value==='day_night';night.hidden=!split;nightPrice.hidden=!split;day.classList.toggle('full',!split);day.firstChild.textContent=t(split?'Дневная цена':'Цена за kWh')};mode.querySelector('select').onchange=updateMode;updateMode();
  const advanced=document.createElement('details');advanced.dataset.advanced='';advanced.open=Boolean(this._advancedOpen);const haZone=this._hass?.config?.time_zone||'Europe/Kyiv';const selectedZone=this._priceDraft?.timeZone??(this._costs?.configured&&settings.timeZoneMode==='manual'?settings.timeZone:'__ha__');const zones=[...new Set([haZone,settings.timeZone,...(Intl.supportedValuesOf?.('timeZone')||[])].filter(Boolean))].sort();const zone=this.select(t('Часовой пояс'),[['__ha__',t('Как в Home Assistant')+' · '+haZone],...zones.map(value=>[value,value.replaceAll('_',' ')])],selectedZone,()=>{});zone.querySelector('select').name='timeZone';zone.querySelector('select').disabled=false;advanced.append(text('summary',t('Дополнительно')),zone);form.append(advanced);
  const note=text('p',t('Новые цены применяются ко всему выбранному периоду.'));note.className='form-help';form.append(note);if(this._priceError){const error=text('p',t('Не удалось сохранить тариф. Проверьте значения и повторите.'));error.className='error';error.setAttribute('role','alert');form.append(error)}
  const actions=document.createElement('div');actions.className='form-actions';const cancel=this.button(t('Отмена'),()=>this.closePrices());cancel.className='text-button';cancel.disabled=this._saving;const save=text('button',t('Сохранить'));save.type='submit';save.className='primary';save.disabled=this._saving;actions.append(cancel,save);form.append(actions);form.onsubmit=event=>{event.preventDefault();this.savePrices(form)};dialog.oncancel=event=>{event.preventDefault();this.closePrices()};dialog.onclick=event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)this.closePrices()}};dialog.append(form);return dialog;
 }
 getCardSize(){return 12}
 static getStubConfig(){return {device:'auto'}}
}
if(typeof customElements!=='undefined'&&!customElements.get('power-monitor-insights-card'))customElements.define('power-monitor-insights-card',PowerMonitorInsightsCard);
