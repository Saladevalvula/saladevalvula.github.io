const CACHE='sala-valvulas-cmms-v2-v3';
const CORE=['./','./index.html','./cmms-v2-prelude.js','./cmms-v2.js','./preventive-cycle-ui.js','./manifest.webmanifest','./app-icon.svg'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

async function networkFirst(request,fallbackKey){
  const cache=await caches.open(CACHE);
  try{
    const response=await fetch(request);
    if(response && response.ok) cache.put(request,response.clone());
    return response;
  }catch(err){
    return (await cache.match(request)) || (fallbackKey ? await cache.match(fallbackKey) : undefined) || Response.error();
  }
}

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin) return;

  // Prioriza a versão mais nova do app para evitar interface presa em cache antigo.
  if(event.request.mode==='navigate'){
    event.respondWith(networkFirst(event.request,'./index.html'));
    return;
  }

  if(['cmms-v2.js','cmms-v2-prelude.js','preventive-cycle-ui.js','dashboard-reporting.js','dashboard-reporting-pdf.js','manifest.webmanifest','service-worker.js'].some(name=>url.pathname.endsWith('/'+name))){
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached=>{
      const fresh=fetch(event.request).then(response=>{
        if(response && response.ok) caches.open(CACHE).then(c=>c.put(event.request,response.clone()));
        return response;
      }).catch(()=>cached);
      return cached || fresh;
    })
  );
});
