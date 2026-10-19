import {t} from './i18n.js?v=1.0.207';
const resourcesReady=items=>['button-card.js','mushroom.js','apexcharts-card.js','card-mod.js','power-flow-card-plus.js'].every(file=>items.some(x=>x.url?.split('?')[0].endsWith('/'+file)));
export async function ensureDashboard(hass,device,{fetchTemplate=async()=>{
  const response=await fetch('/power_monitor_archive/dashboard-template.json?v=1.0.207');
  if(!response.ok)throw new Error('template_unavailable');return response.json();
},requireStyled=false}={}){
  const path='power-monitor-'+device,existing=await hass.callWS({type:'lovelace/dashboards/list'});
  const exists=existing.some(d=>d.url_path===path);let needsConfig=!exists;
  if(exists){
    try{await hass.callWS({type:'lovelace/config',url_path:path})}
    catch(error){if(error.code!=='config_not_found')throw error;needsConfig=true}
  }
  if(needsConfig){
    const resources=await hass.callWS({type:'lovelace/resources'}),styled=resourcesReady(resources);
    if(requireStyled&&!styled)throw new Error('frontend_resources_not_ready');
    let config;
    if(styled){
      const template=await fetchTemplate(),registry=await hass.callWS({type:'config/entity_registry/list'});
      const ids=new Map(registry.filter(e=>e.platform==='power_monitor_archive'&&e.unique_id.startsWith(device+'_')).map(e=>[e.unique_id.slice(13),e.entity_id]));
      config=JSON.parse(JSON.stringify(template).replace(/__PM_([a-z0-9_]+)__/g,(_,key)=>{if(!ids.has(key))throw new Error('missing_entity_'+key);return ids.get(key)}));
    }else{
      const card=section=>({type:'custom:power-monitor-card',device,section});
      config={views:[{title:t('Обзор'),path:'energy',cards:[{type:'vertical-stack',cards:[card('flow'),card('system'),card('battery')]},{type:'vertical-stack',cards:[card('energy'),card('inverter')]},{type:'vertical-stack',cards:[card('bank')]}]},{title:t('Диагностика'),path:'diagnostics',icon:'mdi:battery-heart-variant',type:'sections',max_columns:2,sections:['bms1','bms2'].map(section=>({type:'grid',cards:[card(section)]}))}]};
    }
    config.views=config.views.filter(view=>['energy','diagnostics'].includes(view.path));config.views[0].title=t('Обзор');const diagnostics=config.views.find(view=>view.path==='diagnostics');if(diagnostics)diagnostics.title=t('Диагностика');
    config.views.push({title:t('Управление'),path:'control',type:'panel',cards:[{type:'custom:power-monitor-device-card',device,page:'relays'}]});
    config.views.push({title:t('История'),path:'archive',type:'panel',cards:[{type:'custom:power-monitor-history-card',device,period:'1',metric:'power'}]});
    if(!exists)await hass.callWS({type:'lovelace/dashboards/create',url_path:path,title:'Power Monitor',icon:'mdi:flash',require_admin:true,show_in_sidebar:true});
    await hass.callWS({type:'lovelace/config/save',url_path:path,config});
  }
  await hass.callWS({type:'power_monitor_archive/query',action:'dashboard',device,dashboardPath:path});
  return path;
}
let started=false;
export async function autoProvisionDashboards(){
  if(started)return;started=true;
  let attempts=0;
  const tick=async()=>{
    const hass=document.querySelector('home-assistant')?.hass;
    if(hass?.connected&&hass.user?.is_admin){
      try{
        const status=await hass.callWS({type:'power_monitor_archive/query',action:'status'});
        if(status.devices?.length){
          for(const device of status.devices)if(!device.dashboardPath)await ensureDashboard(hass,device.deviceId,{requireStyled:true});
          return;
        }
      }catch(error){if(++attempts>=30){console.warn('Power Monitor dashboard setup:',error.message);return}}
    }else if(hass?.connected&&hass.user&&!hass.user.is_admin)return;
    if(++attempts<90)setTimeout(tick,2000);
  };
  return tick();
}
