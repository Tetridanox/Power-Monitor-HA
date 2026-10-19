import {ensureDashboard} from './dashboard-setup.js?v=1.0.207';
import {t,technical,locale,setText,setMarkup,bindAttribute,setProfileLanguage,setLanguage,languagePreference,watchLanguage,refreshTranslations} from './i18n.js?v=1.0.207';
/* Native HA panel. All data travels over the authenticated HA connection. */
import './dashboard.js?v=1.0.207';
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
  disconnectedCallback() { this._languageUnsub?.();this._languageUnsub=null;clearInterval(this._timer);clearInterval(this._currentTimer);this._resize?.disconnect(); this._mounted=false; }
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
      h1{font-size:24px;margin:0 0 8px}h2{font-size:20px;margin:0 0 16px}p{line-height:1.6}.muted{color:var(--secondary-text-color);font-size:14px}.row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end}.grow{flex:1;min-width:200px}label{display:flex;flex-direction:column;gap:6px;font-size:13px}button,select,input{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--divider-color);background:var(--secondary-background-color);color:var(--primary-text-color);max-width:100%}button{cursor:pointer}button.primary{background:var(--primary-color);color:var(--text-primary-color,#fff);border-color:var(--primary-color)}button:disabled{opacity:.5;cursor:wait}svg{display:block;width:100%;height:330px}svg text{fill:var(--secondary-text-color);font-size:12px}.hidden{display:none!important}#message{min-height:24px}#summary{line-height:1.6}.title{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:center;margin-bottom:20px}.notice{padding:12px 0;line-height:1.6}a{color:var(--primary-color)}@media(max-width:600px){main{padding:12px}.card{padding:16px}svg{height:270px}.row>*{flex:1;min-width:120px}}
      .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0 18px}.stat{padding:16px;border:1px solid var(--divider-color);border-radius:10px;min-width:0}.stat-name{font-size:13px;display:flex;align-items:center;gap:7px}.dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex-shrink:0}.stat-value{font-size:25px;font-weight:600;margin:9px 0 3px}.stat-note{font-size:12px;color:var(--secondary-text-color);line-height:1.5}.legend{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.legend button{padding:6px 10px;font-size:13px;display:flex;align-items:center;gap:7px}.legend button[aria-pressed=false]{opacity:.45}.plot-wrap{position:relative}svg{height:380px;touch-action:pan-y;user-select:none}.tooltip{position:absolute;z-index:2;pointer-events:none;min-width:240px;max-width:310px;background:var(--ha-card-background,var(--card-background-color));box-shadow:0 4px 24px #0006;border:1px solid var(--divider-color);border-radius:10px;padding:14px;font-size:13px}.tip-head{font-weight:600;margin-bottom:9px}.tip-row{display:flex;justify-content:space-between;gap:24px;margin:6px 0}.tip-row span:first-child{display:flex;align-items:center;gap:7px}.tip-extra{border-top:1px solid var(--divider-color);margin-top:10px;padding-top:6px;color:var(--secondary-text-color)}.chart-help{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-top:10px}.brand{width:30px;height:30px}.period-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}.period-heading strong{font-size:16px;font-weight:500}.warning{color:var(--warning-color,#f2b44c)}.axis-grid{stroke:var(--divider-color);stroke-dasharray:3 5;opacity:.65}.zoom{display:flex;gap:6px}.zoom button{padding:5px 11px}.details{margin-top:24px;font-size:13px;color:var(--secondary-text-color)}.details summary{cursor:pointer}@media(max-width:850px){.stats{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:600px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stat{padding:12px}.stat-value{font-size:21px}svg{height:290px}.tooltip{min-width:220px;max-width:280px}.legend button{font-size:12px}.chart-help{font-size:12px}}
      </style><div class="toolbar"><button id="menu" class="menu" aria-label="Открыть меню" data-pm-i18n-aria-label="%D0%9E%D1%82%D0%BA%D1%80%D1%8B%D1%82%D1%8C%20%D0%BC%D0%B5%D0%BD%D1%8E">☰</button><img class="brand" src="/power_monitor_archive/brand.svg" alt=""><strong>Power Monitor</strong></div>
      <main><div class="title"><div><h1>Power Monitor</h1><div class="muted"><!--pm-i18n:%D0%9F%D0%BE%D0%BA%D0%B0%D0%B7%D0%B0%D0%BD%D0%B8%D1%8F%20%D0%B8%20%D0%B0%D1%80%D1%85%D0%B8%D0%B2%20%D0%BD%D0%B0%20%D0%B2%D0%B0%D1%88%D0%B5%D0%BC%20Home%20Assistant-->Показания и архив на вашем Home Assistant</div></div><div class="row"><button id="create-dashboard" class="primary"><!--pm-i18n:%D0%A1%D0%BE%D0%B7%D0%B4%D0%B0%D1%82%D1%8C%20YAML-%D0%B4%D0%B0%D1%88%D0%B1%D0%BE%D1%80%D0%B4-->Создать YAML-дашборд</button><button id="add"><!--pm-i18n:%D0%94%D0%BE%D0%B1%D0%B0%D0%B2%D0%B8%D1%82%D1%8C%20%D1%83%D1%81%D1%82%D1%80%D0%BE%D0%B9%D1%81%D1%82%D0%B2%D0%BE-->Добавить устройство</button></div><p id="dashboard-result" role="status"></p></div>
      <section id="empty" class="card hidden"><h2><!--pm-i18n:%D0%9F%D0%BE%D0%B4%D0%BA%D0%BB%D1%8E%D1%87%D0%B8%D1%82%D0%B5%20%D0%B2%D0%B0%D1%88%20Power%20Monitor-->Подключите ваш Power Monitor</h2><p><!--pm-i18n:1.%20%D0%9D%D0%B0%20ESP%20%D0%BE%D1%82%D0%BA%D1%80%D0%BE%D0%B9%D1%82%D0%B5%20-->1. На ESP откройте <strong><!--pm-i18n:Home%20Assistant%20%E2%86%92%20%D0%A3%D0%B2%D1%96%D0%BC%D0%BA%D0%BD%D1%83%D1%82%D0%B8%20%D1%96%D0%BD%D1%82%D0%B5%D0%B3%D1%80%D0%B0%D1%86%D1%96%D1%8E%20%E2%86%92%20%D0%9E%D1%82%D1%80%D0%B8%D0%BC%D0%B0%D1%82%D0%B8%20%D0%BA%D0%BE%D0%B4%20%D0%BD%D0%B0%202%20%D1%85%D0%B2%D0%B8%D0%BB%D0%B8%D0%BD%D0%B8-->Home Assistant → Увімкнути інтеграцію → Отримати код на 2 хвилини</strong><!--pm-i18n:%20%D0%B8%20%D1%81%D0%BA%D0%BE%D0%BF%D0%B8%D1%80%D1%83%D0%B9%D1%82%D0%B5%20%D0%BA%D0%BE%D0%B4.--> и скопируйте код.</p><p><!--pm-i18n:2.%20%D0%9D%D0%B0%D0%B6%D0%BC%D0%B8%D1%82%D0%B5%20%C2%AB%D0%94%D0%BE%D0%B1%D0%B0%D0%B2%D0%B8%D1%82%D1%8C%20%D1%83%D1%81%D1%82%D1%80%D0%BE%D0%B9%D1%81%D1%82%D0%B2%D0%BE%C2%BB%20%D0%B7%D0%B4%D0%B5%D1%81%D1%8C%20%D0%B8%20%D0%B2%D1%81%D1%82%D0%B0%D0%B2%D1%8C%D1%82%D0%B5%20%D0%BA%D0%BE%D0%B4%20%D0%B2%20%D0%BE%D0%BA%D0%BD%D0%BE%20Home%20Assistant.-->2. Нажмите «Добавить устройство» здесь и вставьте код в окно Home Assistant.</p><p><!--pm-i18n:%D0%98%D1%81%D1%82%D0%BE%D1%80%D0%B8%D1%8F%20%D0%B7%D0%B0%D0%B3%D1%80%D1%83%D0%B7%D0%B8%D1%82%D1%81%D1%8F%20%D0%B0%D0%B2%D1%82%D0%BE%D0%BC%D0%B0%D1%82%D0%B8%D1%87%D0%B5%D1%81%D0%BA%D0%B8.%20%D0%94%D0%BB%D1%8F%20%D0%BF%D1%80%D0%BE%D1%81%D0%BC%D0%BE%D1%82%D1%80%D0%B0%20%D0%B8%D1%81%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D1%83%D0%B9%D1%82%D0%B5%20%D1%8D%D1%82%D0%BE%D1%82%20%D1%80%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB%20%E2%80%94%20%D0%BE%D1%82%D0%B4%D0%B5%D0%BB%D1%8C%D0%BD%D1%8B%D0%B9%20%D0%B0%D0%B4%D1%80%D0%B5%D1%81%20%D0%B8%D0%BB%D0%B8%20%D0%BF%D0%B0%D1%80%D0%BE%D0%BB%D1%8C%20%D0%BD%D0%B5%20%D0%BD%D1%83%D0%B6%D0%BD%D1%8B.-->История загрузится автоматически. Для просмотра используйте этот раздел — отдельный адрес или пароль не нужны.</p></section>
      <section id="archive" class="card"><div class="row"><label class="grow"><!--pm-i18n:%D0%A3%D1%81%D1%82%D1%80%D0%BE%D0%B9%D1%81%D1%82%D0%B2%D0%BE-->Устройство<select id="device"></select></label><button id="resume" class="hidden"><!--pm-i18n:%D0%9F%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D0%B8%D1%82%D1%8C%20%D0%BF%D0%BE%D0%B4%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%BD%D0%B8%D0%B5-->Проверить подключение</button></div><div id="summary" class="notice" role="status"></div><div id="coverage" class="muted"></div></section>
      <nav class="row" aria-label="Разделы Power Monitor" data-pm-i18n-aria-label="%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB%D1%8B%20Power%20Monitor" style="margin:20px 0"><button id="tab-overview" aria-pressed="true"><!--pm-i18n:%D0%9E%D0%B1%D0%B7%D0%BE%D1%80-->Обзор</button><button id="tab-history" aria-pressed="false"><!--pm-i18n:%D0%98%D1%81%D1%82%D0%BE%D1%80%D0%B8%D1%8F-->История</button><button id="tab-interface" aria-pressed="false"><!--pm-i18n:%D0%98%D0%BD%D1%82%D0%B5%D1%80%D1%84%D0%B5%D0%B9%D1%81-->Интерфейс</button><a id="local" target="_blank" rel="noopener noreferrer"><!--pm-i18n:%D0%9E%D1%82%D0%BA%D1%80%D1%8B%D1%82%D1%8C%20ESP%20%D0%BB%D0%BE%D0%BA%D0%B0%D0%BB%D1%8C%D0%BD%D0%BE-->Открыть ESP локально</a></nav>
      <power-monitor-dashboard id="overview"></power-monitor-dashboard>
      <section id="interface" class="card hidden"><h2><!--pm-i18n:%D0%93%D0%B4%D0%B5%20%D0%BE%D1%82%D0%BA%D1%80%D1%8B%D0%B2%D0%B0%D1%82%D1%8C%20%D0%B8%D0%BD%D1%82%D0%B5%D1%80%D1%84%D0%B5%D0%B9%D1%81-->Где открывать интерфейс</h2><p><!--pm-i18n:%D0%92%D1%8B%D0%B1%D0%BE%D1%80%20%D1%81%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D1%8F%D0%B5%D1%82%D1%81%D1%8F%20%D0%BD%D0%B0%20ESP.-->Выбор сохраняется на ESP.</p><div class="row"><label><!--pm-i18n:%D0%9E%D1%81%D0%BD%D0%BE%D0%B2%D0%BD%D0%BE%D0%B9%20%D0%B8%D0%BD%D1%82%D0%B5%D1%80%D1%84%D0%B5%D0%B9%D1%81-->Основной интерфейс<select id="interface-mode"><option value="esp"><!--pm-i18n:%D0%9D%D0%B0%20ESP-->На ESP</option><option value="ha"><!--pm-i18n:%D0%92%20Home%20Assistant-->В Home Assistant</option></select></label><button id="interface-save" class="primary"><!--pm-i18n:%D0%A1%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D0%B8%D1%82%D1%8C%20%D0%BD%D0%B0%20ESP-->Сохранить на ESP</button></div><p id="interface-result" role="status"></p><p id="interface-permission" class="muted"></p><label><!--pm-i18n:%D0%90%D0%B4%D1%80%D0%B5%D1%81%20%D1%8D%D1%82%D0%BE%D0%B9%20%D0%BF%D0%B0%D0%BD%D0%B5%D0%BB%D0%B8-->Адрес этой панели<input id="interface-url" readonly></label><p class="muted"><!--pm-i18n:%D0%A1%D0%BA%D0%BE%D0%BF%D0%B8%D1%80%D1%83%D0%B9%D1%82%D0%B5%20%D1%8D%D1%82%D0%BE%D1%82%20%D0%B0%D0%B4%D1%80%D0%B5%D1%81%20%D0%B2%20%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D1%83%20%D0%B8%D0%BD%D1%82%D0%B5%D1%80%D1%84%D0%B5%D0%B9%D1%81%D0%B0%20%D0%BD%D0%B0%20ESP%2C%20%D0%B5%D1%81%D0%BB%D0%B8%20%D1%85%D0%BE%D1%82%D0%B8%D1%82%D0%B5%20%D0%BF%D0%B5%D1%80%D0%B5%D0%BA%D0%BB%D1%8E%D1%87%D0%B8%D1%82%D1%8C%20%D0%B2%D1%85%D0%BE%D0%B4%20%D0%BE%D1%82%D1%82%D1%83%D0%B4%D0%B0.%20%D0%90%D0%B2%D0%B0%D1%80%D0%B8%D0%B9%D0%BD%D1%8B%D0%B9%20%D0%B2%D1%85%D0%BE%D0%B4%20%2Flocal%2F%20%D1%80%D0%B0%D0%B1%D0%BE%D1%82%D0%B0%D0%B5%D1%82%20%D0%BD%D0%B5%D0%B7%D0%B0%D0%B2%D0%B8%D1%81%D0%B8%D0%BC%D0%BE%20%D0%BE%D1%82%20HA.-->Скопируйте этот адрес в настройку интерфейса на ESP, если хотите переключить вход оттуда. Аварийный вход /local/ работает независимо от HA.</p></section>
      <section id="charts" class="card"><h2><!--pm-i18n:%D0%93%D1%80%D0%B0%D1%84%D0%B8%D0%BA%D0%B8-->Графики</h2><div class="row"><label><!--pm-i18n:%D0%A7%D1%82%D0%BE%20%D0%BF%D0%BE%D0%BA%D0%B0%D0%B7%D0%B0%D1%82%D1%8C-->Что показать<select id="mode"><option value="power"><!--pm-i18n:%D0%9F%D0%BE%D1%82%D0%BE%D0%BA%20%D1%8D%D0%BD%D0%B5%D1%80%D0%B3%D0%B8%D0%B8-->Поток энергии</option><option value="energy"><!--pm-i18n:%D0%AD%D0%BD%D0%B5%D1%80%D0%B3%D0%B8%D1%8F%20%D0%BF%D0%BE%20%D0%B4%D0%BD%D1%8F%D0%BC-->Энергия по дням</option><option value="voltage"><!--pm-i18n:%D0%9D%D0%B0%D0%BF%D1%80%D1%8F%D0%B6%D0%B5%D0%BD%D0%B8%D1%8F-->Напряжения</option><option value="temperature"><!--pm-i18n:%D0%A2%D0%B5%D0%BC%D0%BF%D0%B5%D1%80%D0%B0%D1%82%D1%83%D1%80%D0%B0%20%D0%B8%D0%BD%D0%B2%D0%B5%D1%80%D1%82%D0%BE%D1%80%D0%B0-->Температура инвертора</option><option value="soc"><!--pm-i18n:%D0%97%D0%B0%D1%80%D1%8F%D0%B4%20%D0%B1%D0%B0%D1%82%D0%B0%D1%80%D0%B5%D0%B8%20%C2%B7%20SOC-->Заряд батареи · SOC</option></select></label><label><!--pm-i18n:%D0%9F%D0%BE%D0%BA%D0%B0%D0%B7%D0%B0%D1%82%D0%B5%D0%BB%D0%B8-->Показатели<select id="metric"><option value="all"><!--pm-i18n:%D0%92%D1%81%D0%B5%20%D0%BF%D0%BE%D1%82%D0%BE%D0%BA%D0%B8%20%D1%8D%D0%BD%D0%B5%D1%80%D0%B3%D0%B8%D0%B8-->Все потоки энергии</option><option value="load"><!--pm-i18n:%D0%9F%D0%BE%D1%82%D1%80%D0%B5%D0%B1%D0%BB%D0%B5%D0%BD%D0%B8%D0%B5-->Потребление</option><option value="grid"><!--pm-i18n:%D0%98%D0%B7%20%D1%81%D0%B5%D1%82%D0%B8-->Из сети</option><option value="pv"><!--pm-i18n:%D0%A1%D0%BE%D0%BB%D0%BD%D0%B5%D1%87%D0%BD%D0%B0%D1%8F%20%D0%B3%D0%B5%D0%BD%D0%B5%D1%80%D0%B0%D1%86%D0%B8%D1%8F-->Солнечная генерация</option><option value="batteryCharge"><!--pm-i18n:%D0%97%D0%B0%D1%80%D1%8F%D0%B4%20%D0%B1%D0%B0%D1%82%D0%B0%D1%80%D0%B5%D0%B8-->Заряд батареи</option><option value="batteryDischarge"><!--pm-i18n:%D0%A0%D0%B0%D0%B7%D1%80%D1%8F%D0%B4%20%D0%B1%D0%B0%D1%82%D0%B0%D1%80%D0%B5%D0%B8-->Разряд батареи</option></select></label><label><!--pm-i18n:%D0%9F%D0%B5%D1%80%D0%B8%D0%BE%D0%B4-->Период<select id="period"><option value="1"><!--pm-i18n:24%20%D1%87%D0%B0%D1%81%D0%B0-->24 часа</option><option value="7"><!--pm-i18n:7%20%D0%B4%D0%BD%D0%B5%D0%B9-->7 дней</option><option value="30"><!--pm-i18n:30%20%D0%B4%D0%BD%D0%B5%D0%B9-->30 дней</option><option value="365"><!--pm-i18n:%D0%93%D0%BE%D0%B4-->Год</option><option value="all"><!--pm-i18n:%D0%92%D0%B5%D1%81%D1%8C%20%D1%81%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D1%91%D0%BD%D0%BD%D1%8B%D0%B9%20%D0%BF%D0%B5%D1%80%D0%B8%D0%BE%D0%B4-->Весь сохранённый период</option><option value="custom"><!--pm-i18n:%D0%92%D1%8B%D0%B1%D1%80%D0%B0%D1%82%D1%8C%20%D0%B4%D0%B0%D1%82%D1%8B-->Выбрать даты</option></select></label><label><!--pm-i18n:%D0%A1-->С<input type="date" id="from"></label><label><!--pm-i18n:%D0%9F%D0%BE-->По<input type="date" id="to"></label><button id="show" class="primary"><!--pm-i18n:%D0%9F%D0%BE%D0%BA%D0%B0%D0%B7%D0%B0%D1%82%D1%8C-->Показать</button><button id="csv"><!--pm-i18n:CSV%20%D0%B3%D1%80%D0%B0%D1%84%D0%B8%D0%BA%D0%B0-->CSV графика</button></div><div id="stats" class="stats"></div><div class="period-heading"><strong id="range"></strong><div class="zoom"><button id="zoom-in" aria-label="Приблизить период" data-pm-i18n-aria-label="%D0%9F%D1%80%D0%B8%D0%B1%D0%BB%D0%B8%D0%B7%D0%B8%D1%82%D1%8C%20%D0%BF%D0%B5%D1%80%D0%B8%D0%BE%D0%B4">＋</button><button id="zoom-out" aria-label="Отдалить период" data-pm-i18n-aria-label="%D0%9E%D1%82%D0%B4%D0%B0%D0%BB%D0%B8%D1%82%D1%8C%20%D0%BF%D0%B5%D1%80%D0%B8%D0%BE%D0%B4">−</button></div></div><div id="legend" class="legend"></div><p id="message" role="status" class="muted"></p><div class="plot-wrap"><svg id="plot" viewBox="0 0 1100 380" role="img" aria-label="График сохранённой истории" data-pm-i18n-aria-label="%D0%93%D1%80%D0%B0%D1%84%D0%B8%D0%BA%20%D1%81%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D1%91%D0%BD%D0%BD%D0%BE%D0%B9%20%D0%B8%D1%81%D1%82%D0%BE%D1%80%D0%B8%D0%B8" tabindex="0"></svg><div id="tooltip" class="tooltip hidden"></div></div><div class="chart-help muted"><span><!--pm-i18n:%D0%9D%D0%B0%D0%B2%D0%B5%D0%B4%D0%B8%D1%82%D0%B5%20%D0%BA%D1%83%D1%80%D1%81%D0%BE%D1%80%20%D0%B8%D0%BB%D0%B8%20%D0%BA%D0%BE%D1%81%D0%BD%D0%B8%D1%82%D0%B5%D1%81%D1%8C%20%D0%B3%D1%80%D0%B0%D1%84%D0%B8%D0%BA%D0%B0%20%E2%80%94%20%D0%B7%D0%BD%D0%B0%D1%87%D0%B5%D0%BD%D0%B8%D1%8F%20%D0%B7%D0%B0%20%D0%B2%D1%8B%D0%B1%D1%80%D0%B0%D0%BD%D0%BD%D1%8B%D0%B9%20%D0%BC%D0%BE%D0%BC%D0%B5%D0%BD%D1%82.-->Наведите курсор или коснитесь графика — значения за выбранный момент.</span><span id="gap-info"></span></div></section>
      <details class="details"><summary><!--pm-i18n:%D0%9E%20%D1%85%D1%80%D0%B0%D0%BD%D0%B5%D0%BD%D0%B8%D0%B8%20%D0%B8%20%D0%BF%D0%BE%D0%BB%D0%BD%D0%BE%D1%82%D0%B5%20%D0%B8%D1%81%D1%82%D0%BE%D1%80%D0%B8%D0%B8-->О хранении и полноте истории</summary><p><!--pm-i18n:%D0%90%D1%80%D1%85%D0%B8%D0%B2%20%D0%BD%D0%B0%D1%85%D0%BE%D0%B4%D0%B8%D1%82%D1%81%D1%8F%20%D0%B2%20Home%20Assistant%20%D0%B8%20%D0%B4%D0%BE%D1%81%D1%82%D1%83%D0%BF%D0%B5%D0%BD%20%D0%BF%D1%80%D0%B8%20%D0%B2%D1%8B%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%BD%D0%BD%D0%BE%D0%B9%20ESP.%20%D0%97%D0%B0%D0%BF%D0%B8%D1%81%D0%B8%20%D1%81%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D1%8F%D1%8E%D1%82%D1%81%D1%8F%20%D0%B1%D0%B5%D0%B7%20%D0%B0%D0%B2%D1%82%D0%BE%D0%BC%D0%B0%D1%82%D0%B8%D1%87%D0%B5%D1%81%D0%BA%D0%BE%D0%B3%D0%BE%20%D1%83%D0%B4%D0%B0%D0%BB%D0%B5%D0%BD%D0%B8%D1%8F.%20%D0%A1%D1%80%D0%B5%D0%B4%D0%BD%D1%8F%D1%8F%20%D0%BC%D0%BE%D1%89%D0%BD%D0%BE%D1%81%D1%82%D1%8C%20%D1%80%D0%B0%D1%81%D1%81%D1%87%D0%B8%D1%82%D0%B0%D0%BD%D0%B0%20%D0%BF%D0%BE%20%D1%81%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D1%91%D0%BD%D0%BD%D1%8B%D0%BC%20%D0%B8%D0%B7%D0%BC%D0%B5%D1%80%D0%B5%D0%BD%D0%B8%D1%8F%D0%BC%2C%20%D1%8D%D0%BD%D0%B5%D1%80%D0%B3%D0%B8%D1%8F%20%E2%80%94%20%D0%BF%D0%BE%20%D1%81%D1%83%D1%82%D0%BE%D1%87%D0%BD%D1%8B%D0%BC%20%D0%B8%D1%82%D0%BE%D0%B3%D0%B0%D0%BC%20ESP.%20%D0%9F%D1%80%D0%BE%D0%BF%D1%83%D1%81%D0%BA%D0%B8%20%D0%BD%D0%B5%20%D0%B7%D0%B0%D0%BC%D0%B5%D0%BD%D1%8F%D1%8E%D1%82%D1%81%D1%8F%20%D0%BD%D1%83%D0%BB%D1%8F%D0%BC%D0%B8.%20%D0%A1%D0%B5%D0%B3%D0%BE%D0%B4%D0%BD%D1%8F%D1%88%D0%BD%D0%B8%D0%B9%20%D0%B8%D1%82%D0%BE%D0%B3%20%D0%B5%D1%89%D1%91%20%D1%83%D1%82%D0%BE%D1%87%D0%BD%D1%8F%D0%B5%D1%82%D1%81%D1%8F.-->Архив находится в Home Assistant и доступен при выключенной ESP. Записи сохраняются без автоматического удаления. Средняя мощность рассчитана по сохранённым измерениям, энергия — по суточным итогам ESP. Пропуски не заменяются нулями. Сегодняшний итог ещё уточняется.</p></details></main>`);
    this._view=new URLSearchParams(location.search).has('manage')?'interface':'overview';
    this.el('create-dashboard').onclick=()=>this.createDashboard();
    for(const name of ['overview','history','interface'])this.el('tab-'+name).onclick=()=>this.showView(name);
    this.el('interface-save').onclick=()=>this.saveInterface();
    this.el('interface-mode').onchange=()=>{this._interfaceDirty=true};
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
      if(this._view==='history')await this.draw();
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
  async draw(){
    if(this._busy){this._redraw=true;return}const device=this.el('device').value;if(!device)return;
    this._busy=true;setText(this.el('message'),()=>t('Загружаем график из архива HA…'));
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
      const data=await this.api(energy?'days':'history',{device,start,end,maximum:1440}),points=data.points||[];
      this._plotData={data,points,energy,start,end,mode};this.renderPlot(this._plotData);
      setText(this.el('message'),()=>points.length?'':t('В выбранном диапазоне пока нет сохранённых данных.'));
      setText(this.el('range'),()=>`${new Date(start*1000).toLocaleDateString(locale())} — ${new Date(end*1000).toLocaleDateString(locale())}${!energy&&end-start<=86401?' · '+new Date(start*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+'–'+new Date(end*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):''}`);
      this._lastGraph={kind:energy?'daily':'minute',points:points.length,start,end,source:data.source};
    }catch(e){this.showError(e)}finally{this._busy=false;if(this._redraw){this._redraw=false;this.draw()}}
  }

  formatValue(value,energy=false){
    if(value==null||!Number.isFinite(value))return '—';
    const scaled=energy||Math.abs(value)>=1000;
    return new Intl.NumberFormat(locale(),{maximumFractionDigits:scaled?2:0}).format(scaled?value/1000:value)+' '+(energy?t('кВт·ч'):scaled?t('кВт'):t('Вт'));
  }
  value(point,series,energy){return point[energy?series.id+'Wh':series.field]}
  valid(point,series,energy){return Number.isFinite(this.value(point,series,energy))&&(energy||!!(series.source==='battery'?point.batteryAvailable:point.available))}
  measurement(value,series,energy=false){if(energy||series.unit==='Вт')return this.formatValue(value,energy);return Number.isFinite(value)?new Intl.NumberFormat(locale(),{maximumFractionDigits:series.unit==='В'?2:1}).format(value)+' '+t(series.unit):'—'}
  exportCsv(){const m=this._plotData;if(!m)return;const series=PM_GROUPS[m.mode];const rows=[[t('Время'),...series.map(s=>t(s.name)+' ('+(m.energy?'Wh':technical(s.unit))+')')],...m.points.map(p=>[new Date(p.timestamp*1000).toISOString(),...series.map(s=>this.valid(p,s,m.energy)?this.value(p,s,m.energy):'')])];const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='power-monitor-'+m.mode+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  renderPlot(model){
    const {data,points,energy,start,end,mode}=model;const catalog=PM_GROUPS[mode];this.hideTip();
    const chosen=this.el('metric').value;
    const active=catalog.filter(s=>chosen==='all'?this._visible.has(s.id):s.id===chosen);
    this.el('legend').replaceChildren(...catalog.filter(s=>chosen==='all'||s.id===chosen).map(s=>{
      const b=document.createElement('button');b.type='button';b.setAttribute('aria-pressed',String(active.includes(s)));
      const dot=document.createElement('span');dot.className='dot';dot.style.background=s.color;b.append(dot,setText(document.createTextNode(''),()=>t(s.name)));
      b.onclick=()=>{if(chosen!=='all')return;if(this._visible.has(s.id)){if(this._visible.size===1)return;this._visible.delete(s.id)}else this._visible.add(s.id);this.renderPlot(model)};return b;
    }));
    this.el('stats').replaceChildren(...catalog.map(s=>{
      const card=document.createElement('div');card.className='stat';const name=document.createElement('div');name.className='stat-name';
      const dot=document.createElement('span');dot.className='dot';dot.style.background=s.color;name.append(dot,setText(document.createTextNode(''),()=>t(s.name)));
      const value=document.createElement('div');value.className='stat-value';const note=document.createElement('div');note.className='stat-note';
      if(energy){const values=points.map(p=>p[s.id+'Wh']).filter(Number.isFinite);setText(value,()=>this.formatValue(values.length?values.reduce((a,b)=>a+b,0):null,true));setText(note,()=>t('Сумма за выбранный период')+(points.some(p=>p.provisional)?t(' · сегодня не завершено'):''))}
      else{const stat=data.summary?.channels?.[s.field];setText(value,()=>this.measurement(stat?.average,s));setText(note,()=>t('Среднее · мин. ')+this.measurement(stat?.min,s)+t(' · макс. ')+this.measurement(stat?.max,s))}
      card.append(name,value,note);return card;
    }));
    const plotWidth=this.el('plot').clientWidth||this.clientWidth-32,mobile=plotWidth<600,w=Math.max(320,plotWidth),h=mobile?320:380;
    const units=[...new Set(active.map(s=>energy?t('кВт·ч'):s.unit))];if(!units.length)units.push(energy?t('кВт·ч'):t('Вт'));
    const left=mobile?45:72,right=w-15-Math.max(0,units.length-1)*(mobile?40:65),top=28,bottom=h-45;
    const x=t=>left+(t-start)/(end-start)*(right-left),axes=new Map();
    for(const unit of units){const values=active.filter(s=>(energy?t('кВт·ч'):s.unit)===unit).flatMap(s=>points.filter(p=>this.valid(p,s,energy)).map(p=>this.value(p,s,energy)));let lo=Math.min(0,...values),hi=Math.max(1,...values);
      if(unit==='%'){lo=0;hi=100}else if(!energy&&unit==='В'&&values.length){lo=Math.max(0,Math.min(...values)*.95);hi=Math.max(lo+1,Math.max(...values)*1.05)}
      const raw=(hi-lo)/4,magnitude=10**Math.floor(Math.log10(raw)),step=[1,2,2.5,5,10].find(v=>v*magnitude>=raw)*magnitude;
      lo=Math.floor(lo/step)*step;hi=Math.ceil(hi/step)*step;axes.set(unit,{lo,hi,step})}
    const y=(v,s)=>{const a=axes.get(energy?t('кВт·ч'):s?.unit||units[0]);return bottom-(v-a.lo)/(a.hi-a.lo)*(bottom-top)};
    model.layout={w,h,left,right,top,bottom,x,y,active};let svg='';
    units.forEach((unit,index)=>{const a=axes.get(unit),series=active.find(s=>(energy?t('кВт·ч'):s.unit)===unit),color=index?series?.color:'var(--secondary-text-color)',axis=index?right+12+(index-1)*(mobile?43:65):left-9;
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
      svg+=`<line class="axis-grid" x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${bottom}"/><text x="${x(t)}" y="${bottom+24}" text-anchor="${x(t)-left<30?'start':right-x(t)<30?'end':'middle'}">${label}</text>`;
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
    this.el('plot').setAttribute('viewBox',`0 0 ${w} ${h}`);this.el('plot').setAttribute('preserveAspectRatio','none');setMarkup(this.el('plot'),svg);
    const gapCount=data.summary?.gapCount||0;
    this.el('gap-info').classList.toggle('warning',!!gapCount||!!data.conflictingSequences);
    setText(this.el('gap-info'),()=>energy?(points.some(p=>p.provisional)?t('Сегодня — предварительный итог.'):t('Суточные итоги ESP.')):
      gapCount?t('Серым отмечены интервалы без записей.'):points.some(p=>!p.available)?t('Разрывы линии — нет измерений инвертора.'):'');
    if(data.conflictingSequences)this.el('gap-info').textContent+=t(' Есть неоднозначные записи; в график не включены.');
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
    setText(head,()=>new Date(p.timestamp*1000).toLocaleString(locale(),energy?{day:'numeric',month:'long',year:'numeric'}:{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}));tip.append(head);
    const row=(name,value,color)=>{const r=document.createElement('div');r.className='tip-row';const n=document.createElement('span');if(color){const dot=document.createElement('i');dot.className='dot';dot.style.background=color;n.append(dot)}n.append(setText(document.createTextNode(''),()=>t(name)));const v=document.createElement('strong');setText(v,()=>value);r.append(n,v);tip.append(r)};
    for(const s of PM_GROUPS[m.mode])row(s.name,this.valid(p,s,energy)?this.measurement(this.value(p,s,energy),s,energy):t('Нет данных'),s.color);
    if(energy){if(p.days>1)row(t('В этом столбце'),p.days+t(' дней'));if(p.provisional)row(t('Сегодня'),t('Предварительно'))}
    else{const separator=document.createElement('div');separator.className='tip-extra';tip.append(separator);
      row(t('Уровень заряда'),p.batteryAvailable&&p.soc!==255?p.soc+' %':'—');row(t('Напряжение батареи'),p.batteryAvailable?(p.battMv/1000).toFixed(2)+t(' В'):'—');
      row(t('Напряжение PV'),p.available&&p.pvDv!==65535?(p.pvDv/10).toFixed(1)+t(' В'):'—');row(t('Температура инвертора'),p.available&&p.tInv!==-128?p.tInv+' °C':'—');
    }
    tip.classList.remove('hidden');const rect=this.el('plot').getBoundingClientRect(),px=l.x(p.timestamp)/l.w*rect.width;
    tip.style.left=Math.max(0,Math.min(rect.width-tip.offsetWidth,px+(px>rect.width/2?-tip.offsetWidth-12:12)))+'px';tip.style.top='12px';
    const line=this.el('plot').querySelector('#cursor-line');line.setAttribute('x1',l.x(p.timestamp));line.setAttribute('x2',l.x(p.timestamp));
    this.el('plot').querySelector('#cursor').setAttribute('visibility','visible');
    setMarkup(this.el('plot').querySelector('#cursor-dots'),energy?'':l.active.filter(s=>this.valid(p,s,false)).map(s=>`<circle cx="${l.x(p.timestamp)}" cy="${l.y(this.value(p,s,false),s)}" r="3.5" fill="${s.color}" stroke="var(--ha-card-background,var(--card-background-color))" stroke-width="1.5"/>`).join(''));
  }
  zoom(factor){const m=this._plotData;if(!m)return;const span=Math.max(m.energy?86400:3600,Math.min(10*365*86400,(m.end-m.start)*factor)),middle=(m.end+m.start)/2;
    this._zoomRange={start:Math.max(0,Math.floor(middle-span/2)),end:Math.min(0xffffffff,Math.ceil(middle+span/2))};this.el('period').value='custom';this.draw();}
}
if(!customElements.get('power-monitor-panel'))customElements.define('power-monitor-panel',PowerMonitorPanel);
