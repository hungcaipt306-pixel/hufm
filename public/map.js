const map = L.map('map', { zoomControl:true }).setView([16.4637, 107.5909], 11);
const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'&copy; OpenStreetMap contributors' }).addTo(map);
const topoLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom:17, attribution:'Bản đồ địa hình &copy; OpenTopoMap, dữ liệu &copy; OpenStreetMap' });

const waypointLayer = L.layerGroup().addTo(map);
const trackLayer = L.layerGroup().addTo(map);
const fireAlertLayer = L.layerGroup().addTo(map);
const uploadedLayers = new Map();
const layerControl = L.control.layers({ 'Đường phố': streetLayer, 'Địa hình & bình độ': topoLayer }, { Waypoint: waypointLayer, Tracklog: trackLayer, 'Cảnh báo cháy rừng': fireAlertLayer }, { collapsed: false }).addTo(map);
let currentPosition = null;
let currentMarker = null;
let accuracyCircle = null;
let locationWatchId = null;
let isFollowingLocation = false;
let isTracking = false;
let currentHeading = 0;
let lastGpsHeading = null;
let orientationListening = false;
let headingUpEnabled = false;
let mapBearing = 0;
let trackPoints = [];
let liveLine = null;
let pendingMode = null;
let appConfig = { offlineTileUrl:'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', offlineTileMax:1200 };
let cachedMapData = { waypoints:[], tracks:[] };
const statusEl = document.getElementById('status');
const modal = document.getElementById('modal');

function status(text) { statusEl.textContent = text; }
function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
async function api(url, opts = {}) {
  const headers = opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  const response = await fetch(url, { headers, ...opts });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Có lỗi xảy ra');
  return data;
}
function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function randomVectorStyle() {
  return { weight: 2, opacity: 0.9, fillOpacity: 0.25 };
}

async function loadData() {
  let data;
  try { data = await api('/api/map-data'); cachedMapData=data; await OfflineDB.set('mapData',data); }
  catch (e) { data = await OfflineDB.get('mapData') || {waypoints:[],tracks:[]}; if(!navigator.onLine) status('Đang dùng dữ liệu đã lưu trên thiết bị.'); else throw e; }
  const pending = await getPending();
  data = { waypoints:[...(data.waypoints||[]), ...pending.filter(x=>x.type==='waypoint').map(x=>({id:x.clientId, ...x.payload, offline:true, User:{name:'Chưa đồng bộ'}}))], tracks:[...(data.tracks||[]), ...pending.filter(x=>x.type==='track').map(x=>({id:x.clientId, ...x.payload, offline:true, distanceMeters:calcDistance(x.payload.points||[]), User:{name:'Chưa đồng bộ'}}))] };
  waypointLayer.clearLayers();
  trackLayer.clearLayers();
  const list = document.getElementById('dataList');
  list.innerHTML = '';
  const bounds = [];
  data.waypoints.forEach(w => {
    L.marker([w.latitude, w.longitude])
      .bindPopup(`<b>${esc(w.name)}</b><br>${esc(w.category)}<br>${esc(w.description || '')}<br><small>${esc(w.User?.name || '')}</small>`)
      .addTo(waypointLayer);
    bounds.push([w.latitude, w.longitude]);
    list.insertAdjacentHTML('beforeend', `<div class="data-item"><span class="wp-dot"></span><b>${esc(w.name)}</b><br><small>${w.latitude.toFixed(5)}, ${w.longitude.toFixed(5)}</small><br><button onclick="focusPoint(${w.latitude},${w.longitude})">Xem</button> ${w.offline ? '<span class="offline-badge">Chờ đồng bộ</span>' : `<button class="danger" onclick="deleteWaypoint(${w.id})">Xóa</button>`}</div>`);
  });
  data.tracks.forEach(t => {
    const pts = t.points.map(p => [p.lat, p.lng]);
    if (pts.length) {
      L.polyline(pts, { weight: 4 })
        .bindPopup(`<b>${esc(t.name)}</b><br>${Math.round(t.distanceMeters)} m<br><small>${esc(t.User?.name || '')}</small>`)
        .addTo(trackLayer);
      bounds.push(...pts);
    }
    list.insertAdjacentHTML('beforeend', `<div class="data-item"><span class="track-dot"></span><b>${esc(t.name)}</b><br><small>${Math.round(t.distanceMeters)} m • ${t.points.length} điểm</small><div class="data-actions"><button onclick='focusTrack(${JSON.stringify(pts)})'>Xem</button>${t.offline ? '<span class="offline-badge">Chờ đồng bộ</span>' : `<a class="mini-link" href="/api/tracks/${t.id}/export/geojson">GeoJSON + WP</a><a class="mini-link" href="/api/tracks/${t.id}/export/gpx">GPX + WP</a><a class="mini-link" href="/api/tracks/${t.id}/export/kml">KML + WP</a><button class="danger" onclick="deleteTrack(${t.id})">Xóa</button>`}</div></div>`);
  });
  if (!data.waypoints.length && !data.tracks.length) list.innerHTML = '<div class="layer-empty">Chưa có waypoint hoặc tracklog.</div>';
  if (bounds.length && !currentPosition) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
}

function removeUploadedLayer(id) {
  const item = uploadedLayers.get(id);
  if (!item) return;
  map.removeLayer(item.layer);
  layerControl.removeLayer(item.layer);
  uploadedLayers.delete(id);
}
async function createUploadedLayer(meta) {
  let layer;
  if (meta.layerType === 'mbtiles') {
    const format = String(meta.metadata?.format || 'png').toLowerCase();
    const url = `/api/layers/${meta.id}/tiles/{z}/{x}/{y}.${format}`;
    if ((format === 'pbf' || format === 'mvt') && L.vectorGrid) {
      let vectorStyles = {};
      try {
        const jsonMeta = typeof meta.metadata?.json === 'string' ? JSON.parse(meta.metadata.json) : meta.metadata?.json;
        for (const item of jsonMeta?.vector_layers || []) vectorStyles[item.id] = randomVectorStyle();
      } catch (e) { console.warn('Không đọc được metadata vector_layers', e); }
      layer = L.vectorGrid.protobuf(url, {
        maxNativeZoom: Number(meta.metadata?.maxzoom || 22),
        vectorTileLayerStyles: vectorStyles,
        interactive: true
      });
    } else {
      layer = L.tileLayer(url, {
        minZoom: Number(meta.metadata?.minzoom || 0),
        maxZoom: Number(meta.metadata?.maxzoom || 22),
        attribution: meta.metadata?.attribution || ''
      });
    }
  } else {
    const geojson = await api(`/api/layers/${meta.id}/data`);
    layer = L.geoJSON(geojson, {
      style: randomVectorStyle,
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 6, ...randomVectorStyle() }),
      onEachFeature: (feature, featureLayer) => {
        const props = feature.properties || {};
        const rows = Object.entries(props).slice(0, 12).map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v)}`).join('<br>');
        if (rows) featureLayer.bindPopup(rows);
      }
    });
  }
  uploadedLayers.set(meta.id, { layer, meta });
  layerControl.addOverlay(layer, meta.name);
  layer.addTo(map);
  if (layer.getBounds) {
    const bounds = layer.getBounds();
    if (bounds?.isValid()) map.fitBounds(bounds, { padding: [25, 25], maxZoom: 17 });
  } else if (meta.metadata?.bounds) {
    const b = String(meta.metadata.bounds).split(',').map(Number);
    if (b.length === 4 && b.every(Number.isFinite)) map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [25, 25] });
  }
}
async function loadLayers() {
  const layers = await api('/api/layers');
  const currentIds = new Set(layers.map(l => l.id));
  for (const id of uploadedLayers.keys()) if (!currentIds.has(id)) removeUploadedLayer(id);
  const list = document.getElementById('layerList');
  list.innerHTML = '';
  for (const meta of layers) {
    if (!uploadedLayers.has(meta.id)) {
      try { await createUploadedLayer(meta); } catch (e) { console.error(e); }
    }
    const count = meta.layerType === 'mbtiles' ? `${meta.metadata?.tileCount || 0} tile` : `${meta.metadata?.featureCount || 0} đối tượng`;
    list.insertAdjacentHTML('beforeend', `<div class="data-item"><span class="layer-type">${esc(meta.layerType)}</span> <b>${esc(meta.name)}</b><br><small>${formatBytes(meta.sizeBytes)} • ${esc(count)} • ${esc(meta.User?.name || '')}</small><div class="layer-row-actions"><button onclick="zoomLayer(${meta.id})">Xem</button><button onclick="toggleLayer(${meta.id})">Bật/tắt</button><button class="danger" onclick="deleteLayer(${meta.id})">Xóa</button></div></div>`);
  }
  if (!layers.length) list.innerHTML = '<div class="layer-empty">Chưa có lớp bản đồ được tải lên.</div>';
}

window.focusPoint = (a, b) => map.setView([a, b], 17);
window.focusTrack = pts => map.fitBounds(pts, { padding: [30, 30] });
window.deleteWaypoint = async id => { if (confirm('Xóa waypoint này?')) { await api(`/api/waypoints/${id}`, { method: 'DELETE' }); await loadData(); } };
window.deleteTrack = async id => { if (confirm('Xóa tracklog này?')) { await api(`/api/tracks/${id}`, { method: 'DELETE' }); await loadData(); } };
window.toggleLayer = id => {
  const item = uploadedLayers.get(id);
  if (!item) return;
  if (map.hasLayer(item.layer)) map.removeLayer(item.layer); else item.layer.addTo(map);
};
window.zoomLayer = id => {
  const item = uploadedLayers.get(id);
  if (!item) return;
  if (!map.hasLayer(item.layer)) item.layer.addTo(map);
  if (item.layer.getBounds) {
    const bounds = item.layer.getBounds();
    if (bounds?.isValid()) return map.fitBounds(bounds, { padding: [25, 25], maxZoom: 17 });
  }
  const b = String(item.meta.metadata?.bounds || '').split(',').map(Number);
  if (b.length === 4 && b.every(Number.isFinite)) map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [25, 25] });
};
window.deleteLayer = async id => {
  if (!confirm('Xóa lớp bản đồ này?')) return;
  await api(`/api/layers/${id}`, { method: 'DELETE' });
  removeUploadedLayer(id);
  await loadLayers();
  status('Đã xóa lớp bản đồ.');
};

function updateLiveLocationCard(position) {
  const state = document.getElementById('liveLocationState');
  const detail = document.getElementById('liveLocationDetail');
  if (!state || !detail) return;
  const headingText = Number.isFinite(currentHeading) ? ` • hướng ${Math.round(currentHeading)}°` : '';
  state.textContent = isTracking ? 'Đang ghi tracklog realtime' : 'Định vị realtime đang bật';
  detail.textContent = `±${Math.round(position.accuracy || 0)} m${headingText} • ${new Date().toLocaleTimeString('vi-VN')}`;
}
function markerIcon(heading = 0) {
  return L.divIcon({
    className: 'live-location-icon',
    html: `<div class="live-location-marker" style="transform:rotate(${heading}deg)"><span class="direction-arrow"></span></div>`,
    iconSize: [42, 42], iconAnchor: [21, 21], popupAnchor: [0, -21]
  });
}
function applyMapBearing() {
  const mapEl = document.getElementById('map');
  if (!mapEl) return;
  const bearing = headingUpEnabled && Number.isFinite(currentHeading) ? -currentHeading : 0;
  mapBearing = bearing;
  mapEl.classList.toggle('map-bearing-on', headingUpEnabled);
  mapEl.style.setProperty('--map-bearing', `${bearing}deg`);
  mapEl.style.setProperty('--map-bearing-number', String(bearing));
  mapEl.style.setProperty('--map-counter-bearing', `${-bearing}deg`);
}
function redrawHeading() {
  const relativeHeading = headingUpEnabled ? 0 : currentHeading;
  if (currentMarker) currentMarker.setIcon(markerIcon(relativeHeading));
  applyMapBearing();
  if (currentPosition) updateLiveLocationCard(currentPosition);
}
function updateRealtimePosition(p) {
  const c = p.coords;
  currentPosition = { latitude:c.latitude, longitude:c.longitude, accuracy:c.accuracy, altitude:c.altitude, speed:c.speed, heading:c.heading, time:new Date(p.timestamp || Date.now()).toISOString() };
  if (Number.isFinite(c.heading) && c.heading >= 0 && (c.speed == null || c.speed > .4)) {
    lastGpsHeading = c.heading; currentHeading = c.heading;
  }
  const latlng = [c.latitude, c.longitude];
  if (!currentMarker) {
    currentMarker = L.marker(latlng, { icon:markerIcon(headingUpEnabled ? 0 : currentHeading), zIndexOffset:1000 })
      .bindPopup('Vị trí realtime').addTo(map);
  } else {
    currentMarker.setLatLng(latlng).setIcon(markerIcon(headingUpEnabled ? 0 : currentHeading));
  }
  if (!accuracyCircle) accuracyCircle = L.circle(latlng, { radius:c.accuracy || 0, weight:1, opacity:.65, fillOpacity:.08, className:'location-accuracy' }).addTo(map);
  else accuracyCircle.setLatLng(latlng).setRadius(c.accuracy || 0);
  currentMarker.setPopupContent(`Vị trí hiện tại<br>Độ chính xác ±${Math.round(c.accuracy || 0)} m${Number.isFinite(currentHeading) ? `<br>Hướng ${Math.round(currentHeading)}°` : ''}`);
  if (isFollowingLocation) map.panTo(latlng, { animate:true, duration:.35 });
  if (isTracking) {
    const previous = trackPoints[trackPoints.length - 1];
    const point = { lat:c.latitude, lng:c.longitude, accuracy:c.accuracy, altitude:c.altitude, speed:c.speed, heading:currentHeading, time:currentPosition.time };
    const moved = !previous || map.distance([previous.lat, previous.lng], latlng) >= 1.5 || (Date.now() - new Date(previous.time).getTime()) >= 5000;
    if (moved) { trackPoints.push(point); liveLine?.addLatLng(latlng); }
  }
  applyMapBearing();
  updateLiveLocationCard(currentPosition);
  status(isTracking ? `Đang ghi tracklog realtime: ${trackPoints.length} điểm • ±${Math.round(c.accuracy || 0)} m` : `Định vị realtime • ±${Math.round(c.accuracy || 0)} m`);
}
function locationError(e) {
  status(`Không thể định vị: ${e.message}`);
  const state = document.getElementById('liveLocationState'); if (state) state.textContent='Lỗi GPS';
}
async function enableOrientation() {
  if (orientationListening || !window.DeviceOrientationEvent) return;
  try {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== 'granted') return;
    }
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
    window.addEventListener('deviceorientation', onOrientation, true);
    orientationListening = true;
  } catch (_) {}
}
function onOrientation(e) {
  let heading = Number.isFinite(e.webkitCompassHeading) ? e.webkitCompassHeading : (Number.isFinite(e.alpha) ? (360 - e.alpha) % 360 : null);
  if (!Number.isFinite(heading)) return;
  if (lastGpsHeading == null || currentPosition?.speed == null || currentPosition.speed < .4) { currentHeading=heading; redrawHeading(); }
}
async function startLiveLocation({center=true}={}) {
  if (!navigator.geolocation) return status('Thiết bị không hỗ trợ định vị.');
  await enableOrientation();
  isFollowingLocation = true;
  if (locationWatchId === null) {
    status('Đang bật định vị realtime...');
    locationWatchId = navigator.geolocation.watchPosition(updateRealtimePosition, locationError, { enableHighAccuracy:true, maximumAge:500, timeout:20000 });
  } else if (currentPosition && center) map.setView([currentPosition.latitude,currentPosition.longitude], Math.max(map.getZoom(),17));
}
function locate() {
  isFollowingLocation = !isFollowingLocation || locationWatchId === null;
  startLiveLocation({center:true});
  if (currentPosition) map.setView([currentPosition.latitude,currentPosition.longitude],17);
  const btn=document.getElementById('locateBtn');
  btn?.classList.toggle('is-active',isFollowingLocation);
  btn?.setAttribute('aria-pressed',String(isFollowingLocation));
  status(isFollowingLocation?'Đang bám theo vị trí realtime.':'GPS vẫn hoạt động; đã tắt bám theo bản đồ.');
}
document.getElementById('locateBtn').onclick = locate;
document.getElementById('headingUpBtn').onclick = async () => {
  await enableOrientation();
  headingUpEnabled=!headingUpEnabled;
  const btn=document.getElementById('headingUpBtn');
  btn.classList.toggle('is-active',headingUpEnabled);
  btn.setAttribute('aria-pressed',String(headingUpEnabled));
  btn.querySelector('span').textContent=headingUpEnabled?'Đang xoay':'Hướng lên';
  redrawHeading();
  status(headingUpEnabled?'Bản đồ đang xoay theo hướng điện thoại.':'Đã khóa bản đồ về hướng Bắc.');
};
map.on('dragstart',()=>{if(isFollowingLocation){isFollowingLocation=false;document.getElementById('locateBtn')?.classList.remove('is-active');}});
document.getElementById('addWpBtn').onclick = () => {
  if (!currentPosition) { startLiveLocation(); status('Đang lấy vị trí realtime, hãy bấm Waypoint lại sau khi có tọa độ.'); return; }
  pendingMode='waypoint'; document.getElementById('modalTitle').textContent='Lưu waypoint'; document.getElementById('categoryWrap').style.display='grid'; modal.classList.remove('hidden');
};
document.getElementById('startTrackBtn').onclick = async () => {
  if (!navigator.geolocation) return status('Thiết bị không hỗ trợ GPS.');
  trackPoints=[]; if(liveLine)liveLine.remove(); liveLine=L.polyline([], {weight:5}).addTo(map);
  isTracking=true; await startLiveLocation({center:true});
  if(currentPosition) updateRealtimePosition({coords:{...currentPosition, latitude:currentPosition.latitude, longitude:currentPosition.longitude},timestamp:Date.now()});
  document.getElementById('startTrackBtn').disabled=true; document.getElementById('stopTrackBtn').disabled=false;
};
document.getElementById('stopTrackBtn').onclick = () => {
  isTracking=false;
  document.getElementById('startTrackBtn').disabled=false; document.getElementById('stopTrackBtn').disabled=true;
  updateLiveLocationCard(currentPosition || {accuracy:0});
  if(trackPoints.length<2)return status('Tracklog quá ngắn, chưa lưu. Định vị realtime vẫn tiếp tục hoạt động.');
  pendingMode='track'; document.getElementById('modalTitle').textContent='Lưu tracklog'; document.getElementById('categoryWrap').style.display='none'; modal.classList.remove('hidden');
};
document.getElementById('cancelModal').onclick=()=>modal.classList.add('hidden');
document.getElementById('saveModal').onclick=async()=>{
  const name=document.getElementById('itemName').value.trim()||undefined,description=document.getElementById('itemDescription').value.trim();
  const type=pendingMode==='waypoint'?'waypoint':'track';
  const payload=type==='waypoint'?{...currentPosition,name,description,category:document.getElementById('itemCategory').value}:{name,description,points:trackPoints};
  try{if(navigator.onLine)await api(type==='waypoint'?'/api/waypoints':'/api/tracks',{method:'POST',body:JSON.stringify(payload)});else await queueRecord(type,payload);modal.classList.add('hidden');document.getElementById('itemName').value='';document.getElementById('itemDescription').value='';status(navigator.onLine?'Đã lưu dữ liệu.':'Đã lưu trên thiết bị, sẽ tự đồng bộ khi có mạng.');await updateNetworkUI();await loadData();}
  catch(e){await queueRecord(type,payload);modal.classList.add('hidden');status('Mất kết nối: dữ liệu đã được lưu an toàn trên thiết bị.');await updateNetworkUI();await loadData();}
};

document.getElementById('reloadDataBtn').onclick=async()=>{status('Đang tải lại waypoint và tracklog...');try{await loadData();status('Đã cập nhật dữ liệu bản đồ.');}catch(e){status(e.message);}};
document.getElementById('reloadLayersBtn').onclick=async()=>{status('Đang tải lại các lớp bản đồ...');try{await loadLayers();status('Đã cập nhật lớp bản đồ.');document.querySelector('.layer-panel')?.setAttribute('open','');}catch(e){status(e.message);}};
document.getElementById('updateAppBtn').onclick=async()=>{
  const btn=document.getElementById('updateAppBtn');
  btn.disabled=true; status('Đang kiểm tra phiên bản HUFM mới...');
  try{
    if('serviceWorker' in navigator){
      const reg=await navigator.serviceWorker.getRegistration();
      await reg?.update();
      if(reg?.waiting) reg.waiting.postMessage({type:'SKIP_WAITING'});
      else reg?.active?.postMessage({type:'CLEAR_APP_CACHE'});
      await new Promise(r=>setTimeout(r,700));
    }
    status('Đã cập nhật tài nguyên ứng dụng. Đang tải lại...');
    location.reload();
  }catch(e){status(`Không thể cập nhật: ${e.message}`);btn.disabled=false;}
};
if('serviceWorker' in navigator){navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload());}

document.getElementById('layerUploadForm').addEventListener('submit', async event => {
  event.preventDefault();
  const fileInput = document.getElementById('layerFile');
  if (!fileInput.files.length) return status('Vui lòng chọn tệp bản đồ.');
  const form = new FormData(event.currentTarget);
  try {
    status(`Đang tải ${fileInput.files[0].name}...`);
    await api('/api/layers', { method: 'POST', body: form });
    event.currentTarget.reset();
    await loadLayers();
    status('Đã tải và hiển thị lớp bản đồ.');
  } catch (e) { status(e.message); }
});

Promise.all([loadData(), loadLayers()]).catch(e => status(e.message));


async function loadHueWards() {
  const select = document.getElementById('fireWard');
  try {
    const data = await api('/api/admin-units/hue');
    const wards = [...(data.wards || [])].sort((a,b) => String(a.ward_name || a.name || '').localeCompare(String(b.ward_name || b.name || ''), 'vi'));
    for (const ward of wards) {
      const option = document.createElement('option');
      option.value = ward.ward_code || ward.code || '';
      option.textContent = ward.ward_name || ward.name || option.value;
      select.appendChild(option);
    }
  } catch (e) {
    document.getElementById('fireStatus').textContent = e.message;
  }
}
function firePopup(properties = {}) {
  const title = properties.name || properties.title || properties.location || properties.address || 'Điểm cảnh báo cháy rừng';
  const level = properties.level || properties.risk_level || properties.warning_level || properties.cap_du_bao || '';
  const time = properties.time || properties.detected_at || properties.date || properties.created_at || '';
  return `<b>${esc(title)}</b>${level ? `<br>Mức cảnh báo: ${esc(level)}` : ''}${time ? `<br>Thời gian: ${esc(time)}` : ''}<br><small>Nguồn: v2.pcccr.vn</small>`;
}
async function loadFireAlerts() {
  const statusBox = document.getElementById('fireStatus');
  const wardCode = document.getElementById('fireWard').value;
  statusBox.textContent = 'Đang tải cảnh báo cháy rừng…';
  fireAlertLayer.clearLayers();
  try {
    const data = await api(`/api/fire-alerts${wardCode ? `?ward_code=${encodeURIComponent(wardCode)}` : ''}`);
    document.getElementById('openPcccrBtn').href = data.sourceUrl || 'https://v2.pcccr.vn/diem-chay';
    const geojson = data.geojson || { type:'FeatureCollection', features:[] };
    const rendered = L.geoJSON(geojson, {
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 8, weight: 3, color:'#fff', fillColor:'#e53935', fillOpacity:.95 }),
      style: { color:'#e53935', weight:3, fillColor:'#ff7043', fillOpacity:.3 },
      onEachFeature: (feature, layer) => layer.bindPopup(firePopup(feature.properties || {}))
    });
    rendered.eachLayer(layer => fireAlertLayer.addLayer(layer));
    const count = geojson.features?.length || 0;
    statusBox.textContent = data.configured
      ? `Đã cập nhật ${count} cảnh báo/điểm cháy lúc ${new Date(data.fetchedAt).toLocaleString('vi-VN')}.`
      : data.message;
    if (count && rendered.getBounds().isValid()) map.fitBounds(rendered.getBounds(), { padding:[30,30], maxZoom:15 });
  } catch (e) {
    statusBox.textContent = `${e.message} Hãy dùng nút “Mở bản đồ PCCCR” để xem nguồn chính thức.`;
  }
}
document.getElementById('refreshFireBtn').addEventListener('click', loadFireAlerts);
document.getElementById('fireWard').addEventListener('change', loadFireAlerts);
loadHueWards().then(loadFireAlerts);


function calcDistance(points=[]){let d=0;const R=6371000,rad=x=>x*Math.PI/180;for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],dp=rad(b.lat-a.lat),dl=rad(b.lng-a.lng);const q=Math.sin(dp/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dl/2)**2;d+=2*R*Math.atan2(Math.sqrt(q),Math.sqrt(1-q));}return Math.round(d)}
async function getPending(){return await OfflineDB.get('pendingRecords')||[]}
async function queueRecord(type,payload){const rows=await getPending();rows.push({clientId:`${window.APP_USER.id}-${Date.now()}-${crypto.randomUUID?.()||Math.random().toString(36).slice(2)}`,type,payload,createdAt:new Date().toISOString()});await OfflineDB.set('pendingRecords',rows)}
async function syncPending(){if(!navigator.onLine)return;const rows=await getPending();if(!rows.length){await updateNetworkUI();return;}status(`Đang đồng bộ ${rows.length} bản ghi...`);try{const out=await api('/api/sync',{method:'POST',body:JSON.stringify({records:rows})});const ok=new Set((out.results||[]).filter(x=>x.ok).map(x=>x.clientId));await OfflineDB.set('pendingRecords',rows.filter(x=>!ok.has(x.clientId)));status(`Đã đồng bộ ${ok.size}/${rows.length} bản ghi lên máy chủ.`);await loadData();}catch(e){status(`Chưa thể đồng bộ: ${e.message}`)}await updateNetworkUI()}
async function updateNetworkUI(){const pending=(await getPending()).length;document.getElementById('networkText').textContent=navigator.onLine?'Có kết nối':'Đang offline';document.getElementById('networkDot').className=navigator.onLine?'online':'offline';document.getElementById('pendingCount').textContent=`${pending} bản ghi chờ`;}
window.addEventListener('online',()=>{updateNetworkUI();syncPending()});window.addEventListener('offline',updateNetworkUI);document.getElementById('syncNowBtn').onclick=syncPending;
function lon2tile(lon,z){return Math.floor((lon+180)/360*Math.pow(2,z))}function lat2tile(lat,z){return Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*Math.pow(2,z))}
function tileUrls(bounds,minZ,maxZ,template){const urls=[];for(let z=minZ;z<=maxZ;z++){const x1=lon2tile(bounds.getWest(),z),x2=lon2tile(bounds.getEast(),z),y1=lat2tile(bounds.getNorth(),z),y2=lat2tile(bounds.getSouth(),z);for(let x=x1;x<=x2;x++)for(let y=y1;y<=y2;y++){const sub=['a','b','c'][(x+y)%3];urls.push(template.replace('{s}',sub).replace('{z}',z).replace('{x}',x).replace('{y}',y));}}return urls}
document.getElementById('downloadOfflineBtn').onclick=async()=>{const box=document.getElementById('offlineStatus');if(!('serviceWorker'in navigator)){box.textContent='Trình duyệt không hỗ trợ PWA offline.';return;}const [a,b]=document.getElementById('offlineZoom').value.split('-').map(Number);const urls=tileUrls(map.getBounds(),a,b,appConfig.offlineTileUrl);if(urls.length>appConfig.offlineTileMax){box.textContent=`Vùng quá lớn (${urls.length} tile). Hãy phóng to hoặc chọn mức zoom thấp hơn; giới hạn ${appConfig.offlineTileMax}.`;return;}box.textContent=`Đang tải ${urls.length} tile... Không đóng ứng dụng.`;const reg=await navigator.serviceWorker.ready;reg.active.postMessage({type:'CACHE_TILES',urls});};
document.getElementById('clearOfflineBtn').onclick=async()=>{if(!confirm('Xóa toàn bộ tile bản đồ đã tải offline?'))return;const reg=await navigator.serviceWorker.ready;reg.active.postMessage({type:'CLEAR_TILES'});};
navigator.serviceWorker?.addEventListener('message',e=>{const d=e.data||{},box=document.getElementById('offlineStatus');if(d.type==='CACHE_PROGRESS')box.textContent=`Đã tải ${d.done}/${d.total} tile (${d.failed} lỗi)`;if(d.type==='CACHE_DONE')box.textContent=`Hoàn tất: ${d.done-d.failed}/${d.total} tile sẵn sàng offline.`;if(d.type==='TILES_CLEARED')box.textContent='Đã xóa bản đồ offline.';});
(async()=>{try{appConfig=await api('/api/app-config');topoLayer.setUrl(appConfig.topoTileUrl);}catch(_){ }await updateNetworkUI();if(navigator.onLine)syncPending();})();
