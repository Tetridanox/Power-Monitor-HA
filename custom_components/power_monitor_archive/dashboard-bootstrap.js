// Provision from any HA page, including Settings, before Lovelace loads cards.
import {autoProvisionDashboards} from './dashboard-setup.js?v=1.0.255';
if(document.head&&!document.getElementById('power-monitor-appearance')){
 const style=document.createElement('link');
 style.id='power-monitor-appearance';style.rel='stylesheet';
 style.href='/power_monitor_archive/appearance.css?v=1.0.255';
 document.head.append(style);
}
const start=()=>autoProvisionDashboards();
window.addEventListener('location-changed',start);
window.addEventListener('focus',start);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)start()});
start();
