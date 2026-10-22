/* Served by HA's /local/ before the integration's routes finish starting. */
const version='1.0.220';
const root='/power_monitor_archive/';
const started=Date.now();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function loadCards(){
  let attempt=0,lastError;
  while(Date.now()-started<180000){
    try{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
      let response;
      try{response=await fetch(root+'inverter-catalog.js?v='+version,{cache:'no-store',signal:controller.signal})}finally{clearTimeout(timer)}
      if(!response.ok)throw new Error('Power Monitor is still starting');
      await import(root+'cards.js?v='+version+'&loader='+attempt);
      return;
    }catch(error){lastError=error;attempt++;await pause(Math.min(1000*attempt,5000))}
  }
  throw lastError||new Error('Power Monitor did not finish starting');
}
await loadCards();
