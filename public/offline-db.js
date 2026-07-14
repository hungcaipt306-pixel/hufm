const OfflineDB = (() => {
  const DB='hue-forest-offline-v1', STORE='kv';
  const open=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore(STORE);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  const run=async(mode,fn)=>{const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,mode);const s=tx.objectStore(STORE);const r=fn(s);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);tx.oncomplete=()=>db.close()})};
  return { get:k=>run('readonly',s=>s.get(k)), set:(k,v)=>run('readwrite',s=>s.put(v,k)), del:k=>run('readwrite',s=>s.delete(k)) };
})();
