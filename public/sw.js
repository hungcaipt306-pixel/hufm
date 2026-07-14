const SHELL='hue-shell-v30-google-satellite-only', TILES='hue-offline-tiles-v1';
const STATIC_ASSETS=['/style.css','/map.js','/offline-db.js','/manifest.webmanifest','/favicon.png','/logo-kiem-lam-hue.png','/vendor/leaflet/leaflet.css','/vendor/leaflet/leaflet.js','/vendor/vectorgrid/Leaflet.VectorGrid.bundled.js'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(SHELL).then(cache=>Promise.allSettled(STATIC_ASSETS.map(asset=>cache.add(asset)))));
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for(const key of await caches.keys()){
      if(key.startsWith('hue-shell-')&&key!==SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET') return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin) return;
  if(url.pathname.startsWith('/api/')) return;

  // Trang HTML luôn ưu tiên máy chủ để không dùng nhầm trang đăng nhập đã cache.
  if(request.mode==='navigate'){
    event.respondWith((async()=>{
      try{
        const response=await fetch(request,{cache:'no-store'});
        // Chỉ lưu trang bản đồ khi trả về trực tiếp, không lưu kết quả redirect về /login.
        if(url.pathname==='/map'&&response.ok&&!response.redirected){
          const cache=await caches.open(SHELL);
          await cache.put('/map',response.clone());
        }
        return response;
      }catch(error){
        if(url.pathname==='/map'){
          const cachedMap=await caches.match('/map');
          if(cachedMap) return cachedMap;
        }
        const cached=await caches.match(request);
        if(cached) return cached;
        return new Response('HUFM đang ngoại tuyến. Hãy kết nối mạng để đăng nhập.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
      }
    })());
    return;
  }

  // Tài nguyên tĩnh: cache-first, sau đó cập nhật từ mạng.
  event.respondWith((async()=>{
    const cached=await caches.match(request);
    if(cached) return cached;
    const response=await fetch(request);
    if(response.ok){
      const cache=await caches.open(SHELL);
      await cache.put(request,response.clone());
    }
    return response;
  })());
});

self.addEventListener('message',event=>{
  const data=event.data||{};
  if(data.type==='CACHE_TILES') event.waitUntil((async()=>{
    const cache=await caches.open(TILES);let done=0,failed=0;
    for(const url of data.urls||[]){
      try{const response=await fetch(url,{mode:'cors'});if(response.ok)await cache.put(url,response.clone());else failed++;}catch(_){failed++;}
      done++;if(done%20===0)event.source?.postMessage({type:'CACHE_PROGRESS',done,total:data.urls.length,failed});
    }
    event.source?.postMessage({type:'CACHE_DONE',done,total:data.urls.length,failed});
  })());
  if(data.type==='SKIP_WAITING') self.skipWaiting();
  if(data.type==='CLEAR_APP_CACHE') event.waitUntil((async()=>{
    for(const key of await caches.keys())if(key.startsWith('hue-shell-'))await caches.delete(key);
    event.source?.postMessage({type:'APP_CACHE_CLEARED'});
  })());
  if(data.type==='CLEAR_TILES') event.waitUntil(caches.delete(TILES).then(()=>event.source?.postMessage({type:'TILES_CLEARED'})));
});
