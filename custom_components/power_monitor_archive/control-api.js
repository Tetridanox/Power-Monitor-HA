import {t} from './i18n.js?v=1.0.236';
/* HA-only transport. Credentials and LAN addresses never enter this module. */
const utf8=new TextEncoder(), decoder=new TextDecoder();
const encode=bytes=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text)};
const decode=text=>Uint8Array.from(atob(text||''),c=>c.charCodeAt(0));
export class DeviceApi {
  constructor(hass,device){this.hass=hass;this.device=device;this.tail=Promise.resolve();this.pending=new Map()}
  request(path,{method='GET',body,headers={}}={}){
    const expert=/^inverter\/(settings(?:$|[/?])|expert$)/.test(path);
    const message={method,path:'/api/'+path,headers:{...(expert&&this._inverterToken?{'X-Inverter-Token':this._inverterToken}:{}),...headers}};
    if(body!==undefined){if(body instanceof Uint8Array)message.body=encode(body);else {message.body=encode(utf8.encode(JSON.stringify(body)));message.headers['Content-Type']='application/json'}}
    const key=method==='GET'?JSON.stringify(message):null;
    if(key&&this.pending.has(key))return this.pending.get(key);
    const run=this.tail.then(async()=>{
      const result=await this.hass.callWS({type:'power_monitor_archive/device',device:this.device,request:message});
      let data;try{data=JSON.parse(decoder.decode(decode(result.body)))}catch(_){throw new Error(t('Неполный ответ устройства'))}
      if(result.status>=400){const error=new Error(data.message||data.error||`HTTP ${result.status}`);error.status=result.status;error.data=data;throw error}
      if(method==='POST'&&path==='inverter/expert'){
        if(body?.confirmation==='LOCK')this._inverterToken='';
        else if(body?.confirmation==='UNLOCK')this._inverterToken=/^[0-9a-f]{32}$/i.test(data.token||'')?data.token:'';
      }
      return {status:result.status,data};
    });
    this.tail=run.catch(()=>{});if(key){this.pending.set(key,run);run.finally(()=>{if(this.pending.get(key)===run)this.pending.delete(key)}).catch(()=>{})}return run;
  }
  async get(path,headers){return (await this.request(path,{headers})).data}
  async post(path,body,headers){return (await this.request(path,{method:'POST',body,headers})).data}
}
export const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function ticketResult(api,path,ticket,{timeout=20000,success='ok'}={}){
  if(!ticket)throw new Error(t('Устройство не вернуло номер операции'));
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    await wait(500);
    let result;
    try{result=await api.request(path,{headers:{'X-BMS-Ticket':String(ticket)}})}catch(error){if(error.status===404)throw new Error(t('Результат утрачен. Проверьте состояние перед повтором'));throw error}
    if(result.status===202)continue;
    if(result.data[success]===true||result.data[success]==='verified')return result.data;
    throw new Error(result.data.error||result.data.result||t('Запись не подтверждена'));
  }
  throw new Error(t('Результат не подтверждён. Проверьте состояние перед повтором'));
}
