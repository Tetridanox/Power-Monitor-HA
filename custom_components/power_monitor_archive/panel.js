import {ensureDashboard} from './dashboard-setup.js?v=1.0.226';
import {t,technical,locale,setText,setMarkup,bindAttribute,setProfileLanguage,setLanguage,languagePreference,watchLanguage,refreshTranslations} from './i18n.js?v=1.0.226';
/* Native HA panel. All data travels over the authenticated HA connection. */
import './dashboard.js?v=1.0.226';
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
    setProfileLanguage(hass.locale?.language||hass.language);this._hass=hass;
    if (!this._mounted && this.isConnected) this.mount();
  }
  connectedCallback() { this._languageUnsub?.();this._languageUnsub=watchLanguage(this,()=>{if(this._plotData)this.renderPlot(this._plotData)});if(this._hass&&!this._mounted)this.mount(); }
  disconnectedCallback() { this._languageUnsub?.();this._languageUnsub=null;clearInterval(this._timer);clearInterval(this._currentTimer);this._resize?.disconnect();this._tipEvents?.abort();this.cancelGesture(); this._mounted=false; }
  el(id) { return this.shadowRoot.getElementById(id); }
  async api(action, args={}) {
    return this._hass.callWS({type:'power_monitor_archive/query',action,...args});
  }
  navigate(path) {
    history.pushState(null,'',path); window.dispatchEvent(new CustomEvent('location-changed'));
  }
  mount() {
    this._mounted=true;
    setMarkup(this.shadowRoot,`<style>
      :host{display:block;height:100%;overflow:auto;background:var(--primary-background-color);color:var(--primary-text-color);font-family:var(--paper-font-body1_-_font-family,system-ui)}
      *{box-sizing:border-box}.toolbar{height:64px;display:flex;align-items:center;gap:16px;padding:0 20px;background:var(--app-header-background-color,var(--primary-background-color));color:var(--app-header-text-color,var(--primary-text-color));border-bottom:1px solid var(--divider-color)}
      .toolbar strong{font-size:20px;font-weight:500}.menu{border:0;background:transparent;color:inherit;font-size:24px;padding:8px}main{max-width:1250px;padding:24px;margin:auto}.card{background:var(--ha-card-background,var(--card-background-color));border:1px solid var(--divider-color);border-radius:var(--ha-card-border-radius,12px);padding:22px;margin-bottom:20px}
      h1{font-size:24px;margin:0 0 8px}h2{font-size:20px;margin:0 0 16px}p{line-height:1.6}.muted{color:var(--secondary-text-color);font-size:14px}.row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end}.grow{flex:1;min-width:200px}label{display:flex;flex-direction:column;gap:6px;font-size:13px}button,select,input{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--divider-color);background:var(--secondary-background-color);color:var(--primary-text-color);max-width:100%}button{cursor:pointer}button.primary{background:var(--primary-color);color:var(--text-primary-color,#fff);border-color:var(--primary-color)}button:disabled{opacity:.5;cursor:wait}svg{display:block;width:100%;height:330px}svg text{fill:var(--secondary-text-color);font-size:12px}.hidden{display:none!important}#message{min-height:24px}#message:empty{display:none}#summary{line-height:1.6}.title{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:center;margin-bottom:20px}.notice{padding:12px 0;line-height:1.6}a{color:var(--primary-color)}@media(max-width:600px){main{padding:12px}.card{padding:16px}svg{height:270px}.row>*{flex:1;min-width:120px}}
      .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0 18px}.stat{padding:16px;border:1px solid var(--divider-color);border-radius:10px;min-width:0}.stat-name{font-size:13px;display:flex;align-items:center;gap:7px}.dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex-shrink:0}.stat-value{font-size:25px;font-weight:600;margin:9px 0 3px}.stat-note{font-size:12px;color:var(--secondary-text-color);line-height:1.5}.legend{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.legend button{padding:6px 10px;font-size:13px;display:flex;align-items:center;gap:7px}.legend button[aria-pressed=false]{opacity:.45}.plot-wrap{position:relative}svg{height:380px;touch-action:none;user-select:none;cursor:crosshair}.tooltip{position:absolute;z-index:2;pointer-events:none;min-width:0;width:260px;max-width:100%;background:var(--ha-card-background,var(--card-background-color));box-shadow:0 4px 24px #0006;border:1px solid var(--divider-color);border-radius:10px;padding:14px;font-size:13px}.tip-head{font-weight:600;margin-bottom:9px;padding-right:32px}.tip-close{pointer-events:auto;position:absolute;right:6px;top:6px;padding:2px 8px;font-size:20px;background:transparent;border:0}.tip-row strong{white-space:nowrap}.chart-help:has(#gap-info:empty){display:none}.tip-row{display:flex;justify-content:space-between;gap:24px;margin:6px 0}.tip-row span:first-child{display:flex;align-items:center;gap:7px}.tip-extra{border-top:1px solid var(--divider-color);margin-top:10px;padding-top:6px;color:var(--secondary-text-color)}.chart-help{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-top:10px}.brand{width:30px;height:30px}.period-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}.period-heading strong{font-size:16px;font-weight:500}.warning{color:var(--warning-color,#f2b44c)}.axis-grid{stroke:var(--divider-color);stroke-dasharray:3 5;opacity:.65}.zoom{display:flex;gap:6px}.zoom button{padding:5px 11px}.details{margin-top:24px;font-size:13px;color:var(--secondary-text-color)}.details summary{cursor:pointer}@media(max-width:850px){.stats{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:600px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stat{padding:12px}.stat-value{font-size:21px}svg{height:320px}.tooltip{width:250px;max-width:calc(100% - 8px);font-size:11px;padding:10px}.tip-row{gap:12px;margin:5px 0}.legend{gap:6px}.legend button{padding:8px}.period-heading{align-items:flex-start}.period-heading strong{font-size:14px}.zoom{flex-shrink:0}.legend button{font-size:12px}.chart-help{font-size:12px}}
      .tooltip{width:200px;padding:9px 10px;font-size:11px;line-height:1.2;border-radius:12px;text-size-adjust:100%;-webkit-text-size-adjust:100%}.tip-head{font-size:10px;font-weight:400;color:var(--secondary-text-color);margin-bottom:6px;padding-right:18px}.tip-row{gap:6px;margin:4px 0}.tip-row>span:first-child{min-width:0;gap:5px}.tip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tip-row .dot{width:7px;height:7px}.tip-row strong{font-weight:500}.tip-close{font-size:16px;line-height:20px;width:20px;height:20px;padding:0;right:3px;top:3px}.tooltip::before{content:"";position:absolute;top:16px;width:7px;height:7px;background:var(--ha-card-background,var(--card-background-color));transform:rotate(45deg)}.tooltip[data-side=left]::before{right:-4px;border-top:1px solid var(--divider-color);border-right:1px solid var(--divider-color)}.tooltip[data-side=right]::before{left:-4px;border-left:1px solid var(--divider-color);border-bottom:1px solid var(--divider-color)}
      #plot{outline:none}#plot.keyboard-focus{outline:2px solid var(--primary-color);outline-offset:2px}
      </style><div class="toolbar"><button id="menu" class="menu" aria-label="Открыть меню" data-pm-i18n-aria-label="%D0%9E%D1%82%D0%BA%D1%80%D1%8B%D1%82%D1%8C%20%D0%BC%D0%B5%D0%BD%D1%8E">☰</button><img class="brand" src="/power_monitor_archive/brand.svg" alt=""><strong>Power Monitor</strong></div>
      <main><div class="title"><div><h1>Power Monitor</h1><div class="muted"><!--pm-i18n:%D0%9F%D0%BE%D0%BA%D0%B0%D0%B7%D0%B0%D0%BD%D0%B8%D1%8F%20%D0%B8%20%D0%B0%D1%80%D1%85%D0%B8%D0%B2%20%D0%BD%D0%B0%20%D0%B2%D0%B0%D1%88%D0%B5%D0%BC%20Home%20Assistant-->Показания и архив на вашем Home Assistant</div></div><div class="row"><button id="create-dashboard" class="primary"><!--pm-i18n:%D0%A1%D0%BE%D0%B7%D0%B4%D0%B0%D1%82%D1%8C%20YAML-%D0%B4%D0%B0%D1%88%D0%B1%D0%BE%D1%80%D0%B4-->Создать YAML-дашборд</button><button id="add"><!--pm-i18n:%D0%94%D0%BE%D0%B1%D0%B0%D0%B2%D0%B8%D1%82%D1%8C%20%D1%83%D1%81%D1%82%D1%80%D0%BE%D0%B9%D1%81%D1%82%D0%B2%D0%BE-->Добавить устройство</button></div><p id="dashboard-result" role="status"></p></div>
      <section id="empty" class="card hidden"><h2><!--pm-i18n:%D0%9F%D0%BE%D0%B4%D0%BA%D0%BB%D1%8E%D1%87%D0%B8%D1%82%D0%B5%20%D0%B2%D0%B0%D1%88%20Power%20Monitor-->Подключите ваш Power Monitor</h2><p><!--pm-i18n:1.%20%D0%9D%D0%B0%20ESP%20%D0%BE%D1%82%D0%BA%D1%80%D0%BE%D0%B9%D1%82%D0%B5%20-->1. На ESP откройте <strong><!--pm-i18n:Home%20Assistant%20%E2%86%92%20%D0%A3%D0%B2%D1%96%D0%BC%D0%BA%D0%BD%D1%83%D1%82%D0%B8%20%D1%96%D0%BD%D1%82%D0%B5%D0%B3%D1%80%D0%B0%D1%86%D1%96%D1%8E%20%E2%86%92%20%D0%9E%D1%82%D1%80%D0%B8%D0%BC%D0%B0%D1%82%D0%B8%20%D0%BA%D0%BE%D0%B4%20%D0%BD%D0%B0%202%20%D1%85%D0%B2%D0%B8%D0%BB%D0%B8%D0%BD%D0%B8-->Home Assistant → Увімкнути інтеграцію → Отримати код на 2 хвилини</strong><!--pm-i18n:%20%D0%B8%20%D1%81%D0%BA%D0%BE%D0%BF%D0%B8%D1%80%D1%83%D0%B9%D1%82%D0%B5%20%D0%BA%D0%BE%D0%B4.--> и скопируйте код.</p><p><!--pm-i18n:2.%20%D0%9D%D0%B0%D0%B6%D0%BC%D0%B8%D1%82%D0%B5%20%C2%AB%D0%94%D0%BE%D0%B1%D0%B0%D0%B2%D0%B8%D1%82%D1%8C%20%D1%83%D1%81%D1%82%D1%80%D0%BE%D0%B9%D1%81%D1%82%D0%B2%D0%BE%C2%BB%20%D0%B7%D0%B4%D0%B5%D1%81%D1%8C%20%D0%B8%20%D0%B2%D1%81%D1%82%D0%B0%D0%B2%D1%8C%D1%82%D0%B5%20%D0%BA%D0%BE%D0%B4%20%D0%B2%20%D0%BE%D0%BA%D0%BD%D0%BE%20Home%20Assistant.-->2. Нажмите «Добавить устройство» здесь и вставьте код в окно Home Assistant.</p><p><!--pm-i18n:%D0%98%D1%81%D1%82%D0%BE%D1%80%D0%B8%D1%8F%20%D0%B7%D0%B0%D0%B3%D1%80%D1%83%D0%B7%D0%B8%D1%82%D1%81%D1%8F%20%D0%B0%D0%B2%D1%82%D0%BE%D0%BC%D0%B0%D1%82%D0%B8%D1%87%D0%B5%D1%81%D0%BA%D0%B8.%20%D0%94%D0%BB%D1%8F%20%D0%BF%D1%80%D0%BE%D1%81%D0%BC%D0%BE%D1%82%D1%80%D0%B0%20%D0%B8%D1%81%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D1%83%D0%B9%D1%82%D0%B5%20%D1%8D%D1%82%D0%BE%D1%82%20%D1%80%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB%20%E2%80%94%20%D0%BE%D1%82%D0%B4%D0%B5%D0%BB%D1%8C%D0%BD%D1%8B%D0%B9%20%D0%B0%D0%B4%D1%80%D0%B5%D1%81%20%D0%B8%D0%BB%D0%B8%20%D0%BF%D0%B0%D1%80%D0%BE%D0%BB%D1%8C%20%D0%BD%D0%B5%20%D0%BD%D1%83%D0%B6%D0%BD%D1%8B.-->История загрузится автоматически. Для просмотра используйте этот раздел — отдельный адрес или пароль не нужны.</p></section>
      <section id="archive" class="card"><div class="row"><label class="grow"><!--pm-i18n:%D0%A3%D1%81%D1%82%D1%80%D0%BE%D0%B9%D1%81%D1%82%D0%B2%D0%BE-->Устройство<select id="device"></select></label><button id="resume" class="hidden"><!--pm-i18n:%D0%9F%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D0%B8%D1%82%D1%8C%20%D0%BF%D0%BE%D0%B4%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%BD%D0%B8%D0%B5-->Проверить подключение</button></div><div id="summary" class="notice" role="status"></div><div id="coverage" class="muted"></div></section>
      <nav class="row" aria-label="Разделы Power Monitor" data-pm-i18n-aria-label="%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB%D1%8B%20Power%20Monitor" style="margin:20px 0"><button id="tab-overview" aria-pressed="true"><!--pm-i18n:%D0%9E%D0%B1%D0%B7%D0%BE%D1%80-->Обзор</button><button id="tab-history" aria-pressed="false"><!--pm-i18n:%D0%98%D1%81%D1%82%D0%BE%D1%80%D0%B8%D1%8F-->История</button><button id="tab-interface" aria-pressed="false"><!--pm-i18n:%D0%98%D0%BD%D1%82%D0%B5%D1%80%D1%84%D0%B5%D0%B9%D1%81-->Интерфейс</button><a id="local" target="_blank" rel="noopener noreferrer"><!--pm-i18n:%D0%9E%D1%82%D0%BA%D1%80%D1%8B%D1%82%D1%8C%20ESP%20%D0%BB%D0%BE%D0%BA%D0%B0%D0%BB%D1%8C%D0%BD%D0%BE-->Открыть ESP локально</a></nav>
      <power-monitor-dashboard id="overview"></power-monitor-dashboard>
      <section id="interface" class="card hidden"><h2><!--pm-i18n:%D0%93%D0%B4%D0%B5%20%D0%BE%D1%82%D0%BA%D1%80%D1%8B%D0%B2%D0%B0%D1%82%D1%8C%20%D0%B8%D0%BD%D1%82%D0%B5%D1%80%D1%84%D0%B5%D0%B9%D1%81-->Где открывать интерфейс</h2><p><!--pm-i18n:%D0%92%D1%8B%D0%B1%D0%BE%D1%80%20%D1%81%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D1%8F%D0%B5%D1%82%D1%81%D1%8F%20%D0%BD%D0%B0%20ESP.-->Выбор сохраняется на ESP.</p><div class="row"><label><!--pm-i18n:%D0%9E%D1%81%D0%BD%D0%BE%D0%B2%D0%BD%D0%BE%D0%B9%20%D0%B8%D0%BD%D1%82%D0%B5%D1%80%D1%84%D0%B5%D0%B9%D1%81-->Основной интерфейс<select id="interface-mode"><option value="esp"><!--pm-i18n:%D0%9D%D0%B0%20ESP-->На ESP</option><option value="ha"><!--pm-i18n:%D0%92%20Home%20Assistant-->В Home Assistant</option></select></label><button id="interface-save" class="primary"><!--pm-i18n:%D0%A1%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D0%B8%D1%82%D1%8C%20%D0%BD%D0%B0%20ESP-->Сохранить на ESP</button></div><p id="interface-result" role="status"></p><p id="interface-permission" class="muted"></p><label><!--pm-i18n:%D0%90%D0%B4%D1%80%D0%B5%D1%81%20%D1%8D%D1%82%D0%BE%D0%B9%20%D0%BF%D0%B0%D0%BD%D0%B5%D0%BB%D0%B8-->Адрес этой панели<input id="interface-url" readonly></label><p class="muted"><!--pm-i18n:%D0%A1%D0%BA%D0%BE%D0%BF%D0%B8%D1%80%D1%83%D0%B9%D1%82%D0%B5%20%D1%8D%D1%82%D0%BE%D1%82%20%D0%B0%D0%B4%D1%80%D0%B5%D1%81%20%D0%B2%20%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D1%83%20%D0%B8%D0%BD%D1%82%D0%B5%D1%80%D1%84%D0%B5%D0%B9%D1%81%D0%B0%20%D0%BD%D0%B0%20ESP%2C%20%D0%B5%D1%81%D0%BB%D0%B8%20%D1%85%D0%BE%D1%82%D0%B8%D1%82%D0%B5%20%D0%BF%D0%B5%D1%80%D0%B5%D0%BA%D0%BB%D1%8E%D1%87%D0%B8%D1%82%D1%8C%20%D0%B2%D1%85%D0%BE%D0%B4%20%D0%BE%D1%82%D1%82%D1%83%D0%B4%D0%B0.%20%D0%90%D0%B2%D0%B0%D1%80%D0%B8%D0%B9%D0%BD%D1%8B%D0%B9%20%D0%B2%D1%85%D0%BE%D0%B4%20%2Flocal%2F%20%D1%80%D0%B0%D0%B1%D0%BE%D1%82%D0%B0%D0%B5%D1%82%20%D0%BD%D0%B5%D0%B7%D0%B0%D0%B2%D0%B8%D1%81%D0%B8%D0%BC%D0%BE%20%D0%BE%D1%82%20HA.-->Скопируйте этот адрес в настройку интерфейса на ESP, если хотите переключить вход оттуда. Аварийный вход /local/ работает независимо от HA.</p></section>
      <section id="charts" class="card"><h2><!--pm-i18n:%D0%93%D1%80%D0%B0%D1%84%D0%B8%D0%BA%D0%B8-->Графики</h2><div class="row"><label><!--pm-i18n:%D0%A7%D1%82%D0%BE%20%D0%BF%D0%BE%D0%BA%D0%B0%D0%B7%D0%B0%D1%82%D1%8C-->Что показать<select id="mode"><option value="power"><!--pm-i18n:%D0%9F%D0%BE%D1%82%D0%BE%D0%BA%20%D1%8D%D0%BD%D0%B5%D1%80%D0%B3%D0%B8%D0%B8-->Поток энергии</option><option value="energy"><!--pm-i18n:%D0%AD%D0%BD%D0%B5%D1%80%D0%B3%D0%B8%D1%8F%20%D0%BF%D0%BE%20%D0%B4%D0%BD%D1%8F%D0%BC-->Энергия по дням</option><option value="voltage"><!--pm-i18n:%D0%9D%D0%B0%D0%BF%D1%80%D1%8F%D0%B6%D0%B5%D0%BD%D0%B8%D1%8F-->Напряжения</option><option value="temperature"><!--pm-i18n:%D0%A2%D0%B5%D0%BC%D0%BF%D0%B5%D1%80%D0%B0%D1%82%D1%83%D1%80%D0%B0%20%D0%B8%D0%BD%D0%B2%D0%B5%D1%80%D1%82%D0%BE%D1%80%D0%B0-->Температура инвертора</option><option value="soc"><!--pm-i18n:%D0%97%D0%B0%D1%80%D1%8F%D0%B4%20%D0%B1%D0%B0%D1%82%D0%B0%D1%80%D0%B5%D0%B8%20%C2%B7%20SOC-->Заряд батареи · SOC</option></select></label><label><!--pm-i18n:%D0%9F%D0%BE%D0%BA%D0%B0%D0%B7%D0%B0%D1%82%D0%B5%D0%BB%D0%B8-->Показатели<select id="metric"><option value="all"><!--pm-i18n:%D0%92%D1%81%D0%B5%20%D0%BF%D0%BE%D1%82%D0%BE%D0%BA%D0%B8%20%D1%8D%D0%BD%D0%B5%D1%80%D0%B3%D0%B8%D0%B8-->Все потоки энергии</option><option value="load"><!--pm-i18n:%D0%9F%D0%BE%D1%82%D1%80%D0%B5%D0%B1%D0%BB%D0%B5%D0%BD%D0%B8%D0%B5-->Потребление</option><option value="grid"><!--pm-i18n:%D0%98%D0%B7%20%D1%81%D0%B5%D1%82%D0%B8-->Из сети</option><option value="pv"><!--pm-i18n:%D0%A1%D0%BE%D0%BB%D0%BD%D0%B5%D1%87%D0%BD%D0%B0%D1%8F%20%D0%B3%D0%B5%D0%BD%D0%B5%D1%80%D0%B0%D1%86%D0%B8%D1%8F-->Солнечная генерация</option><option value="batteryCharge"><!--pm-i18n:%D0%97%D0%B0%D1%80%D1%8F%D0%B4%20%D0%B1%D0%B0%D1%82%D0%B0%D1%80%D0%B5%D0%B8-->Заряд батареи</option><option value="batteryDischarge"><!--pm-i18n:%D0%A0%D0%B0%D0%B7%D1%80%D1%8F%D0%B4%20%D0%B1%D0%B0%D1%82%D0%B0%D1%80%D0%B5%D0%B8-->Разряд батареи</option></select></label><label><!--pm-i18n:%D0%9F%D0%B5%D1%80%D0%B8%D0%BE%D0%B4-->Период<select id="period"><option value="1"><!--pm-i18n:24%20%D1%87%D0%B0%D1%81%D0%B0-->24 часа</option><option value="7"><!--pm-i18n:7%20%D0%B4%D0%BD%D0%B5%D0%B9-->7 дней</option><option value="30"><!--pm-i18n:30%20%D0%B4%D0%BD%D0%B5%D0%B9-->30 дней</option><option value="365"><!--pm-i18n:%D0%93%D0%BE%D0%B4-->Год</option><option value="all"><!--pm-i18n:%D0%92%D0%B5%D1%81%D1%8C%20%D1%81%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D1%91%D0%BD%D0%BD%D1%8B%D0%B9%20%D0%BF%D0%B5%D1%80%D0%B8%D0%BE%D0%B4-->Весь сохранённый период</option><option value="custom"><!--pm-i18n:%D0%92%D1%8B%D0%B1%D1%80%D0%B0%D1%82%D1%8C%20%D0%B4%D0%B0%D1%82%D1%8B-->Выбрать даты</option></select></label><label><!--pm-i18n:%D0%A1-->С<input type="date" id="from"></label><label><!--pm-i18n:%D0%9F%D0%BE-->По<input type="date" id="to"></label><button id="show" class="primary"><!--pm-i18n:%D0%9F%D0%BE%D0%BA%D0%B0%D0%B7%D0%B0%D1%82%D1%8C-->Показать</button><button id="csv"><!--pm-i18n:CSV%20%D0%B3%D1%80%D0%B0%D1%84%D0%B8%D0%BA%D0%B0-->CSV графика</button></div><div id="stats" class="stats"></div><div class="period-heading"><strong id="range"></strong><div class="zoom"><button id="zoom-reset" aria-label="Сбросить масштаб">↺</button><button id="zoom-in" aria-label="Приблизить период" data-pm-i18n-aria-label="%D0%9F%D1%80%D0%B8%D0%B1%D0%BB%D0%B8%D0%B7%D0%B8%D1%82%D1%8C%20%D0%BF%D0%B5%D1%80%D0%B8%D0%BE%D0%B4">＋</button><button id="zoom-out" aria-label="Отдалить период" data-pm-i18n-aria-label="%D0%9E%D1%82%D0%B4%D0%B0%D0%BB%D0%B8%D1%82%D1%8C%20%D0%BF%D0%B5%D1%80%D0%B8%D0%BE%D0%B4">−</button></div></div><div id="legend" class="legend"></div><p id="message" role="status" class="muted"></p><div class="plot-wrap"><svg id="plot" viewBox="0 0 1100 380" role="img" aria-label="График сохранённой истории" data-pm-i18n-aria-label="%D0%93%D1%80%D0%B0%D1%84%D0%B8%D0%BA%20%D1%81%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D1%91%D0%BD%D0%BD%D0%BE%D0%B9%20%D0%B8%D1%81%D1%82%D0%BE%D1%80%D0%B8%D0%B8" tabindex="0"></svg><div id="tooltip" class="tooltip hidden"></div></div><div class="chart-help muted"><span id="gap-info"></span></div></section>
      <details class="details"><summary><!--pm-i18n:%D0%9E%20%D1%85%D1%80%D0%B0%D0%BD%D0%B5%D0%BD%D0%B8%D0%B8%20%D0%B8%20%D0%BF%D0%BE%D0%BB%D0%BD%D0%BE%D1%82%D0%B5%20%D0%B8%D1%81%D1%82%D0%BE%D1%80%D0%B8%D0%B8-->О хранении и полноте истории</summary><p><!--pm-i18n:%D0%90%D1%80%D1%85%D0%B8%D0%B2%20%D0%BD%D0%B0%D1%85%D0%BE%D0%B4%D0%B8%D1%82%D1%81%D1%8F%20%D0%B2%20Home%20Assistant%20%D0%B8%20%D0%B4%D0%BE%D1%81%D1%82%D1%83%D0%BF%D0%B5%D0%BD%20%D0%BF%D1%80%D0%B8%20%D0%B2%D1%8B%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%BD%D0%BD%D0%BE%D0%B9%20ESP.%20%D0%97%D0%B0%D0%BF%D0%B8%D1%81%D0%B8%20%D1%81%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D1%8F%D1%8E%D1%82%D1%81%D1%8F%20%D0%B1%D0%B5%D0%B7%20%D0%B0%D0%B2%D1%82%D0%BE%D0%BC%D0%B0%D1%82%D0%B8%D1%87%D0%B5%D1%81%D0%BA%D0%BE%D0%B3%D0%BE%20%D1%83%D0%B4%D0%B0%D0%BB%D0%B5%D0%BD%D0%B8%D1%8F.%20%D0%A1%D1%80%D0%B5%D0%B4%D0%BD%D1%8F%D1%8F%20%D0%BC%D0%BE%D1%89%D0%BD%D0%BE%D1%81%D1%82%D1%8C%20%D1%80%D0%B0%D1%81%D1%81%D1%87%D0%B8%D1%82%D0%B0%D0%BD%D0%B0%20%D0%BF%D0%BE%20%D1%81%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D1%91%D0%BD%D0%BD%D1%8B%D0%BC%20%D0%B8%D0%B7%D0%BC%D0%B5%D1%80%D0%B5%D0%BD%D0%B8%D1%8F%D0%BC%2C%20%D1%8D%D0%BD%D0%B5%D1%80%D0%B3%D0%B8%D1%8F%20%E2%80%94%20%D0%BF%D0%BE%20%D1%81%D1%83%D1%82%D0%BE%D1%87%D0%BD%D1%8B%D0%BC%20%D0%B8%D1%82%D0%BE%D0%B3%D0%B0%D0%BC%20ESP.%20%D0%9F%D1%80%D0%BE%D0%BF%D1%83%D1%81%D0%BA%D0%B8%20%D0%BD%D0%B5%20%D0%B7%D0%B0%D0%BC%D0%B5%D0%BD%D1%8F%D1%8E%D1%82%D1%81%D1%8F%20%D0%BD%D1%83%D0%BB%D1%8F%D0%BC%D0%B8.%20%D0%A1%D0%B5%D0%B3%D0%BE%D0%B4%D0%BD%D1%8F%D1%88%D0%BD%D0%B8%D0%B9%20%D0%B8%D1%82%D0%BE%D0%B3%20%D0%B5%D1%89%D1%91%20%D1%83%D1%82%D0%BE%D1%87%D0%BD%D1%8F%D0%B5%D1%82%D1%81%D1%8F.-->Архив находится в Home Assistant и доступен при выключенной ESP. Записи сохраняются без автоматического удаления. Средняя мощность рассчитана по сохранённым измерениям, энергия — по суточным итогам ESP. Пропуски не заменяются нулями. Сегодняшний итог ещё уточняется.</p></details></main>`);
    this._view=new URLSearchParams(location.search).has('manage')?'interface':'overview';
    this.el('create-dashboard').onclick=()=>this.createDashboard();
    for(const name of ['overview','history','interface'])this.el('tab-'+name).onclick=()=>this.showView(name);
    this.el('interface-save').onclick=()=>this.saveInterface();
    this.el('interface-mode').onchange=()=>{this._interfaceDirty=true};
    this.el('menu').onclick=()=>this.dispatchEvent(new CustomEvent('hass-toggle-menu',{bubbles:true,composed:true}));
    this.el('add').onclick=()=>this.navigate('/config/integrations/dashboard/add?domain=power_monitor_archive');
    this.el('resume').onclick=async()=>{try{await this.api('resume',{device:this.el('device').value});await this.refresh()}catch(e){this.showError(e)}};
    for(const id of ['device','mode','metric','period'])this.el(id).onchange=()=>{if(id==='period'||id==='device'){this._zoomRange=null;this._navigationBase=null}this.cancelGesture();return id==='device'?this.refresh():this.draw()};
    this.el('show').onclick=()=>this.draw();this.el('csv').onclick=()=>this.exportCsv();
    this.el('zoom-in').onclick=()=>this.zoom(.5);this.el('zoom-out').onclick=()=>this.zoom(2);this.el('zoom-reset').onclick=()=>this.resetWindow();
    this.bindPlotGestures();bindAttribute(this.el('zoom-reset'),'aria-label',()=>t('Сбросить масштаб'));
    this.el('plot').onpointerleave=e=>{if(e.pointerType!=='touch'&&!this.el('tooltip').contains(e.relatedTarget))this.hideTip()};
    this.el('tooltip').onpointerleave=e=>{if(e.pointerType!=='touch')this.hideTip()};
    this._tipEvents?.abort();this._tipEvents=new AbortController();
    const tipOptions={capture:true,signal:this._tipEvents.signal};
    this.ownerDocument.addEventListener('pointerdown',e=>{this.plotInputMode(false);const path=e.composedPath();if(!path.includes(this.el('plot'))&&!path.includes(this.el('tooltip')))this.hideTip()},tipOptions);
    this.ownerDocument.addEventListener('keydown',e=>{if(e.key==='Tab')this._keyboardInput=true;if(e.key==='Escape')this.hideTip()},tipOptions);
    this.ownerDocument.addEventListener('scroll',()=>this.hideTip(),tipOptions);
    this.addEventListener('scroll',()=>this.hideTip(),tipOptions);
    for(const type of ['touchmove','wheel'])this.ownerDocument.addEventListener(type,()=>{if(!this._gesture?.inspect)this.hideTip()},{...tipOptions,passive:true});
    this.ownerDocument.addEventListener('pointercancel',()=>this.hideTip(),tipOptions);
    this.el('plot').onfocus=()=>this.plotInputMode(!!this._keyboardInput);
    this.el('plot').onblur=()=>this.el('plot').classList.remove('keyboard-focus');
    this.el('plot').onkeydown=e=>{if(!this._plotData?.points.length)return;if(['ArrowLeft','ArrowRight'].includes(e.key)){this.plotInputMode(true);e.preventDefault();this._hoverIndex=Math.max(0,Math.min(this._plotData.points.length-1,(this._hoverIndex||0)+(e.key==='ArrowRight'?1:-1)));this.inspectIndex(this._hoverIndex)}};
    for(const id of ['from','to'])this.el(id).onchange=()=>{this.el('period').value='custom';this._zoomRange=null;this._navigationBase=null;this.cancelGesture()};
    this._resize=new ResizeObserver(()=>{const width=this.el('plot').clientWidth;if(Math.abs(width-(this._plotWidth||0))<.5)return;this._plotWidth=width;if(this._plotData){this.cancelGesture();this.renderPlot(this._plotData)}});this._resize.observe(this);
    this.el('to').value=this.dateInput(new Date());this.el('from').value=this.dateInput(new Date(Date.now()-7*86400000));
    this.refresh();this._timer=setInterval(()=>{if(!document.hidden)this.refresh()},60000);this._currentTimer=setInterval(()=>{if(!document.hidden&&this._view==='overview')this.refreshCurrent()},5000);
  }
  dateInput(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
  showError(error){setText(this.el('message'),()=>t('Не удалось прочитать архив. Попробуйте обновить страницу.'));console.warn('Power Monitor archive:',error?.code||'unavailable')}
  async refresh(){
    if(this._refreshing)return;this._refreshing=true;
    try{
      const s=await this.api('status'),previous=this.el('device').value||this._configuredDevice||new URLSearchParams(location.search).get('device');this._devices=s.devices;
      this.el('device').replaceChildren(...s.devices.map(d=>{const o=document.createElement('option');o.value=d.deviceId;setText(o,()=>d.name);return o}));
      if(s.devices.some(d=>d.deviceId===previous))this.el('device').value=previous;
      for(const id of ['archive','charts'])this.el(id).classList.toggle('hidden',!s.devices.length);
      this.el('empty').classList.toggle('hidden',!!s.devices.length);
      for(const id of ['overview','interface'])this.el(id).classList.toggle('hidden',!s.devices.length);
      if(s.devices.length)this.showView(this._view||'overview');
      if(!s.devices.length)return;
      const d=s.devices.find(d=>d.deviceId===this.el('device').value);this._device=d;if(d.dashboardPath&&!this._embedded&&!new URLSearchParams(location.search).has('manage')){this.navigate('/'+d.dashboardPath);return}this.updateInterface(d);await this.refreshCurrent();const done=d.minuteBackfillComplete&&d.dailyBackfillComplete;
      const messages={starting:t('Подключаемся к ESP…'),syncing:done?t('Доступная история ESP загружена. Новые данные сохраняются автоматически.'):t('Первая загрузка истории. Полученные данные уже доступны.'),grant_disabled_or_revoked:t('Доступ к ESP остановлен. Если вы выключали интеграцию на ESP, включите её и нажмите «Проверить подключение». Если доступ отозван, подключите устройство заново по новому коду. Сохранённые графики доступны.'),identity_changed_pairing_required:t('История устройства изменилась. Требуется повторное подключение. Прежний архив сохранён.'),source_or_storage_error:t('ESP или хранилище временно недоступны. Повторим загрузку автоматически.')};
      this.el('resume').classList.toggle('hidden',d.state!=='grant_disabled_or_revoked'||!!s.writerError);
      setText(this.el('summary'),()=>s.writerError?t('Хранилище недоступно. Сохранённые данные не удалены.'):messages[d.state]||t('Повторяем соединение с ESP…'));
      this._coverage=await this.api('coverage',{device:d.deviceId});const c=this._coverage;
      setText(this.el('coverage'),()=>`${t("История с ")}${c.firstDay?new Date(c.firstDay*1000).toLocaleDateString(locale()):t('первого сохранённого измерения')}${t(". Последняя связь: ")}${d.lastSuccess?new Date(d.lastSuccess*1000).toLocaleString():t('ожидается')}.`);
      if(this._view==='history'&&!this._gesture)await this.draw({navigation:!!this._plotData,live:true});
    }catch(e){this.showError(e)}finally{this._refreshing=false}
  }
  showView(view){
    this._view=view;
    this.el('archive').classList.toggle('hidden',view!=='history'&&(this._devices||[]).length<=1);
    for(const name of ['overview','history','interface']){
      this.el(name==='history'?'charts':name).classList.toggle('hidden',name!==view);
      this.el('tab-'+name).setAttribute('aria-pressed',String(name===view));
    }
    if(view==='overview')this.refreshCurrent();
    if(view==='history'){if(this._plotData)this.renderPlot(this._plotData);else this.draw()}
  }
  async refreshCurrent(){
    const device=this.el('device').value;if(!device||this._readingCurrent)return;
    this._readingCurrent=true;
    try{const current=await this.api('current',{device});if(device===this.el('device').value)this.el('overview').readings=current}
    catch(e){this.el('overview').readings={available:false}}
    finally{this._readingCurrent=false}
  }
  updateInterface(d){
    if(!d)return;
    setText(this.el('create-dashboard'),()=>d.dashboardPath?t('Открыть YAML-дашборд'):t('Создать YAML-дашборд'));
    this.el('local').href=d.localUrl;
    this.el('interface-url').value=location.origin+'/power-monitor?device='+d.deviceId;
    if(!this._interfaceDirty)this.el('interface-mode').value=d.interfaceUrl?'ha':'esp';
    this.el('interface-save').disabled=!d.interfaceControl||this._savingInterface;
    setText(this.el('interface-permission'),()=>d.interfaceControl?t('Локальная панель и запись истории ESP сохраняются в обоих режимах.'):d.interfaceSupported?t('Для переключения из HA получите новый код на ESP и перенастройте существующую интеграцию. Архив сохранится. Переключение также доступно локально на ESP.'):t('Для переключения основного входа обновите прошивку ESP до 1.0.170 или новее. Живой обзор и архив уже доступны здесь.'));
  }
  async createDashboard(){
    if(this._creatingDashboard||!this._device)return;
    this._creatingDashboard=true;this.el('create-dashboard').disabled=true;
    const device=this._device.deviceId,path='power-monitor-'+device;
    try{
      await ensureDashboard(this._hass,device);
      this.navigate('/'+path);
    }catch(e){setText(this.el('dashboard-result'),()=>t('Не удалось создать дашборд: ')+String(e.message||e.code||'unknown'));}
    finally{this._creatingDashboard=false;this.el('create-dashboard').disabled=false}
  }
  async saveInterface(){
    if(this._savingInterface||!this._device)return;
    this._savingInterface=true;this.updateInterface(this._device);
    setText(this.el('interface-result'),()=>t('Сохраняем выбор на ESP…'));
    try{
      const result=await this.api('interface',{device:this._device.deviceId,url:this.el('interface-mode').value==='ha'?this.el('interface-url').value:''});
      if(!result.saved)throw new Error('not_confirmed');
      this._interfaceDirty=false;
      setText(this.el('interface-result'),()=>t('Сохранено на ESP. Выбор применяется при следующем открытии её обычного адреса. Локальный вход /local/ доступен всегда.'));
      await this.refresh();
    }catch(e){setText(this.el('interface-result'),()=>t('Сохранение не подтверждено. Проверьте связь и право переключения; обновите состояние перед повторной попыткой.'))}
    finally{this._savingInterface=false;this.updateInterface(this._device)}
  }
  async draw(options={}){
    const revision=this._drawRevision=(this._drawRevision||0)+1;
    if(this._busy){this._redraw=true;this._redrawOptions=options;return}const device=this.el('device').value;if(!device)return;
    this._redraw=false;this._redrawOptions=null;this._busy=true;this._drawingNavigation=!!options.navigation;
    try{
      const mode=this.el('mode').value,energy=mode==='energy',c=this._coverage||{},period=this.el('period').value;
      const metric=this.el('metric'),selected=metric.value;metric.replaceChildren(...[{id:'all',name:t('Все показатели')},...PM_GROUPS[mode]].map(s=>{const o=document.createElement('option');o.value=s.id;setText(o,()=>t(s.name));return o}));metric.value=[...metric.options].some(o=>o.value===selected)?selected:'all';
      let end=Math.floor(Date.now()/1000)+1,start;
      if(period==='all'){start=(energy?c.firstDay:c.first)||end-86400;end=Math.max(end,(energy?c.lastDay:c.last)||0)+1}
      else if(period==='custom'){start=this._zoomRange?.start??Math.floor(new Date(this.el('from').value+'T00:00:00').getTime()/1000);end=this._zoomRange?.end??Math.floor(new Date(this.el('to').value+'T23:59:59').getTime()/1000)}
      else start=end-Number(period)*86400;
      if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end){setText(this.el('message'),()=>t('Выберите корректный диапазон дат.'));return}
      for(const id of ['from','to'])this.el(id).disabled=period!=='custom';
      if(period!=='custom'){this.el('from').value=this.dateInput(new Date(start*1000));this.el('to').value=this.dateInput(new Date(end*1000))}
      const key=period==='custom'?`custom:${start}:${end}`:period;
      let resident=this._resident;
      const reuse=resident&&resident.device===device&&resident.energy===energy&&(resident.key===key||!!this._navigationBase);
      if(!reuse){if(!options.navigation)setText(this.el('message'),()=>t('Загружаем график из архива HA…'));resident=await this.loadResident(device,start,end,energy,key,period)}
      else if(options.live)resident=await this.refreshResident(resident,!this._navigationBase&&period!=='custom');
      if(revision===this._drawRevision)this._resident=resident;
      if(revision!==this._drawRevision)return;
      if(this._gesture){this._redraw=true;this._redrawOptions={navigation:true};return}
      if(options.live&&!this._navigationBase&&period!=='custom'){start=resident.start;end=resident.end}
      else if(reuse&&!this._navigationBase&&period!=='custom'){start=Math.max(resident.start,resident.end-resident.span);end=resident.end}
      const points=resident.points,data=this.residentViewData(resident,start,end,mode),shown=points.filter(p=>p.timestamp>=start&&p.timestamp<=end);
      this._plotData={data,points,energy,start,end,mode,keepAxes:options.keepAxes};this.renderPlot(this._plotData);
      setText(this.el('message'),()=>shown.length?'':t('В выбранном диапазоне пока нет сохранённых данных.'));
      setText(this.el('range'),()=>`${new Date(start*1000).toLocaleDateString(locale())} — ${new Date(end*1000).toLocaleDateString(locale())}${!energy&&end-start<=86401?' · '+new Date(start*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+'–'+new Date(end*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):''}`);
      this._lastGraph={kind:energy?'daily':'minute',points:shown.length,start,end,source:data.source};
    }catch(e){if(revision===this._drawRevision&&!this._gesture)this.showError(e)}finally{this._busy=false;this._drawingNavigation=false;if(this._redraw&&!this._gesture){const next=this._redrawOptions||{};this._redraw=false;this.draw(next)}}
  }

  async loadResident(device,start,end,energy,key,period){
    const action=energy?'days':'history',data=await this.api(action,{device,start,end,maximum:2000});
    let points=data.points||[],sampleSeconds=data.downsampleSeconds||60;
    // A week fits the same 10080-minute bound as ESP. Fetch raw day slices
    // once, so zooming later reveals actual minutes without another request.
    if(!energy&&end-start>86400&&end-start<=7*86400){
      points=[];
      for(let from=start;from<end;){const until=Math.min(end,from+86400);
        const part=await this.api(action,{device,start:from,end:until,maximum:2000});points.push(...(part.points||[]).filter(p=>until===end||p.timestamp<until));from=until;
      }
      sampleSeconds=60;
    }
    points.sort((a,b)=>a.timestamp-b.timestamp);
    if(!energy&&sampleSeconds<=60)points=points.map((p,i)=>i&&p.timestamp-points[i-1].timestamp>120?{...p,gapBefore:true}:p);
    return {device,start,end,loadedUntil:Math.min(end,Math.floor(Date.now()/1000)+1),energy,key,period,span:end-start,points:points.slice(energy?-2000:-10080),data,sampleSeconds};
  }
  async refreshResident(resident,follow){
    const now=Math.floor(Date.now()/1000)+1;
    const until=resident.period==='custom'?Math.min(now,resident.end):now,loadedUntil=resident.loadedUntil??resident.end;
    if(until<=loadedUntil)return resident;
    if(!resident.energy&&until-loadedUntil>86400)return this.loadResident(resident.device,follow?now-resident.span:resident.start,resident.period==='custom'?resident.end:now,resident.energy,resident.key,resident.period);
    const overlap=resident.energy?2*86400:180,start=Math.max(resident.start,loadedUntil-overlap);
    const data=await this.api(resident.energy?'days':'history',{device:resident.device,start,end:until,maximum:2000});
    if(data.generation&&resident.data.generation&&data.generation!==resident.data.generation)return this.loadResident(resident.device,follow?now-resident.span:resident.start,resident.period==='custom'?resident.end:now,resident.energy,resident.key,resident.period);
    // Replace the overlap, including missing/retracted records, rather than
    // appending duplicate provisional days or timestamps on every refresh.
    let points=[...resident.points.filter(p=>p.timestamp<start),...(data.points||[])].sort((a,b)=>a.timestamp-b.timestamp);
    const nextStart=follow?Math.max(0,now-resident.span):resident.start;
    points=points.filter(p=>p.timestamp>=nextStart&&p.timestamp<=now).slice(resident.energy?-2000:-10080);
    if(!resident.energy&&resident.sampleSeconds<=60)points=points.map((p,i)=>i&&p.timestamp-points[i-1].timestamp>120?{...p,gapBefore:true}:p);
    return {...resident,start:nextStart,end:resident.period==='custom'?resident.end:now,loadedUntil:until,points,data:{...resident.data,conflictingSequences:data.conflictingSequences||0}};
  }
  residentViewData(resident,start,end,mode){
    const points=resident.points.filter(p=>p.timestamp>=start&&p.timestamp<=end),channels={};
    for(const s of PM_GROUPS[mode]){const values=points.filter(p=>this.valid(p,s,resident.energy)).map(p=>this.value(p,s,resident.energy));
      if(values.length)channels[s.field]={average:values.reduce((a,b)=>a+b,0)/values.length,min:Math.min(...values),max:Math.max(...values)};
    }
    const gaps=[];for(let i=1;i<points.length;i++)if(points[i].gapBefore||resident.sampleSeconds<=60&&points[i].timestamp-points[i-1].timestamp>120)gaps.push([points[i-1].timestamp,points[i].timestamp]);
    return {...resident.data,summary:{channels,gaps,gapCount:gaps.length,approximate:!resident.energy&&resident.sampleSeconds>60}};
  }

  formatValue(value,energy=false){
    if(value==null||!Number.isFinite(value))return '—';
    const scaled=energy||Math.abs(value)>=1000;
    return new Intl.NumberFormat(locale(),{maximumFractionDigits:scaled?2:0}).format(scaled?value/1000:value)+' '+(energy?t('кВт·ч'):scaled?t('кВт'):t('Вт'));
  }
  value(point,series,energy){return point[energy?series.id+'Wh':series.field]}
  valid(point,series,energy){return Number.isFinite(this.value(point,series,energy))&&(energy||!!(series.source==='battery'?point.batteryAvailable:point.available))}
  measurement(value,series,energy=false){if(energy||series.unit==='Вт')return this.formatValue(value,energy);return Number.isFinite(value)?new Intl.NumberFormat(locale(),{maximumFractionDigits:series.unit==='В'?2:1}).format(value)+' '+t(series.unit):'—'}
  exportCsv(){const m=this._plotData;if(!m)return;const series=PM_GROUPS[m.mode];const rows=[[t('Время'),...series.map(s=>t(s.name)+' ('+(m.energy?'Wh':technical(s.unit))+')')],...m.points.filter(p=>p.timestamp>=m.start&&p.timestamp<=m.end).map(p=>[new Date(p.timestamp*1000).toISOString(),...series.map(s=>this.valid(p,s,m.energy)?this.value(p,s,m.energy):'')])];const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='power-monitor-'+m.mode+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  renderStats(model){
    const {data,energy,mode,start,end}=model,points=model.points.filter(p=>p.timestamp>=start&&p.timestamp<=end),catalog=PM_GROUPS[mode];
    this.el('stats').replaceChildren(...catalog.map(s=>{
      const card=document.createElement('div');card.className='stat';const name=document.createElement('div');name.className='stat-name';
      const dot=document.createElement('span');dot.className='dot';dot.style.background=s.color;name.append(dot,setText(document.createTextNode(''),()=>t(s.name)));
      const value=document.createElement('div');value.className='stat-value';const note=document.createElement('div');note.className='stat-note';
      if(energy){const values=points.map(p=>p[s.id+'Wh']).filter(Number.isFinite);setText(value,()=>this.formatValue(values.length?values.reduce((a,b)=>a+b,0):null,true));setText(note,()=>t('Сумма за выбранный период')+(points.some(p=>p.provisional)?t(' · сегодня не завершено'):''))}
      else{const stat=data.summary?.channels?.[s.field];setText(value,()=>this.measurement(stat?.average,s));setText(note,()=>t(data.summary?.approximate?'По точкам графика · мин. ':'Среднее · мин. ')+this.measurement(stat?.min,s)+t(' · макс. ')+this.measurement(stat?.max,s))}
      card.append(name,value,note);return card;
    }));
  }
  renderPlot(model){
    const {data,points,energy,start,end,mode}=model;const catalog=PM_GROUPS[mode];this.hideTip();
    model.geometry=null;model.drawn=new Map();
    const chosen=this.el('metric').value;
    const active=catalog.filter(s=>chosen==='all'?this._visible.has(s.id):s.id===chosen);
    this.el('legend').replaceChildren(...catalog.filter(s=>chosen==='all'||s.id===chosen).map(s=>{
      const b=document.createElement('button');b.type='button';b.setAttribute('aria-pressed',String(active.includes(s)));
      const dot=document.createElement('span');dot.className='dot';dot.style.background=s.color;b.append(dot,setText(document.createTextNode(''),()=>t(s.name)));
      b.onclick=()=>{if(chosen!=='all')return;if(this._visible.has(s.id)){if(this._visible.size===1)return;this._visible.delete(s.id)}else this._visible.add(s.id);this.renderPlot(model)};return b;
    }));
    this.renderStats(model);
    const plotWidth=this.el('plot').clientWidth||this.clientWidth-32,mobile=plotWidth<600,w=Math.max(240,plotWidth),h=mobile?320:380;
    const units=[...new Set(active.map(s=>energy?t('кВт·ч'):s.unit))];if(!units.length)units.push(energy?t('кВт·ч'):t('Вт'));
    const left=mobile?40:62,right=w-12,top=28,bottom=h-38;
    const x=t=>left+(t-start)/(end-start)*(right-left),axes=new Map();
    for(const unit of units){const values=active.filter(s=>(energy?t('кВт·ч'):s.unit)===unit).flatMap(s=>points.filter(p=>this.valid(p,s,energy)).map(p=>this.value(p,s,energy)));let lo=Math.min(0,...values),hi=Math.max(1,...values);
      const prior=model.keepAxes?.get(unit);
      if(prior&&values.every(v=>v>=prior.lo&&v<=prior.hi)){axes.set(unit,prior);continue}
      if(unit==='%'){lo=0;hi=100}else if(!energy&&unit==='В'&&values.length){lo=Math.max(0,Math.min(...values)*.95);hi=Math.max(lo+1,Math.max(...values)*1.05)}
      if(prior){lo=Math.min(lo,prior.lo);hi=Math.max(hi,prior.hi)}
      const raw=(hi-lo)/4,magnitude=10**Math.floor(Math.log10(raw)),step=[1,2,2.5,5,10].find(v=>v*magnitude>=raw)*magnitude;
      lo=Math.floor(lo/step)*step;hi=Math.ceil(hi/step)*step;axes.set(unit,{lo,hi,step})}
    const y=(v,s)=>{const a=axes.get(energy?t('кВт·ч'):s?.unit||units[0]);return bottom-(v-a.lo)/(a.hi-a.lo)*(bottom-top)};
    model.layout={w,h,left,right,top,bottom,x,y,active,axes};this._plotWidth=plotWidth;let svg='';
    units.forEach((unit,index)=>{if(index)return;const a=axes.get(unit),series=active.find(s=>(energy?t('кВт·ч'):s.unit)===unit),color=index?series?.color:'var(--secondary-text-color)',axis=index?right+12+(index-1)*(mobile?43:65):left-9;
      svg+=`<text data-axis-unit="${unit}" x="${axis}" y="14" text-anchor="${index?'start':'end'}" style="fill:${color}">${t(unit==='Вт'&&a.hi>=1000?'кВт':unit)}</text>`;
      for(let v=a.lo;v<=a.hi+a.step*.01;v+=a.step){const n=energy||unit==='Вт'&&a.hi>=1000?v/1000:v;
        if(!index)svg+=`<line class="axis-grid" x1="${left}" x2="${right}" y1="${y(v,series)}" y2="${y(v,series)}"/>`;
        svg+=`<text x="${axis}" y="${y(v,series)+4}" text-anchor="${index?'start':'end'}" style="fill:${color}">${new Intl.NumberFormat(locale(),{maximumFractionDigits:2}).format(n)}</text>`}
    });
    const ticks=mobile?3:6;
    const span=end-start;const rawStep=span/ticks,steps=span<=86401?[900,1800,3600,7200,10800,21600,43200]:[86400,172800,604800,1209600,2592000,7776000];
    const tickStep=steps.find(n=>n>=rawStep)||Math.ceil(rawStep/86400)*86400;
    const first=new Date(start*1000);if(span>86401)first.setHours(0,0,0,0);else first.setMinutes(0,0,0);
    let firstTick=Math.floor(first.getTime()/1000);while(firstTick<start)firstTick+=tickStep;
    for(let t=firstTick;t<=end;t+=tickStep){const label=new Date(t*1000).toLocaleString(locale(),span<=86401?{hour:'2-digit',minute:'2-digit'}:{day:'2-digit',month:'2-digit'});
      svg+=`<line data-tick="${t}" class="axis-grid" x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${bottom}"/><text data-tick="${t}" x="${x(t)}" y="${bottom+24}" text-anchor="${x(t)-left<30?'start':right-x(t)<30?'end':'middle'}">${label}</text>`;
    }
    svg+=`<defs><clipPath id="plot-clip"><rect x="${left}" y="${top-5}" width="${right-left}" height="${bottom-top+10}"/></clipPath></defs><g clip-path="url(#plot-clip)"><g id="plot-series">`;
    const gaps=data.summary?.gaps||[];
    for(const [a,b] of gaps)svg+=`<rect x="${x(Math.max(start,a))}" y="${top}" width="${Math.max(1,x(Math.min(end,b))-x(Math.max(start,a)))}" height="${bottom-top}" fill="var(--secondary-text-color)" opacity=".10"/>`;
    active.forEach((s,j)=>{
      if(energy){const size=Math.max(2,Math.min(mobile?28:42,(right-left)*(data.downsampleSeconds||86400)/(end-start)*.8));
        for(const p of points){if(p.timestamp<start||p.timestamp>end)continue;const v=p[s.id+'Wh'];if(!Number.isFinite(v))continue;const bx=Math.max(left,Math.min(right-size,x(p.timestamp)));const bw=size/active.length;
          svg+=`<rect data-series="${s.id}" x="${bx+j*bw}" y="${y(v)}" width="${Math.max(.7,bw-1)}" height="${Math.max(0,bottom-y(v))}" rx="1.5" fill="${s.color}" opacity="${p.provisional?.55:.85}"/>`}
      }else{const vertices=this.chartVertices(points,s,start,end);model.drawn.set(s.id,vertices);let line='',pen=false;for(const p of vertices){if(!this.valid(p,s,false)||p.gapBefore)pen=false;if(!this.valid(p,s,false))continue;line+=(pen?'L':'M')+x(p.timestamp).toFixed(1)+' '+y(this.value(p,s,false),s).toFixed(1)+' ';pen=true}
        svg+=`<path data-series="${s.id}" d="${line}" fill="none" stroke="${s.color}" stroke-width="${mobile?1.5:1.8}" vector-effect="non-scaling-stroke"/>`;
      }
    });
    svg+=`</g></g><g id="cursor"><line id="cursor-line" y1="${top}" y2="${bottom}" stroke="var(--primary-text-color)" opacity=".55"/><g id="cursor-dots">${active.map(s=>`<circle data-dot="${s.id}" r="4" fill="${s.color}" stroke="var(--ha-card-background,var(--card-background-color))" stroke-width="1.5"/>`).join('')}</g></g>`;
    this.el('plot').setAttribute('viewBox',`0 0 ${w} ${h}`);this.el('plot').setAttribute('preserveAspectRatio','none');setMarkup(this.el('plot'),svg);
    this.updateCursor(this.cursorIndex(model),model);
    const gapCount=data.summary?.gapCount||0;
    this.el('gap-info').classList.toggle('warning',!!gapCount||!!data.conflictingSequences);
    setText(this.el('gap-info'),()=>energy?(points.some(p=>p.provisional)?t('Сегодня — предварительный итог.'):t('Суточные итоги ESP.')):
      gapCount?t('Серым отмечены интервалы без записей.'):points.some(p=>!p.available)?t('Разрывы линии — нет измерений инвертора.'):'');
    if(data.conflictingSequences)this.el('gap-info').textContent+=t(' Есть неоднозначные записи; в график не включены.');
  }
  hideTip(){this.el('tooltip')?.classList.add('hidden')}
  cursorIndex(m=this._plotData){
    if(!m?.points.length)return -1;
    const time=this._cursorTime>=m.start&&this._cursorTime<=m.end?this._cursorTime:(m.start+m.end)/2;
    let lo=0,hi=m.points.length-1;
    while(lo<hi){const mid=(lo+hi)>>1;if(m.points[mid].timestamp<time)lo=mid+1;else hi=mid}
    if(lo>0&&time-m.points[lo-1].timestamp<m.points[lo].timestamp-time)lo--;
    return lo;
  }
  updateCursor(index,m=this._plotData){
    const plot=this.el('plot'),line=plot?.querySelector('#cursor-line');if(!line||!m?.layout)return;
    const p=m.points[index],l=m.layout,inside=p&&p.timestamp>=m.start&&p.timestamp<=m.end;
    const px=inside?l.x(p.timestamp):(l.left+l.right)/2;
    line.setAttribute('x1',px);line.setAttribute('x2',px);
    plot.querySelector('#cursor')?.setAttribute('visibility','visible');
    for(const s of l.active){const dot=plot.querySelector(`[data-dot="${s.id}"]`);if(!dot)continue;
      const valid=inside&&this.valid(p,s,m.energy);dot.setAttribute('visibility',valid?'visible':'hidden');
      if(valid){const vertices=(m.geometry||m).drawn?.get(s.id),value=vertices?this.drawnValueAt(vertices,p.timestamp,s):this.value(p,s,m.energy);
        dot.setAttribute('visibility',Number.isFinite(value)?'visible':'hidden');dot.setAttribute('cx',px);dot.setAttribute('cy',l.y(value,s))}
    }
  }
  chartVertices(points,series,start,end){
    if(points.length<=700)return points;
    const output=[],span=Math.max(1,end-start);let group=null,invalid=false;
    const flush=()=>{if(!group)return;const chosen=[group.first,group.min,group.max,group.last];
      output.push(...[...new Set(chosen)].sort((a,b)=>a.timestamp-b.timestamp));group=null};
    for(const point of points){
      if(!this.valid(point,series,false)){flush();if(!invalid)output.push(point);invalid=true;continue}
      if(point.gapBefore)flush();invalid=false;
      const bucket=Math.max(-1,Math.min(175,Math.floor((point.timestamp-start)/span*175))),value=this.value(point,series,false);
      if(!group||bucket!==group.bucket){flush();group={bucket,first:point,last:point,min:point,max:point}}
      else{group.last=point;if(value<this.value(group.min,series,false))group.min=point;if(value>this.value(group.max,series,false))group.max=point}
    }
    flush();return output;
  }
  drawnValueAt(vertices,time,series){
    let lo=0,hi=vertices.length-1;if(hi<0)return null;
    while(lo<hi){const mid=(lo+hi)>>1;if(vertices[mid].timestamp<time)lo=mid+1;else hi=mid}
    const b=vertices[lo];if(b.timestamp===time)return this.valid(b,series,false)?this.value(b,series,false):null;
    const a=vertices[lo-1];if(!a||b.gapBefore||!this.valid(a,series,false)||!this.valid(b,series,false))return null;
    return this.value(a,series,false)+(this.value(b,series,false)-this.value(a,series,false))*(time-a.timestamp)/(b.timestamp-a.timestamp);
  }
  inspect(event){
    const m=this._plotData;if(!m?.points.length||!m.layout)return;
    const rect=this.el('plot').getBoundingClientRect(),sx=(event.clientX-rect.left)/rect.width*m.layout.w;
    const sy=(event.clientY-rect.top)/rect.height*m.layout.h;
    if(sx<m.layout.left||sx>m.layout.right||sy<m.layout.top||sy>m.layout.bottom){this.hideTip();return}
    const time=m.start+(sx-m.layout.left)/(m.layout.right-m.layout.left)*(m.end-m.start);
    let lo=0,hi=m.points.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(m.points[mid].timestamp<time)lo=mid+1;else hi=mid}
    if(lo>0&&time-m.points[lo-1].timestamp<m.points[lo].timestamp-time)lo--;
    this._hoverIndex=lo;this.inspectIndex(lo);
  }
  inspectIndex(index){
    const m=this._plotData,p=m.points[index];if(!p)return;const {energy,layout:l}=m;
    this._cursorTime=p.timestamp;this._hoverIndex=index;this.updateCursor(index,m);
    const tip=this.el('tooltip');tip.replaceChildren();const close=document.createElement('button');close.type='button';close.className='tip-close';close.textContent='×';bindAttribute(close,'aria-label',()=>t('Закрыть'));close.onclick=()=>this.hideTip();tip.append(close);const head=document.createElement('div');head.className='tip-head';
    setText(head,()=>new Date(p.timestamp*1000).toLocaleString(locale(),energy?{day:'2-digit',month:'2-digit',year:'numeric'}:{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}));tip.append(head);
    const row=(name,value,color,fullName=name)=>{const r=document.createElement('div');r.className='tip-row';const n=document.createElement('span');bindAttribute(n,'title',()=>t(fullName));bindAttribute(n,'aria-label',()=>t(fullName));if(color){const dot=document.createElement('i');dot.className='dot';dot.style.background=color;n.append(dot)}const label=document.createElement('span');label.className='tip-name';setText(label,()=>t(name));n.append(label);const v=document.createElement('strong');v.style.color=color||'';setText(v,()=>value);r.append(n,v);tip.append(r)};
    const short={load:t('Нагрузка'),grid:t('Из сети'),pv:'PV',batteryCharge:t('Заряд АКБ'),batteryDischarge:t('Разряд АКБ'),pvVoltage:'U PV',inverterTemperature:t('T инв.'),gridVoltage:'U Grid',outputVoltage:'U Out',batteryVoltage:'U Bat',soc:'SOC'};
    for(const s of l.active)row(short[s.id]||s.name,this.valid(p,s,energy)?this.measurement(this.value(p,s,energy),s,energy):'—',s.color,s.name);
    if(energy){if(p.days>1)row(t('В этом столбце'),p.days+t(' дней'));if(p.provisional)row(t('Сегодня'),t('Предварительно'))}
    tip.classList.remove('hidden');const rect=this.el('plot').getBoundingClientRect(),px=l.x(p.timestamp)/l.w*rect.width;
    const placement=this.tooltipPlacement(rect.width,px);tip.style.width=placement.width+'px';tip.style.left=placement.left+'px';tip.style.top='10px';tip.setAttribute('data-side',placement.side);
  }
  plotInputMode(keyboard){this._keyboardInput=keyboard;this.el('plot').classList.toggle('keyboard-focus',keyboard)}
  tooltipPlacement(width,cursor){
    const gap=10,gutter=4,leftSpace=Math.max(0,cursor-gap-gutter),rightSpace=Math.max(0,width-cursor-gap-gutter);
    const side=rightSpace>=leftSpace?'right':'left',box=Math.min(200,Math.max(leftSpace,rightSpace));
    return {width:box,left:side==='right'?cursor+gap:cursor-gap-box,side};
  }
  isCursorHit(event,model=this._plotData){
    if(event.pointerType!=='touch'||!model?.points?.length)return false;
    const r=this.el('plot').getBoundingClientRect(),l=model.layout,p=model.points[this.cursorIndex(model)];
    const y=(event.clientY-r.top)/r.height*l.h;if(y<l.top||y>l.bottom)return false;
    const x=p&&p.timestamp>=model.start&&p.timestamp<=model.end?l.x(p.timestamp):(l.left+l.right)/2;
    return Math.abs(event.clientX-r.left-x/l.w*r.width)<=20;
  }
  inspectCaptured(g,event){
    const r=g.rect,l=this._plotData.layout;
    this.inspect({clientX:Math.max(r.left+l.left/l.w*r.width,Math.min(r.left+l.right/l.w*r.width,event.clientX)),clientY:r.top+(l.top+l.bottom)/2/l.h*r.height});
  }
  bindPlotGestures(){
    const plot=this.el('plot');
    plot.onpointerdown=e=>{
      if(e.button>0||this._busy&&!this._drawingNavigation||!this._plotData?.layout)return;
      if(!this._gesture)this._gesture={model:this._plotData,pointers:new Map(),moved:false};
      const g=this._gesture;g.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      g.inspect=g.pointers.size===1&&this.isCursorHit(e,g.model);
      if(g.pointers.size>1&&this._gestureFrame){cancelAnimationFrame(this._gestureFrame);this._gestureFrame=0}
      try{plot.setPointerCapture(e.pointerId)}catch(_){}
      this.startGestureSegment(g);if(g.pointers.size===1&&e.pointerType==='touch')this.inspect(e);else this.hideTip();
    };
    plot.onpointermove=e=>{
      const g=this._gesture;
      if(!g?.pointers.has(e.pointerId)){if(e.pointerType!=='touch')this.inspect(e);return}
      g.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(g.inspect){e.preventDefault();g.moved=true;g.inspectAt={clientX:e.clientX,clientY:e.clientY};
        if(!this._gestureFrame)this._gestureFrame=requestAnimationFrame(()=>{this._gestureFrame=0;if(this._gesture===g)this.inspectCaptured(g,g.inspectAt)});return}
      const positions=[...g.pointers.values()],rect=g.rect,l=g.model.layout;
      const width=(l.right-l.left)/l.w*rect.width,span=g.startEnd-g.startStart;
      if(positions.length>1){
        const distance=Math.max(1,Math.hypot(positions[1].x-positions[0].x,positions[1].y-positions[0].y));
        const fraction=Math.max(0,Math.min(1,((positions[0].x+positions[1].x)/2-rect.left-l.left/l.w*rect.width)/width));
        const nextSpan=Math.max(g.model.energy?86400:3600,span*g.distance/distance);
        g.range=this.windowRange(g.anchor-nextSpan*fraction,g.anchor+nextSpan*(1-fraction),g.model);g.moved=true;
      }else{
        const dx=positions[0].x-g.origin.x,dy=positions[0].y-g.origin.y;
        if(!g.moved&&Math.max(Math.abs(dx),Math.abs(dy))<8)return;
        if(g.vertical||!g.moved&&Math.abs(dy)>Math.abs(dx)){
          g.vertical=true;g.scrolled=true;g.origin=positions[0];this.scrollGraphPage(-dy);return;
        }
        const shift=-dx/width*span;
        g.range=this.windowRange(g.startStart+shift,g.startEnd+shift,g.model);g.moved=true;
      }
      e.preventDefault();this.hideTip();
      if(!this._gestureFrame)this._gestureFrame=requestAnimationFrame(()=>{this._gestureFrame=0;if(this._gesture===g&&g.range)this.previewWindow(g)});
    };
    plot.onpointerup=e=>{
      const g=this._gesture;if(!g?.pointers.has(e.pointerId))return;
      g.pointers.delete(e.pointerId);
      try{plot.releasePointerCapture(e.pointerId)}catch(_){}
      if(g.pointers.size){this.startGestureSegment(g);return}
      if(this._gestureFrame)cancelAnimationFrame(this._gestureFrame);this._gestureFrame=0;this._gesture=null;
      if(g.inspect)this.inspectCaptured(g,e);
      else if(g.moved&&g.range){this.previewWindow(g);this.setWindow(g.range.start,g.range.end,{base:g.model})}else if(!g.scrolled)this.inspect(e);
      if((!g.moved||g.inspect)&&this._redraw&&!this._busy){const next=this._redrawOptions||{};this._redraw=false;const selected=this._cursorTime;this.draw(next)?.then(()=>{if(g.inspect&&!this._gesture&&selected===this._cursorTime)this.inspectIndex(this.cursorIndex())})}
    };
    plot.onpointercancel=()=>this.cancelGesture();
    plot.onlostpointercapture=e=>{if(this._gesture?.pointers.has(e.pointerId))this.cancelGesture()};
    plot.onwheel=e=>{
      if(!this._plotData)return;e.preventDefault();this.cancelGesture();this.hideTip();
      const m=this._plotData,span=m.end-m.start;
      if(e.shiftKey||Math.abs(e.deltaX)>Math.abs(e.deltaY)){const shift=(e.deltaX||e.deltaY)/plot.clientWidth*span;this.setWindow(m.start+shift,m.end+shift);return}
      const rect=plot.getBoundingClientRect(),l=m.layout,fraction=Math.max(0,Math.min(1,((e.clientX-rect.left)/rect.width*l.w-l.left)/(l.right-l.left)));
      const nextSpan=Math.max(m.energy?86400:3600,span*Math.exp(Math.max(-1,Math.min(1,e.deltaY*.002)))),anchor=m.start+fraction*span;
      this.setWindow(anchor-fraction*nextSpan,anchor+(1-fraction)*nextSpan);
    };
  }
  startGestureSegment(g){
    const positions=[...g.pointers.values()],range=g.range||g.model;
    g.rect=this.el('plot').getBoundingClientRect();
    g.startStart=range.start;g.startEnd=range.end;g.origin=positions[0];g.vertical=false;
    if(positions.length>1){
      const rect=g.rect,l=g.model.layout;
      g.distance=Math.max(1,Math.hypot(positions[1].x-positions[0].x,positions[1].y-positions[0].y));
      const fraction=Math.max(0,Math.min(1,((positions[0].x+positions[1].x)/2-rect.left-l.left/l.w*rect.width)/(rect.width*(l.right-l.left)/l.w)));
      g.anchor=range.start+fraction*(range.end-range.start);
    }
  }
  scrollGraphPage(delta){
    for(let node=this;node;node=node.parentElement||node.getRootNode()?.host){
      if(node.scrollHeight>node.clientHeight&&/auto|scroll/.test(getComputedStyle(node).overflowY)){node.scrollTop+=delta;return}
    }
    window.scrollBy(0,delta);
  }
  cancelGesture(){
    const g=this._gesture;this._gesture=null;
    if(this._gestureFrame)cancelAnimationFrame(this._gestureFrame);this._gestureFrame=0;
    if(g){for(const id of g.pointers.keys()){try{this.el('plot')?.releasePointerCapture(id)}catch(_){}}
      if(this.isConnected){this._plotData=g.model;this.renderPlot(g.model)}}
  }
  windowRange(start,end,model=this._plotData){
    const cache=this._resident,local=cache&&cache.energy===model.energy;
    const lower=Math.max(0,local?cache.start:this._coverage?.[model.energy?'firstDay':'first']||0),upper=Math.max(lower+1,local?cache.end:Math.floor(Date.now()/1000)+1);
    const span=Math.min(upper-lower,Math.ceil(Math.max(model.energy?86400:3600,end-start)));
    start=Math.floor(Math.max(lower,Math.min(upper-span,start)));return {start,end:start+span};
  }
  previewWindow(g){
    const {start,end}=g.range,base=g.model,geometry=base.geometry||base,l=geometry.layout,span=end-start;
    const scale=(geometry.end-geometry.start)/span,offset=l.left*(1-scale)+(geometry.start-start)/span*(l.right-l.left);
    const model={...base,start,end,geometry,layout:{...l,x:time=>l.left+(time-start)/span*(l.right-l.left)}};
    this._plotData=model;
    const plot=this.el('plot');plot.querySelector('#plot-series')?.setAttribute('transform',`translate(${offset} 0) scale(${scale} 1)`);
    for(const tick of plot.querySelectorAll('[data-tick]')){
      const px=model.layout.x(Number(tick.getAttribute('data-tick'))),inside=px>=l.left&&px<=l.right;
      tick.setAttribute('visibility',inside?'visible':'hidden');
      if(tick.tagName.toLowerCase()==='line'){tick.setAttribute('x1',px);tick.setAttribute('x2',px)}else tick.setAttribute('x',px);
    }
    this.updateCursor(this.cursorIndex(model),model);
  }
  setWindow(start,end,options={}){
    const m=this._plotData;if(!m)return;const base=options.base||m;
    this._navigationBase??={start:base.start,end:base.end,period:this.el('period').value};
    this._zoomRange=this.windowRange(start,end,m);
    this.previewWindow({model:m,range:this._zoomRange});this.el('period').value='custom';
    const pan=Math.abs((end-start)-(base.end-base.start))<1;
    return this.draw({navigation:true,keepAxes:pan?base.layout.axes:null});
  }
  resetWindow(){
    this.cancelGesture();const base=this._navigationBase;if(!base)return;
    this.el('period').value=base.period;this._zoomRange=base.period==='custom'?{start:base.start,end:base.end}:null;
    this._navigationBase=null;this.draw();
  }
  zoom(factor){const m=this._plotData;if(!m)return;const span=Math.max(m.energy?86400:3600,Math.min(10*365*86400,(m.end-m.start)*factor)),middle=(m.end+m.start)/2;
    this.setWindow(middle-span/2,middle+span/2);}
}
if(!customElements.get('power-monitor-panel'))customElements.define('power-monitor-panel',PowerMonitorPanel);
