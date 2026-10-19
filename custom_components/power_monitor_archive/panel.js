/* Native HA panel. All data travels over the authenticated HA connection. */
const PM_SERIES=[
  {id:'load',name:'Потребление',color:'#57b5f5'},
  {id:'grid',name:'Из сети',color:'#f2b44c'},
  {id:'pv',name:'Солнечная генерация',color:'#53cc9b'},
  {id:'batteryCharge',name:'Заряд батареи',color:'#b994f6'},
  {id:'batteryDischarge',name:'Разряд батареи',color:'#f38596'}
];
for(const s of PM_SERIES){s.field=s.id+'Power';s.unit='Вт';s.source=s.id.startsWith('battery')?'battery':'inverter'}
const PM_EXTRA=[
 {id:'pvVoltage',field:'pvVoltage',name:'Напряжение PV',color:'#28d5e6',unit:'В',source:'inverter'},
 {id:'inverterTemperature',field:'inverterTemperature',name:'Температура инвертора',color:'#ff7043',unit:'°C',source:'inverter'},
 {id:'gridVoltage',field:'gridVoltage',name:'Напряжение сети',color:'#f2b44c',unit:'В',source:'inverter'},
 {id:'outputVoltage',field:'outputVoltage',name:'Выходное напряжение',color:'#57b5f5',unit:'В',source:'inverter'},
 {id:'batteryVoltage',field:'batteryVoltage',name:'Напряжение батареи',color:'#b994f6',unit:'В',source:'battery'},
 {id:'soc',field:'soc',name:'Заряд батареи',color:'#53cc9b',unit:'%',source:'battery'}
];
const PM_GROUPS={power:[...PM_SERIES,...PM_EXTRA.slice(0,2)],energy:PM_SERIES,
 voltage:PM_EXTRA.filter(s=>s.unit==='В'),temperature:PM_EXTRA.filter(s=>s.unit==='°C'),soc:PM_EXTRA.filter(s=>s.unit==='%')};
class PowerMonitorPanel extends HTMLElement {
  constructor() {
    super(); this.attachShadow({mode:'open'}); this._devices=[]; this._busy=false;this._visible=new Set([...PM_SERIES,...PM_EXTRA].map(s=>s.id));
  }
  set hass(hass) {
    this._hass=hass;
    if (!this._mounted && this.isConnected) this.mount();
  }
  connectedCallback() { if(this._hass&&!this._mounted)this.mount(); }
  disconnectedCallback() { clearInterval(this._timer);this._resize?.disconnect(); this._mounted=false; }
  el(id) { return this.shadowRoot.getElementById(id); }
  async api(action, args={}) {
    return this._hass.callWS({type:'power_monitor_archive/query',action,...args});
  }
  navigate(path) {
    history.pushState(null,'',path); window.dispatchEvent(new CustomEvent('location-changed'));
  }
  mount() {
    this._mounted=true;
    this.shadowRoot.innerHTML=`<style>
      :host{display:block;height:100%;overflow:auto;background:var(--primary-background-color);color:var(--primary-text-color);font-family:var(--paper-font-body1_-_font-family,system-ui)}
      *{box-sizing:border-box}.toolbar{height:64px;display:flex;align-items:center;gap:16px;padding:0 20px;background:var(--app-header-background-color,var(--primary-background-color));color:var(--app-header-text-color,var(--primary-text-color));border-bottom:1px solid var(--divider-color)}
      .toolbar strong{font-size:20px;font-weight:500}.menu{border:0;background:transparent;color:inherit;font-size:24px;padding:8px}main{max-width:1250px;padding:24px;margin:auto}.card{background:var(--ha-card-background,var(--card-background-color));border:1px solid var(--divider-color);border-radius:var(--ha-card-border-radius,12px);padding:22px;margin-bottom:20px}
      h1{font-size:24px;margin:0 0 8px}h2{font-size:20px;margin:0 0 16px}p{line-height:1.6}.muted{color:var(--secondary-text-color);font-size:14px}.row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end}.grow{flex:1;min-width:200px}label{display:flex;flex-direction:column;gap:6px;font-size:13px}button,select,input{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--divider-color);background:var(--secondary-background-color);color:var(--primary-text-color);max-width:100%}button{cursor:pointer}button.primary{background:var(--primary-color);color:var(--text-primary-color,#fff);border-color:var(--primary-color)}button:disabled{opacity:.5;cursor:wait}svg{display:block;width:100%;height:330px}svg text{fill:var(--secondary-text-color);font-size:12px}.hidden{display:none!important}#message{min-height:24px}#summary{line-height:1.6}.title{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:center;margin-bottom:20px}.notice{padding:12px 0;line-height:1.6}a{color:var(--primary-color)}@media(max-width:600px){main{padding:12px}.card{padding:16px}svg{height:270px}.row>*{flex:1;min-width:120px}}
      .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0 18px}.stat{padding:16px;border:1px solid var(--divider-color);border-radius:10px;min-width:0}.stat-name{font-size:13px;display:flex;align-items:center;gap:7px}.dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex-shrink:0}.stat-value{font-size:25px;font-weight:600;margin:9px 0 3px}.stat-note{font-size:12px;color:var(--secondary-text-color);line-height:1.5}.legend{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.legend button{padding:6px 10px;font-size:13px;display:flex;align-items:center;gap:7px}.legend button[aria-pressed=false]{opacity:.45}.plot-wrap{position:relative}svg{height:380px;touch-action:pan-y;user-select:none}.tooltip{position:absolute;z-index:2;pointer-events:none;min-width:240px;max-width:310px;background:var(--ha-card-background,var(--card-background-color));box-shadow:0 4px 24px #0006;border:1px solid var(--divider-color);border-radius:10px;padding:14px;font-size:13px}.tip-head{font-weight:600;margin-bottom:9px}.tip-row{display:flex;justify-content:space-between;gap:24px;margin:6px 0}.tip-row span:first-child{display:flex;align-items:center;gap:7px}.tip-extra{border-top:1px solid var(--divider-color);margin-top:10px;padding-top:6px;color:var(--secondary-text-color)}.chart-help{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-top:10px}.brand{width:30px;height:30px}.period-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}.period-heading strong{font-size:16px;font-weight:500}.warning{color:var(--warning-color,#f2b44c)}.axis-grid{stroke:var(--divider-color);stroke-dasharray:3 5;opacity:.65}.zoom{display:flex;gap:6px}.zoom button{padding:5px 11px}.details{margin-top:24px;font-size:13px;color:var(--secondary-text-color)}.details summary{cursor:pointer}@media(max-width:850px){.stats{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:600px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stat{padding:12px}.stat-value{font-size:21px}svg{height:290px}.tooltip{min-width:220px;max-width:280px}.legend button{font-size:12px}.chart-help{font-size:12px}}
      </style><div class="toolbar"><button id="menu" class="menu" aria-label="Открыть меню">☰</button><img class="brand" src="/power_monitor_archive/brand.svg" alt=""><strong>Power Monitor</strong></div>
      <main><div class="title"><div><h1>История Power Monitor</h1><div class="muted">Архив на вашем Home Assistant</div></div><button id="add" class="primary">Добавить устройство</button></div>
      <section id="empty" class="card hidden"><h2>Подключите ваш Power Monitor</h2><p>1. На ESP откройте <strong>Home Assistant → Увімкнути інтеграцію → Отримати код на 2 хвилини</strong> и скопируйте код.</p><p>2. Нажмите «Добавить устройство» здесь и вставьте код в окно Home Assistant.</p><p>История загрузится автоматически. Для просмотра используйте этот раздел — отдельный адрес или пароль не нужны.</p></section>
      <section id="archive" class="card"><div class="row"><label class="grow">Устройство<select id="device"></select></label><button id="resume" class="hidden">Проверить подключение</button></div><div id="summary" class="notice" role="status"></div><div id="coverage" class="muted"></div></section>
      <section id="charts" class="card"><h2>Графики</h2><div class="row"><label>Что показать<select id="mode"><option value="power">Поток энергии</option><option value="energy">Энергия по дням</option><option value="voltage">Напряжения</option><option value="temperature">Температура инвертора</option><option value="soc">Заряд батареи · SOC</option></select></label><label>Показатели<select id="metric"><option value="all">Все потоки энергии</option><option value="load">Потребление</option><option value="grid">Из сети</option><option value="pv">Солнечная генерация</option><option value="batteryCharge">Заряд батареи</option><option value="batteryDischarge">Разряд батареи</option></select></label><label>Период<select id="period"><option value="1">24 часа</option><option value="7">7 дней</option><option value="30">30 дней</option><option value="365">Год</option><option value="all">Весь сохранённый период</option><option value="custom">Выбрать даты</option></select></label><label>С<input type="date" id="from"></label><label>По<input type="date" id="to"></label><button id="show" class="primary">Показать</button><button id="csv">CSV графика</button></div><div id="stats" class="stats"></div><div class="period-heading"><strong id="range"></strong><div class="zoom"><button id="zoom-in" aria-label="Приблизить период">＋</button><button id="zoom-out" aria-label="Отдалить период">−</button></div></div><div id="legend" class="legend"></div><p id="message" role="status" class="muted"></p><div class="plot-wrap"><svg id="plot" viewBox="0 0 1100 380" role="img" aria-label="График сохранённой истории" tabindex="0"></svg><div id="tooltip" class="tooltip hidden"></div></div><div class="chart-help muted"><span>Наведите курсор или коснитесь графика — значения за выбранный момент.</span><span id="gap-info"></span></div></section>
      <details class="details"><summary>О хранении и полноте истории</summary><p>Архив находится в Home Assistant и доступен при выключенной ESP. Записи сохраняются без автоматического удаления. Средняя мощность рассчитана по сохранённым измерениям, энергия — по суточным итогам ESP. Пропуски не заменяются нулями. Сегодняшний итог ещё уточняется.</p></details></main>`;
    this.el('menu').onclick=()=>this.dispatchEvent(new CustomEvent('hass-toggle-menu',{bubbles:true,composed:true}));
    this.el('add').onclick=()=>this.navigate('/config/integrations/dashboard/add?domain=power_monitor_archive');
    this.el('resume').onclick=async()=>{try{await this.api('resume',{device:this.el('device').value});await this.refresh()}catch(e){this.showError(e)}};
    for(const id of ['device','mode','metric','period'])this.el(id).onchange=()=>{if(id==='period')this._zoomRange=null;return id==='device'?this.refresh():this.draw()};
    this.el('show').onclick=()=>this.draw();this.el('csv').onclick=()=>this.exportCsv();
    this.el('zoom-in').onclick=()=>this.zoom(.5);this.el('zoom-out').onclick=()=>this.zoom(2);
    this.el('plot').onpointermove=e=>this.inspect(e);this.el('plot').onpointerdown=e=>this.inspect(e);
    this.el('plot').onpointerleave=e=>{if(e.pointerType!=='touch')this.hideTip()};
    this.el('plot').onkeydown=e=>{if(!this._plotData?.points.length)return;if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();this._hoverIndex=Math.max(0,Math.min(this._plotData.points.length-1,(this._hoverIndex||0)+(e.key==='ArrowRight'?1:-1)));this.inspectIndex(this._hoverIndex)}};
    for(const id of ['from','to'])this.el(id).onchange=()=>{this.el('period').value='custom';this._zoomRange=null};
    this._resize=new ResizeObserver(()=>{if(this._plotData)this.renderPlot(this._plotData)});this._resize.observe(this);
    this.el('to').value=this.dateInput(new Date());this.el('from').value=this.dateInput(new Date(Date.now()-7*86400000));
    this.refresh();this._timer=setInterval(()=>this.refresh(),60000);
  }
  dateInput(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
  showError(error){this.el('message').textContent='Не удалось прочитать архив. Попробуйте обновить страницу.';console.warn('Power Monitor archive:',error?.code||'unavailable')}
  async refresh(){
    if(this._refreshing)return;this._refreshing=true;
    try{
      const s=await this.api('status'),previous=this.el('device').value;this._devices=s.devices;
      this.el('device').replaceChildren(...s.devices.map(d=>{const o=document.createElement('option');o.value=d.deviceId;o.textContent=d.name;return o}));
      if(s.devices.some(d=>d.deviceId===previous))this.el('device').value=previous;
      for(const id of ['archive','charts'])this.el(id).classList.toggle('hidden',!s.devices.length);
      this.el('empty').classList.toggle('hidden',!!s.devices.length);
      if(!s.devices.length)return;
      const d=s.devices.find(d=>d.deviceId===this.el('device').value),done=d.minuteBackfillComplete&&d.dailyBackfillComplete;
      const messages={starting:'Подключаемся к ESP…',syncing:done?'Доступная история ESP загружена. Новые данные сохраняются автоматически.':'Первая загрузка истории. Полученные данные уже доступны.',grant_disabled_or_revoked:'Доступ к ESP остановлен. Если вы выключали интеграцию на ESP, включите её и нажмите «Проверить подключение». Если доступ отозван, подключите устройство заново по новому коду. Сохранённые графики доступны.',identity_changed_pairing_required:'История устройства изменилась. Требуется повторное подключение. Прежний архив сохранён.',source_or_storage_error:'ESP или хранилище временно недоступны. Повторим загрузку автоматически.'};
      this.el('resume').classList.toggle('hidden',d.state!=='grant_disabled_or_revoked'||!!s.writerError);
      this.el('summary').textContent=s.writerError?'Хранилище недоступно. Сохранённые данные не удалены.':messages[d.state]||'Повторяем соединение с ESP…';
      this._coverage=await this.api('coverage',{device:d.deviceId});const c=this._coverage;
      this.el('coverage').textContent=`История с ${c.firstDay?new Date(c.firstDay*1000).toLocaleDateString():'первого сохранённого измерения'}. Последняя связь: ${d.lastSuccess?new Date(d.lastSuccess*1000).toLocaleString():'ожидается'}.`;
      await this.draw();
    }catch(e){this.showError(e)}finally{this._refreshing=false}
  }
  async draw(){
    if(this._busy){this._redraw=true;return}const device=this.el('device').value;if(!device)return;
    this._busy=true;this.el('message').textContent='Загружаем график из архива HA…';
    try{
      const mode=this.el('mode').value,energy=mode==='energy',c=this._coverage||{},period=this.el('period').value;
      const metric=this.el('metric'),selected=metric.value;metric.replaceChildren(...[{id:'all',name:'Все показатели'},...PM_GROUPS[mode]].map(s=>{const o=document.createElement('option');o.value=s.id;o.textContent=s.name;return o}));metric.value=[...metric.options].some(o=>o.value===selected)?selected:'all';
      let end=Math.floor(Date.now()/1000)+1,start;
      if(period==='all'){start=(energy?c.firstDay:c.first)||end-86400;end=Math.max(end,(energy?c.lastDay:c.last)||0)+1}
      else if(period==='custom'){start=this._zoomRange?.start??Math.floor(new Date(this.el('from').value+'T00:00:00').getTime()/1000);end=this._zoomRange?.end??Math.floor(new Date(this.el('to').value+'T23:59:59').getTime()/1000)}
      else start=end-Number(period)*86400;
      if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end){this.el('message').textContent='Выберите корректный диапазон дат.';return}
      for(const id of ['from','to'])this.el(id).disabled=period!=='custom';
      if(period!=='custom'){this.el('from').value=this.dateInput(new Date(start*1000));this.el('to').value=this.dateInput(new Date(end*1000))}
      const data=await this.api(energy?'days':'history',{device,start,end,maximum:1440}),points=data.points||[];
      this._plotData={data,points,energy,start,end,mode};this.renderPlot(this._plotData);
      this.el('message').textContent=points.length?'':'В выбранном диапазоне пока нет сохранённых данных.';
      this.el('range').textContent=`${new Date(start*1000).toLocaleDateString()} — ${new Date(end*1000).toLocaleDateString()}${!energy&&end-start<=86401?' · '+new Date(start*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+'–'+new Date(end*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):''}`;
      this._lastGraph={kind:energy?'daily':'minute',points:points.length,start,end,source:data.source};
    }catch(e){this.showError(e)}finally{this._busy=false;if(this._redraw){this._redraw=false;this.draw()}}
  }

  formatValue(value,energy=false){
    if(value==null||!Number.isFinite(value))return '—';
    const scaled=energy||Math.abs(value)>=1000;
    return new Intl.NumberFormat('ru',{maximumFractionDigits:scaled?2:0}).format(scaled?value/1000:value)+' '+(energy?'кВт·ч':scaled?'кВт':'Вт');
  }
  value(point,series,energy){return point[energy?series.id+'Wh':series.field]}
  valid(point,series,energy){return Number.isFinite(this.value(point,series,energy))&&(energy||!!(series.source==='battery'?point.batteryAvailable:point.available))}
  measurement(value,series,energy=false){if(energy||series.unit==='Вт')return this.formatValue(value,energy);return Number.isFinite(value)?new Intl.NumberFormat('ru',{maximumFractionDigits:series.unit==='В'?2:1}).format(value)+' '+series.unit:'—'}
  exportCsv(){const m=this._plotData;if(!m)return;const series=PM_GROUPS[m.mode];const rows=[['Время',...series.map(s=>s.name+' ('+(m.energy?'Вт·ч':s.unit)+')')],...m.points.map(p=>[new Date(p.timestamp*1000).toISOString(),...series.map(s=>this.valid(p,s,m.energy)?this.value(p,s,m.energy):'')])];const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='power-monitor-'+m.mode+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  renderPlot(model){
    const {data,points,energy,start,end,mode}=model;const catalog=PM_GROUPS[mode];this.hideTip();
    const chosen=this.el('metric').value;
    const active=catalog.filter(s=>chosen==='all'?this._visible.has(s.id):s.id===chosen);
    this.el('legend').replaceChildren(...catalog.filter(s=>chosen==='all'||s.id===chosen).map(s=>{
      const b=document.createElement('button');b.type='button';b.setAttribute('aria-pressed',String(active.includes(s)));
      const dot=document.createElement('span');dot.className='dot';dot.style.background=s.color;b.append(dot,document.createTextNode(s.name));
      b.onclick=()=>{if(chosen!=='all')return;if(this._visible.has(s.id)){if(this._visible.size===1)return;this._visible.delete(s.id)}else this._visible.add(s.id);this.renderPlot(model)};return b;
    }));
    this.el('stats').replaceChildren(...catalog.map(s=>{
      const card=document.createElement('div');card.className='stat';const name=document.createElement('div');name.className='stat-name';
      const dot=document.createElement('span');dot.className='dot';dot.style.background=s.color;name.append(dot,document.createTextNode(s.name));
      const value=document.createElement('div');value.className='stat-value';const note=document.createElement('div');note.className='stat-note';
      if(energy){const values=points.map(p=>p[s.id+'Wh']).filter(Number.isFinite);value.textContent=this.formatValue(values.length?values.reduce((a,b)=>a+b,0):null,true);note.textContent='Сумма за выбранный период'+(points.some(p=>p.provisional)?' · сегодня не завершено':'')}
      else{const stat=data.summary?.channels?.[s.field];value.textContent=this.measurement(stat?.average,s);note.textContent='Среднее · мин. '+this.measurement(stat?.min,s)+' · макс. '+this.measurement(stat?.max,s)}
      card.append(name,value,note);return card;
    }));
    const mobile=this.clientWidth<600,w=mobile?Math.max(320,this.clientWidth-55):1100,h=mobile?320:380;
    const units=[...new Set(active.map(s=>energy?'кВт·ч':s.unit))];if(!units.length)units.push(energy?'кВт·ч':'Вт');
    const left=mobile?52:72,right=w-15,top=28,bottom=h-45;
    const x=t=>left+(t-start)/(end-start)*(right-left),axes=new Map();
    for(const unit of units){const values=active.filter(s=>(energy?'кВт·ч':s.unit)===unit).flatMap(s=>points.filter(p=>this.valid(p,s,energy)).map(p=>this.value(p,s,energy)));let lo=Math.min(0,...values),hi=Math.max(1,...values);
      if(unit==='%'){lo=0;hi=100}else if(!energy&&unit==='В'&&values.length){lo=Math.max(0,Math.min(...values)*.95);hi=Math.max(lo+1,Math.max(...values)*1.05)}
      const raw=(hi-lo)/4,magnitude=10**Math.floor(Math.log10(raw)),step=[1,2,2.5,5,10].find(v=>v*magnitude>=raw)*magnitude;
      lo=Math.floor(lo/step)*step;hi=Math.ceil(hi/step)*step;axes.set(unit,{lo,hi,step})}
    const y=(v,s)=>{const a=axes.get(energy?'кВт·ч':s?.unit||units[0]);return bottom-(v-a.lo)/(a.hi-a.lo)*(bottom-top)};
    model.layout={w,h,left,right,top,bottom,x,y,active};let svg='';
    units.forEach((unit,index)=>{const a=axes.get(unit),series=active.find(s=>(energy?'кВт·ч':s.unit)===unit),color=index?series?.color:'var(--secondary-text-color)',axis=index?right+12+(index-1)*(mobile?43:65):left-9;
      if(!index)svg+=`<text x="${axis}" y="14" text-anchor="${index?'start':'end'}" style="fill:${color}">${unit==='Вт'&&a.hi>=1000?'кВт':unit}</text>`;
      for(let v=a.lo;v<=a.hi+a.step*.01;v+=a.step){const n=energy||unit==='Вт'&&a.hi>=1000?v/1000:v;
        if(!index)svg+=`<line class="axis-grid" x1="${left}" x2="${right}" y1="${y(v,series)}" y2="${y(v,series)}"/>`;
        if(!index)svg+=`<text x="${axis}" y="${y(v,series)+4}" text-anchor="end" style="fill:${color}">${new Intl.NumberFormat('ru',{maximumFractionDigits:2}).format(n)}</text>`}
    });
    const ticks=mobile?3:6;
    for(let i=0;i<=ticks;i++){const t=start+(end-start)*i/ticks;const label=new Date(t*1000).toLocaleString('ru',end-start<=86401?{hour:'2-digit',minute:'2-digit'}:{day:'2-digit',month:'2-digit'});
      svg+=`<line class="axis-grid" x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${bottom}"/><text x="${x(t)}" y="${bottom+24}" text-anchor="${i===0?'start':i===ticks?'end':'middle'}">${label}</text>`;
    }
    const gaps=data.summary?.gaps||[];
    for(const [a,b] of gaps)svg+=`<rect x="${x(Math.max(start,a))}" y="${top}" width="${Math.max(1,x(Math.min(end,b))-x(Math.max(start,a)))}" height="${bottom-top}" fill="var(--secondary-text-color)" opacity=".10"/>`;
    active.forEach((s,j)=>{
      if(energy){const size=Math.max(2,Math.min(mobile?28:42,(right-left)*(data.downsampleSeconds||86400)/(end-start)*.8));
        for(const p of points){const v=p[s.id+'Wh'];if(!Number.isFinite(v))continue;const bx=Math.max(left,Math.min(right-size,x(p.timestamp)));const bw=size/active.length;
          svg+=`<rect data-series="${s.id}" x="${bx+j*bw}" y="${y(v)}" width="${Math.max(.7,bw-1)}" height="${Math.max(0,bottom-y(v))}" rx="1.5" fill="${s.color}" opacity="${p.provisional?.55:.85}"/>`}
      }else{let line='',pen=false;for(const p of points){if(!this.valid(p,s,false)||p.gapBefore)pen=false;if(!this.valid(p,s,false))continue;line+=(pen?'L':'M')+x(p.timestamp).toFixed(1)+' '+y(this.value(p,s,false),s).toFixed(1)+' ';pen=true}
        svg+=`<path data-series="${s.id}" d="${line}" fill="none" stroke="${s.color}" stroke-width="${mobile?1.5:1.8}"/>`;
      }
    });
    svg+=`<g id="cursor" visibility="hidden"><line id="cursor-line" y1="${top}" y2="${bottom}" stroke="var(--primary-text-color)" stroke-dasharray="4 4" opacity=".65"/><g id="cursor-dots"></g></g>`;
    this.el('plot').setAttribute('viewBox',`0 0 ${w} ${h}`);this.el('plot').setAttribute('preserveAspectRatio','none');this.el('plot').innerHTML=svg;
    const gapCount=data.summary?.gapCount||0;
    this.el('gap-info').classList.toggle('warning',!!gapCount||!!data.conflictingSequences);
    this.el('gap-info').textContent=energy?(points.some(p=>p.provisional)?'Сегодня — предварительный итог.':'Суточные итоги ESP.'):
      gapCount?'Серым отмечены интервалы без записей.':points.some(p=>!p.available)?'Разрывы линии — нет измерений инвертора.':'';
    if(data.conflictingSequences)this.el('gap-info').textContent+=' Есть неоднозначные записи; в график не включены.';
  }
  hideTip(){this.el('tooltip')?.classList.add('hidden');this.el('plot')?.querySelector('#cursor')?.setAttribute('visibility','hidden')}
  inspect(event){
    const m=this._plotData;if(!m?.points.length||!m.layout)return;
    const rect=this.el('plot').getBoundingClientRect(),sx=(event.clientX-rect.left)/rect.width*m.layout.w;
    const time=m.start+(sx-m.layout.left)/(m.layout.right-m.layout.left)*(m.end-m.start);
    let lo=0,hi=m.points.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(m.points[mid].timestamp<time)lo=mid+1;else hi=mid}
    if(lo>0&&time-m.points[lo-1].timestamp<m.points[lo].timestamp-time)lo--;
    this._hoverIndex=lo;this.inspectIndex(lo);
  }
  inspectIndex(index){
    const m=this._plotData,p=m.points[index];if(!p)return;const {energy,layout:l}=m;
    const tip=this.el('tooltip');tip.replaceChildren();const head=document.createElement('div');head.className='tip-head';
    head.textContent=new Date(p.timestamp*1000).toLocaleString('ru',energy?{day:'numeric',month:'long',year:'numeric'}:{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'});tip.append(head);
    const row=(name,value,color)=>{const r=document.createElement('div');r.className='tip-row';const n=document.createElement('span');if(color){const dot=document.createElement('i');dot.className='dot';dot.style.background=color;n.append(dot)}n.append(document.createTextNode(name));const v=document.createElement('strong');v.textContent=value;r.append(n,v);tip.append(r)};
    for(const s of PM_GROUPS[m.mode])row(s.name,this.valid(p,s,energy)?this.measurement(this.value(p,s,energy),s,energy):'Нет данных',s.color);
    if(energy){if(p.days>1)row('В этом столбце',p.days+' дней');if(p.provisional)row('Сегодня','Предварительно')}
    else{const separator=document.createElement('div');separator.className='tip-extra';tip.append(separator);
      row('Уровень заряда',p.batteryAvailable&&p.soc!==255?p.soc+' %':'—');row('Напряжение батареи',p.batteryAvailable?(p.battMv/1000).toFixed(2)+' В':'—');
      row('Напряжение PV',p.available&&p.pvDv!==65535?(p.pvDv/10).toFixed(1)+' В':'—');row('Температура инвертора',p.available&&p.tInv!==-128?p.tInv+' °C':'—');
    }
    tip.classList.remove('hidden');const rect=this.el('plot').getBoundingClientRect(),px=l.x(p.timestamp)/l.w*rect.width;
    tip.style.left=Math.max(0,Math.min(rect.width-tip.offsetWidth,px+(px>rect.width/2?-tip.offsetWidth-12:12)))+'px';tip.style.top='12px';
    const line=this.el('plot').querySelector('#cursor-line');line.setAttribute('x1',l.x(p.timestamp));line.setAttribute('x2',l.x(p.timestamp));
    this.el('plot').querySelector('#cursor').setAttribute('visibility','visible');
    this.el('plot').querySelector('#cursor-dots').innerHTML=energy?'':l.active.filter(s=>this.valid(p,s,false)).map(s=>`<circle cx="${l.x(p.timestamp)}" cy="${l.y(this.value(p,s,false),s)}" r="3.5" fill="${s.color}" stroke="var(--ha-card-background,var(--card-background-color))" stroke-width="1.5"/>`).join('');
  }
  zoom(factor){const m=this._plotData;if(!m)return;const span=Math.max(m.energy?86400:3600,Math.min(10*365*86400,(m.end-m.start)*factor)),middle=(m.end+m.start)/2;
    this._zoomRange={start:Math.max(0,Math.floor(middle-span/2)),end:Math.min(0xffffffff,Math.ceil(middle+span/2))};this.el('period').value='custom';this.draw();}
}
if(!customElements.get('power-monitor-panel'))customElements.define('power-monitor-panel',PowerMonitorPanel);
