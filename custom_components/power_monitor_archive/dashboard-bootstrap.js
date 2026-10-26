// Provision from any HA page, including Settings, before Lovelace loads cards.
import {autoProvisionDashboards} from './dashboard-setup.js?v=1.0.236';
const start=()=>autoProvisionDashboards();
window.addEventListener('location-changed',start);
window.addEventListener('focus',start);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)start()});
start();
