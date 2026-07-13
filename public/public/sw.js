const SHELL='hue-shell-v4', TILES='hue-offline-tiles-v1';
const ASSETS=['/','/map','/style.css','/map.js','/offline-db.js','/manifest.webmanifest','/favicon.png','/logo-kiem-lam-hue.png','https://unpkg.com/leaflet@1.9.4/dist/leaflet.css','https://unpkg.com/leaflet@1.9.4/dist/leaflet.js','https://unpkg.com/leaflet.vectorgrid@1.3.0/dist/Leaflet.VectorGrid.bundled.js'];
self.addEventListener('install',e=>e.waitUntil(caches.open(SHELL).then(c=>Promise.allSettled(ASSETS.map(a=>c.add(a))))));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  const u=new URL(e.request.url);
  if(u.pathname.startsWith('/api/')) return;
  e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(r=>{const copy=r.clone();caches.open(SHELL).then(c=>c.put(e.request,copy));return r}).catch(()=>cached)));
});
self.addEventListener('message',e=>{
  const d=e.data||{};
  if(d.type==='CACHE_TILES') e.waitUntil((async()=>{const cache=await caches.open(TILES);let done=0,failed=0;for(const url of d.urls||[]){try{const r=await fetch(url,{mode:'cors'});if(r.ok) await cache.put(url,r.clone()); else failed++;}catch(_){failed++;}done++; if(done%20===0) e.source?.postMessage({type:'CACHE_PROGRESS',done,total:d.urls.length,failed});}e.source?.postMessage({type:'CACHE_DONE',done,total:d.urls.length,failed});})());
  if(d.type==='CLEAR_TILES') e.waitUntil(caches.delete(TILES).then(()=>e.source?.postMessage({type:'TILES_CLEARED'})));
});
