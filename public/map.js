if (typeof window.L === 'undefined') {
  const mapEl = document.getElementById('map');
  if (mapEl) mapEl.innerHTML = '<div class="map-load-error"><b>Không tải được thư viện bản đồ.</b><br>Hãy bấm “Cập nhật app”, tải lại trang hoặc kiểm tra kết nối.</div>';
  throw new Error('Leaflet chưa được tải');
}
const map = L.map('map', { zoomControl:true, preferCanvas:true, zoomAnimation:true, fadeAnimation:true, markerZoomAnimation:true }).setView([16.4637, 107.5909], 11);
const mapLoading=document.getElementById('mapLoading');
const hideMapLoading=()=>mapLoading?.classList.add('is-hidden');
const showMapLoading=(message='Đang tải bản đồ…')=>{if(mapLoading){mapLoading.querySelector('b').textContent=message;mapLoading.classList.remove('is-hidden');}};
window.addEventListener('load', () => setTimeout(() => map.invalidateSize(true), 180));
window.addEventListener('resize', () => map.invalidateSize(false));
if('ResizeObserver' in window){new ResizeObserver(()=>map.invalidateSize(false)).observe(document.getElementById('map'));}
const commonTileOptions={updateWhenIdle:false,keepBuffer:4};
const streetLayer=L.tileLayer('/api/base-tiles/osm/{z}/{x}/{y}.png',{
  ...commonTileOptions,maxZoom:19,attribution:'&copy; OpenStreetMap contributors'
});
const topoLayer=L.tileLayer('/api/base-tiles/topo/{z}/{x}/{y}.png',{
  ...commonTileOptions,maxZoom:17,attribution:'Bản đồ địa hình &copy; OpenTopoMap; dữ liệu &copy; OpenStreetMap contributors'
});
const topoDirectFallback=L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',{
  updateWhenIdle:false,keepBuffer:4,maxZoom:17,subdomains:'abc',
  attribution:'Bản đồ địa hình &copy; OpenTopoMap; dữ liệu &copy; OpenStreetMap contributors'
});
let usingTopoFallback=false;
const googleHybridLayer=L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',{
  ...commonTileOptions,maxZoom:22,subdomains:[],attribution:'Bản đồ &copy; Google'
});
const satelliteFallbackLayer=L.tileLayer('/api/base-tiles/satellite/{z}/{x}/{y}.jpg',{
  ...commonTileOptions,maxZoom:19,attribution:'Ảnh vệ tinh dự phòng &copy; Esri'
});
const labelsLayer=L.tileLayer('/api/base-tiles/labels/{z}/{x}/{y}.png',{
  ...commonTileOptions,maxZoom:19,pane:'overlayPane',attribution:'Nhãn địa danh dựa trên dữ liệu &copy; OpenStreetMap contributors; tiles &copy; CARTO'
});
streetLayer.addTo(map);
let streetTileErrors=0,topoTileErrors=0,googleTileErrors=0;
let usingSatelliteFallback=false;
function attachTileStatus(layer,label,errorCounter){
  layer.on('loading',()=>showMapLoading(`Đang tải ${label}…`));
  layer.on('tileload',()=>{if(errorCounter==='street')streetTileErrors=0;if(errorCounter==='topo')topoTileErrors=0;if(errorCounter==='google')googleTileErrors=0;hideMapLoading();});
  layer.on('load',()=>{hideMapLoading();status(`${label} đã sẵn sàng.`);});
  layer.on('tileerror',()=>{
    if(errorCounter==='street')streetTileErrors++;
    if(errorCounter==='topo'){
      topoTileErrors++;
      if(topoTileErrors>=4 && map.hasLayer(topoLayer) && !usingTopoFallback){
        usingTopoFallback=true;
        map.removeLayer(topoLayer);
        topoDirectFallback.addTo(map);
        status('Nguồn địa hình qua máy chủ chưa phản hồi. Đang chuyển sang nguồn OpenTopoMap dự phòng…');
      }
    }
    if(errorCounter==='google'){
      googleTileErrors++;
      if(googleTileErrors>=4 && map.hasLayer(googleHybridLayer) && !usingSatelliteFallback){
        usingSatelliteFallback=true;
        map.removeLayer(googleHybridLayer);
        satelliteFallbackLayer.addTo(map);
        if(!map.hasLayer(labelsLayer)) labelsLayer.addTo(map);
        status('Nguồn Google Hybrid chưa phản hồi. Đang chuyển sang vệ tinh dự phòng kèm nhãn OpenStreetMap…');
      }
    }
  });
}
attachTileStatus(streetLayer,'bản đồ đường phố','street');
attachTileStatus(topoLayer,'bản đồ địa hình','topo');
attachTileStatus(topoDirectFallback,'bản đồ địa hình dự phòng','topoFallback');
attachTileStatus(googleHybridLayer,'Google Satellite Hybrid','google');
attachTileStatus(satelliteFallbackLayer,'bản đồ vệ tinh dự phòng','satelliteFallback');
setTimeout(()=>{map.invalidateSize(true);if(document.querySelector('.leaflet-tile-loaded'))hideMapLoading();},900);

const waypointLayer = L.layerGroup().addTo(map);
const trackLayer = L.layerGroup().addTo(map);
const fireAlertLayer = L.layerGroup().addTo(map);
const fireRiskZoneLayer = L.layerGroup().addTo(map);
const vietnamNationalLayer = L.layerGroup().addTo(map);
const uploadedLayers = new Map();
const baseLayers={
  'Đường phố (OpenStreetMap)':streetLayer,
  'Địa hình & bình độ':topoLayer,
  'Google vệ tinh + nhãn':googleHybridLayer,
  'Vệ tinh dự phòng + nhãn OSM':satelliteFallbackLayer
};
const overlayLayers={Waypoint:waypointLayer,Tracklog:trackLayer,'Cảnh báo cháy rừng':fireAlertLayer,'Vùng nguy cơ cháy':fireRiskZoneLayer,'Bản đồ Việt Nam (Hoàng Sa, Trường Sa)':vietnamNationalLayer,'Nhãn chuẩn OpenStreetMap':labelsLayer};
const layerControl = L.control.layers(
  baseLayers,
  overlayLayers,
  { collapsed: true, position: 'bottomright' }
).addTo(map);
map.on('baselayerchange',event=>{
  if(event.layer===googleHybridLayer){
    usingSatelliteFallback=false;
    googleTileErrors=0;
    if(map.hasLayer(labelsLayer))map.removeLayer(labelsLayer);
  } else if(event.layer===satelliteFallbackLayer){
    if(!map.hasLayer(labelsLayer))labelsLayer.addTo(map);
  } else if(map.hasLayer(labelsLayer)){
    map.removeLayer(labelsLayer);
  }
  if(event.layer===topoLayer){
    usingTopoFallback=false;
    topoTileErrors=0;
  }
  setTimeout(()=>map.invalidateSize(false),80);
});


function vietnamLabelIcon(title, subtitle='') {
  return L.divIcon({
    className: 'vn-national-label-wrap',
    html: `<div class="vn-national-label"><b>${esc(title)}</b>${subtitle ? `<small>${esc(subtitle)}</small>` : ''}</div>`,
    iconSize: null,
    iconAnchor: [0, 0]
  });
}
async function loadVietnamNationalReference() {
  try {
    const response = await fetch('/data/vietnam-national-reference.geojson', { cache: 'no-store' });
    if (!response.ok) throw new Error('Không tải được dữ liệu bản đồ Việt Nam');
    const data = await response.json();
    vietnamNationalLayer.clearLayers();
    const rendered = L.geoJSON(data, {
      style: feature => feature?.properties?.kind === 'archipelago'
        ? { color:'#d71920', weight:2, dashArray:'7 5', fillColor:'#d71920', fillOpacity:0.06 }
        : { color:'#d71920', weight:2, fillColor:'#ffdf00', fillOpacity:0.035 },
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        layer.bindPopup(`<b>${esc(p.name || 'Việt Nam')}</b>${p.subtitle ? `<br>${esc(p.subtitle)}` : ''}<br><small>${esc(p.note || '')}</small>`);
        if (p.kind === 'archipelago' && layer.getBounds) {
          const center = layer.getBounds().getCenter();
          L.marker(center, { icon: vietnamLabelIcon(p.name, p.subtitle), interactive:false, keyboard:false }).addTo(vietnamNationalLayer);
        }
      }
    });
    rendered.eachLayer(layer => vietnamNationalLayer.addLayer(layer));
  } catch (error) {
    console.warn('Không tải được lớp bản đồ Việt Nam:', error);
    status('Không tải được lớp Việt Nam; các lớp nền vẫn hoạt động.');
  }
}
function showVietnamOverview() {
  if (!map.hasLayer(vietnamNationalLayer)) vietnamNationalLayer.addTo(map);
  map.fitBounds([[6.0, 102.0], [23.8, 117.8]], { padding:[18,18] });
  status('Đang hiển thị toàn cảnh Việt Nam, Hoàng Sa và Trường Sa.');
}
window.showVietnamOverview = showVietnamOverview;

// Bảng lớp thu gọn ở góc dưới bên phải: chạm để mở danh sách có thanh cuộn.
const layerControlEl = layerControl.getContainer();
layerControlEl.classList.add('hufm-compact-layer-control');
const layerToggleEl = layerControlEl.querySelector('.leaflet-control-layers-toggle');
if (layerToggleEl) {
  layerToggleEl.title = 'Mở danh sách lớp bản đồ';
  layerToggleEl.setAttribute('aria-label', 'Mở danh sách lớp bản đồ');
}
layerControlEl.addEventListener('mouseenter', () => {}, { passive: true });
map.on('click', () => {
  if (layerControlEl.classList.contains('leaflet-control-layers-expanded')) {
    layerControl.collapse();
  }
});
loadVietnamNationalReference();
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
const visibleDataRecords = new Map();
const statusEl = document.getElementById('status');
const modal = document.getElementById('modal');
// Mở/đóng bảng Công cụ hoạt động giống nhau trong Safari và PWA cài trên màn hình chính.
const mapToolsPanel = document.getElementById('mapTools');
const panelToggleButtons = [document.getElementById('panelToggle'), document.getElementById('floatingPanelToggle')].filter(Boolean);
const panelCloseButton = document.getElementById('panelClose');
const toolsBackdrop = document.getElementById('toolsBackdrop');
function setToolsPanel(open) {
  if (!mapToolsPanel) return;
  mapToolsPanel.classList.toggle('is-collapsed', !open);
  toolsBackdrop?.classList.toggle('is-hidden', !open);
  toolsBackdrop?.setAttribute('aria-hidden', String(!open));
  panelToggleButtons.forEach(button => button.setAttribute('aria-expanded', String(open)));
  document.body.classList.toggle('tools-panel-open', open && window.matchMedia('(max-width: 900px)').matches);
  setTimeout(() => map?.invalidateSize(false), 300);
}
panelToggleButtons.forEach(button => button.addEventListener('click', () => setToolsPanel(mapToolsPanel?.classList.contains('is-collapsed'))));
panelCloseButton?.addEventListener('click', () => setToolsPanel(false));
toolsBackdrop?.addEventListener('click', () => setToolsPanel(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape') setToolsPanel(false); });
if (window.matchMedia('(max-width: 900px)').matches) setToolsPanel(false);
else toolsBackdrop?.classList.add('is-hidden');
window.addEventListener('resize', () => {
  if (window.matchMedia('(min-width: 901px)').matches) {
    toolsBackdrop?.classList.add('is-hidden');
    document.body.classList.remove('tools-panel-open');
  }
  setTimeout(() => map?.invalidateSize(false), 120);
});


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
  visibleDataRecords.clear();
  const bounds = [];
  data.waypoints.forEach(w => {
    visibleDataRecords.set(`waypoint:${w.id}`, w);
    L.marker([w.latitude, w.longitude])
      .bindPopup(`<b>${esc(w.name)}</b><br>${esc(w.category)}<br>${esc(w.description || '')}<br><small>${esc(w.User?.name || '')}</small>`)
      .addTo(waypointLayer);
    bounds.push([w.latitude, w.longitude]);
    const actions = w.offline
      ? '<span class="offline-badge">Chờ đồng bộ</span>'
      : `<button type="button" data-data-action="edit" data-data-type="waypoint" data-data-id="${esc(w.id)}">Chỉnh sửa</button><button type="button" class="danger" data-data-action="delete" data-data-type="waypoint" data-data-id="${esc(w.id)}">Xóa</button>`;
    list.insertAdjacentHTML('beforeend', `<div class="data-item" data-record-key="waypoint:${esc(w.id)}"><div class="data-item-title"><span class="wp-dot"></span><b>${esc(w.name)}</b></div><small>${Number(w.latitude).toFixed(5)}, ${Number(w.longitude).toFixed(5)}</small><div class="data-actions"><button type="button" data-data-action="view" data-data-type="waypoint" data-data-id="${esc(w.id)}">Xem</button>${actions}</div></div>`);
  });
  data.tracks.forEach(t => {
    visibleDataRecords.set(`track:${t.id}`, t);
    const pts = (t.points || []).map(p => [p.lat, p.lng]);
    if (pts.length) {
      L.polyline(pts, { weight: 4 })
        .bindPopup(`<b>${esc(t.name)}</b><br>${Math.round(t.distanceMeters || 0)} m<br><small>${esc(t.User?.name || '')}</small>`)
        .addTo(trackLayer);
      bounds.push(...pts);
    }
    const actions = t.offline
      ? '<span class="offline-badge">Chờ đồng bộ</span>'
      : `<button type="button" data-data-action="edit" data-data-type="track" data-data-id="${esc(t.id)}">Chỉnh sửa</button><a class="mini-link" href="/api/tracks/${t.id}/export/geojson">GeoJSON + WP</a><a class="mini-link" href="/api/tracks/${t.id}/export/gpx">GPX + WP</a><a class="mini-link" href="/api/tracks/${t.id}/export/kml">KML + WP</a><a class="mini-link" href="/reports/track/${t.id}">Phiếu tuần tra</a><button type="button" class="danger" data-data-action="delete" data-data-type="track" data-data-id="${esc(t.id)}">Xóa</button>`;
    list.insertAdjacentHTML('beforeend', `<div class="data-item" data-record-key="track:${esc(t.id)}"><div class="data-item-title"><span class="track-dot"></span><b>${esc(t.name)}</b></div><small>${Math.round(t.distanceMeters || 0)} m • ${(t.points || []).length} điểm</small><div class="data-actions"><button type="button" data-data-action="view" data-data-type="track" data-data-id="${esc(t.id)}">Xem</button>${actions}</div></div>`);
  });
  const c1=document.getElementById('compareTrack1'),c2=document.getElementById('compareTrack2');
  if(c1&&c2){const old1=c1.value,old2=c2.value;const options='<option value="">Chọn tracklog</option>'+data.tracks.filter(t=>!t.offline).map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');c1.innerHTML=options;c2.innerHTML=options;c1.value=old1;c2.value=old2;}
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
    list.insertAdjacentHTML('beforeend', `<div class="data-item" data-layer-id="${meta.id}"><span class="layer-type">${esc(meta.layerType)}</span> <b>${esc(meta.name)}</b><br><small>${formatBytes(meta.sizeBytes)} • ${esc(count)} • ${esc(meta.User?.name || '')}</small><div class="layer-row-actions"><button type="button" data-layer-action="zoom" data-layer-id="${meta.id}">Xem</button><button type="button" data-layer-action="toggle" data-layer-id="${meta.id}">Bật/tắt</button><button type="button" class="danger" data-layer-action="delete" data-layer-id="${meta.id}" data-layer-name="${esc(meta.name)}">Xóa</button></div></div>`);
  }
  if (!layers.length) list.innerHTML = '<div class="layer-empty">Chưa có lớp bản đồ được tải lên.</div>';
}

window.focusPoint = (a, b) => map.setView([a, b], 17);
window.focusTrack = pts => { if (Array.isArray(pts) && pts.length) map.fitBounds(pts, { padding: [30, 30] }); };

function openDataEdit(type, id) {
  const item = visibleDataRecords.get(`${type}:${id}`);
  if (!item) return showToast('Không tìm thấy dữ liệu để chỉnh sửa.');
  const editModal = document.getElementById('dataEditModal');
  document.getElementById('dataEditType').value = type;
  document.getElementById('dataEditId').value = id;
  document.getElementById('dataEditName').value = item.name || '';
  document.getElementById('dataEditDescription').value = item.description || '';
  const categoryWrap = document.getElementById('dataEditCategoryWrap');
  categoryWrap.hidden = type !== 'waypoint';
  if (type === 'waypoint') document.getElementById('dataEditCategory').value = item.category || 'Khác';
  document.getElementById('dataEditTitle').textContent = type === 'waypoint' ? 'Chỉnh sửa waypoint' : 'Chỉnh sửa tracklog';
  editModal.classList.remove('hidden');
  document.body.classList.add('dialog-open');
  setTimeout(() => document.getElementById('dataEditName').focus(), 50);
}
function closeDataEdit() {
  document.getElementById('dataEditModal')?.classList.add('hidden');
  document.body.classList.remove('dialog-open');
}
document.getElementById('dataEditCancel')?.addEventListener('click', closeDataEdit);
document.getElementById('dataEditModal')?.addEventListener('click', event => { if (event.target.id === 'dataEditModal') closeDataEdit(); });
document.getElementById('dataEditSave')?.addEventListener('click', async () => {
  const saveButton = document.getElementById('dataEditSave');
  const type = document.getElementById('dataEditType').value;
  const id = document.getElementById('dataEditId').value;
  const name = document.getElementById('dataEditName').value.trim();
  if (!name) return showToast('Vui lòng nhập tên dữ liệu.');
  const payload = { name, description: document.getElementById('dataEditDescription').value.trim() };
  if (type === 'waypoint') payload.category = document.getElementById('dataEditCategory').value;
  saveButton.disabled = true;
  saveButton.textContent = 'Đang lưu…';
  try {
    await api(type === 'waypoint' ? `/api/waypoints/${id}` : `/api/tracks/${id}`, { method:'PUT', body:JSON.stringify(payload), cache:'no-store' });
    closeDataEdit();
    await loadData();
    status('Đã cập nhật dữ liệu thành công.');
    showToast('✓ Đã cập nhật dữ liệu thành công');
  } catch (error) {
    showToast(error.message || 'Không thể cập nhật dữ liệu.');
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Lưu thay đổi';
  }
});

async function deleteDataRecord(type, id, itemName = '') {
  const label = type === 'waypoint' ? 'waypoint' : 'tracklog';
  const approved = await askDeleteRecord(`Xóa ${label}?`, itemName, `${label[0].toUpperCase()+label.slice(1)} sẽ bị xóa khỏi hệ thống và không thể khôi phục.`);
  if (!approved) return;
  try {
    try {
      await api(type === 'waypoint' ? `/api/waypoints/${id}` : `/api/tracks/${id}`, { method:'DELETE', cache:'no-store' });
    } catch (firstError) {
      await api(type === 'waypoint' ? `/api/waypoints/${id}/delete` : `/api/tracks/${id}/delete`, { method:'POST', body:JSON.stringify({}), cache:'no-store' });
    }
    await loadData();
    status(`Đã xóa ${label} thành công.`);
    showToast(`✓ Đã xóa ${label} thành công`);
  } catch (error) {
    showToast(error.message || `Không thể xóa ${label}.`);
  }
}

function askDeleteRecord(title, name, message) {
  const dialog = document.getElementById('confirmDeleteModal');
  const titleEl = document.getElementById('confirmDeleteTitle');
  const messageEl = document.getElementById('confirmDeleteMessage');
  const nameEl = document.getElementById('confirmDeleteLayerName');
  const accept = document.getElementById('confirmDeleteAccept');
  const cancel = document.getElementById('confirmDeleteCancel');
  if (!dialog || !accept || !cancel) return Promise.resolve(window.confirm(`${title}
${name}`));
  titleEl.textContent = title;
  messageEl.textContent = message;
  nameEl.textContent = name || '';
  accept.textContent = 'Xóa';
  dialog.classList.remove('hidden');
  document.body.classList.add('dialog-open');
  return new Promise(resolve => {
    const finish = value => {
      dialog.classList.add('hidden');
      document.body.classList.remove('dialog-open');
      accept.removeEventListener('click', yes);
      cancel.removeEventListener('click', no);
      dialog.querySelector('[data-confirm-cancel]')?.removeEventListener('click', no);
      resolve(value);
    };
    const yes = () => finish(true);
    const no = () => finish(false);
    accept.addEventListener('click', yes, { once:true });
    cancel.addEventListener('click', no, { once:true });
    dialog.querySelector('[data-confirm-cancel]')?.addEventListener('click', no, { once:true });
  });
}

const dataListElement = document.getElementById('dataList');
dataListElement?.addEventListener('click', async event => {
  const button = event.target.closest('[data-data-action]');
  if (!button || !dataListElement.contains(button)) return;
  event.preventDefault();
  const type = button.dataset.dataType;
  const id = button.dataset.dataId;
  const item = visibleDataRecords.get(`${type}:${id}`);
  if (!item) return showToast('Dữ liệu không còn tồn tại hoặc chưa được tải lại.');
  if (button.dataset.dataAction === 'view') {
    if (type === 'waypoint') return window.focusPoint(Number(item.latitude), Number(item.longitude));
    return window.focusTrack((item.points || []).map(p => [p.lat, p.lng]));
  }
  if (button.dataset.dataAction === 'edit') return openDataEdit(type, id);
  if (button.dataset.dataAction === 'delete') return deleteDataRecord(type, id, item.name || '');
});
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

// Dùng event delegation thay cho onclick nội tuyến. Cách này hoạt động ổn định
// với tên lớp có dấu, dấu nháy và trong Safari/PWA.
const layerListElement = document.getElementById('layerList');
layerListElement?.addEventListener('click', async event => {
  const button = event.target.closest('button[data-layer-action]');
  if (!button || !layerListElement.contains(button)) return;
  event.preventDefault();
  event.stopPropagation();
  const id = Number(button.dataset.layerId);
  if (!Number.isInteger(id) || id <= 0) {
    showToast('Không xác định được lớp bản đồ.');
    return;
  }
  const action = button.dataset.layerAction;
  if (action === 'zoom') return window.zoomLayer(id);
  if (action === 'toggle') return window.toggleLayer(id);
  if (action === 'delete') {
    await window.deleteLayer(id, button, button.dataset.layerName || '');
  }
});
function askDeleteLayer(layerName = '') {
  const modal = document.getElementById('confirmDeleteModal');
  const titleBox = document.getElementById('confirmDeleteTitle');
  const messageBox = document.getElementById('confirmDeleteMessage');
  const nameBox = document.getElementById('confirmDeleteLayerName');
  const accept = document.getElementById('confirmDeleteAccept');
  const cancel = document.getElementById('confirmDeleteCancel');
  if (titleBox) titleBox.textContent = 'Xóa lớp bản đồ?';
  if (messageBox) messageBox.textContent = 'Lớp bản đồ sẽ bị xóa khỏi hệ thống và không thể khôi phục.';
  if (accept) accept.textContent = 'Xóa lớp';
  if (!modal || !accept || !cancel) return Promise.resolve(confirm('Bạn có chắc muốn xóa lớp bản đồ này? Thao tác không thể hoàn tác.'));
  nameBox.textContent = layerName ? `Lớp: ${layerName}` : '';
  modal.classList.remove('hidden');
  document.body.classList.add('dialog-open');
  return new Promise(resolve => {
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      modal.classList.add('hidden');
      document.body.classList.remove('dialog-open');
      accept.removeEventListener('click', onAccept);
      cancel.removeEventListener('click', onCancel);
      modal.querySelector('[data-confirm-cancel]')?.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onAccept = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = event => {
      if (event.key === 'Escape') finish(false);
      if (event.key === 'Enter') finish(true);
    };
    accept.addEventListener('click', onAccept);
    cancel.addEventListener('click', onCancel);
    modal.querySelector('[data-confirm-cancel]')?.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    setTimeout(() => accept.focus(), 30);
  });
}

window.deleteLayer = async (id, button, layerName = '') => {
  const approved = await askDeleteLayer(layerName);
  if (!approved) {
    showToast('Đã hủy xóa lớp bản đồ');
    return;
  }
  const originalText = button?.textContent || 'Xóa';
  if (button) { button.disabled = true; button.textContent = 'Đang xóa…'; }
  try {
    let result;
    try {
      result = await api(`/api/layers/${id}`, { method:'DELETE', cache:'no-store' });
    } catch (deleteError) {
      // Một số WebView/Safari hoặc proxy có thể chặn DELETE; thử endpoint POST dự phòng.
      result = await api(`/api/layers/${id}/delete`, { method:'POST', body: JSON.stringify({}), cache:'no-store' });
    }
    removeUploadedLayer(Number(id));
    document.querySelector(`[data-layer-id="${Number(id)}"]`)?.remove();
    await loadLayers();
    map.invalidateSize(true);
    status(result?.message || 'Đã xóa lớp bản đồ thành công và tự động cập nhật lại.');
    showToast('✓ Đã xóa lớp bản đồ thành công');
  } catch(error) {
    console.error('Không thể xóa lớp bản đồ:', error);
    status(`Không thể xóa lớp: ${error.message}`);
    showToast(error.message || 'Xóa lớp chưa thành công');
  } finally {
    if (button?.isConnected) { button.disabled = false; button.textContent = originalText; }
  }
};

function updateLiveLocationCard(position) {
  const state = document.getElementById('liveLocationState');
  const detail = document.getElementById('liveLocationDetail');
  if (!state || !detail) return;
  const headingText = Number.isFinite(currentHeading) ? ` • hướng ${Math.round(currentHeading)}°` : '';
  state.textContent = isTracking ? 'Đang ghi tracklog realtime' : 'Định vị realtime đang bật';
  const quality=gpsQuality(Number(position.accuracy)); detail.textContent = `GPS ${quality.label} • ±${Math.round(position.accuracy || 0)} m${headingText} • ${new Date().toLocaleTimeString('vi-VN')}`; detail.className=quality.className;
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
let lastGoodPosition=null;
function gpsQuality(accuracy){if(!Number.isFinite(accuracy))return {label:'Không rõ',className:'gps-unknown'};if(accuracy<=10)return {label:'Rất tốt',className:'gps-excellent'};if(accuracy<=25)return {label:'Tốt',className:'gps-good'};if(accuracy<=50)return {label:'Trung bình',className:'gps-medium'};return {label:'Yếu',className:'gps-poor'};}
function updateRealtimePosition(p) {
  const c = p.coords;
  if(lastGoodPosition){const jump=map.distance([lastGoodPosition.latitude,lastGoodPosition.longitude],[c.latitude,c.longitude]);const elapsed=Math.max(1,(p.timestamp-lastGoodPosition.timestamp)/1000);if(jump>500&&elapsed<10&&(!Number.isFinite(c.accuracy)||c.accuracy>40)){status('Đã bỏ qua một điểm GPS nhảy bất thường.');return;}}
  lastGoodPosition={latitude:c.latitude,longitude:c.longitude,timestamp:p.timestamp||Date.now()};
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
  const messages = {
    1: 'Bạn chưa cấp quyền vị trí. Hãy bật Vị trí chính xác và cho phép HUFM truy cập vị trí.',
    2: 'Thiết bị chưa xác định được vị trí. Hãy ra khu vực thoáng và bật GPS.',
    3: 'GPS phản hồi quá chậm. Hãy thử lại hoặc tắt/bật dịch vụ vị trí.'
  };
  const message = messages[e.code] || e.message || 'Không thể xác định vị trí.';
  status(message);
  const state = document.getElementById('liveLocationState'); if (state) state.textContent='Lỗi GPS';
  const detail = document.getElementById('liveLocationDetail'); if (detail) detail.textContent=message;
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

function showToast(message){const toast=document.getElementById('appToast');if(!toast)return;toast.textContent=message;toast.classList.add('show');clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>toast.classList.remove('show'),2200);}
document.getElementById('reloadLayersBtn').onclick=async()=>{status('Đang tải lại các lớp bản đồ...');try{await loadLayers();map.invalidateSize(true);status('Đã cập nhật lớp bản đồ.');showToast('Đã cập nhật lớp bản đồ');}catch(e){status(e.message);}};
document.getElementById('updateAppBtn').onclick=async()=>{
  const btn=document.getElementById('updateAppBtn');
  btn.disabled=true;btn.classList.add('is-spinning');status('Đang cập nhật dữ liệu và bản đồ...');showMapLoading('Đang cập nhật bản đồ…');
  try{
    await Promise.allSettled([loadData(),loadLayers(),loadFireWeather(false),loadFireAlerts()]);
    streetTileErrors=0;topoTileErrors=0;googleTileErrors=0;
    if(!map.hasLayer(streetLayer)&&!map.hasLayer(topoLayer)&&!map.hasLayer(googleHybridLayer)&&!map.hasLayer(satelliteFallbackLayer))streetLayer.addTo(map);
    if(map.hasLayer(streetLayer))streetLayer.redraw();
    if(map.hasLayer(topoLayer))topoLayer.redraw();
    if(map.hasLayer(topoDirectFallback))topoDirectFallback.redraw();
    if(map.hasLayer(googleHybridLayer))googleHybridLayer.redraw();
    if(map.hasLayer(satelliteFallbackLayer))satelliteFallbackLayer.redraw();
    if(map.hasLayer(labelsLayer))labelsLayer.redraw();
    map.invalidateSize(true);
    if('serviceWorker' in navigator){
      const reg=await navigator.serviceWorker.getRegistration();
      await reg?.update();
      reg?.active?.postMessage({type:'CLEAR_APP_CACHE'});
    }
    await new Promise(r=>setTimeout(r,550));
    hideMapLoading();status('Đã cập nhật lại dữ liệu và bản đồ.');showToast('Đã cập nhật lại');
  }catch(e){hideMapLoading();status(`Không thể cập nhật: ${e.message}`);showToast('Cập nhật chưa thành công');}
  finally{btn.disabled=false;btn.classList.remove('is-spinning');}
};

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



const DEFAULT_WEATHER_COORDS = { latitude:16.4637, longitude:107.5909 };
let weatherCoords = { ...DEFAULT_WEATHER_COORDS };
const WEATHER_STORAGE_KEY = 'hufm:last-fire-weather';
function validWeatherCoords(coords){
  const latitude=Number(coords?.latitude), longitude=Number(coords?.longitude);
  return Number.isFinite(latitude)&&Number.isFinite(longitude)&&Math.abs(latitude)<=90&&Math.abs(longitude)<=180;
}
function resetWeatherCoords(){
  weatherCoords={...DEFAULT_WEATHER_COORDS};
  const label=document.getElementById('weatherLocation');
  if(label) label.textContent='Trung tâm thành phố Huế';
}
function saveWeatherSnapshot(data){try{localStorage.setItem(WEATHER_STORAGE_KEY,JSON.stringify({savedAt:Date.now(),data}));}catch{}}
function loadWeatherSnapshot(){try{return JSON.parse(localStorage.getItem(WEATHER_STORAGE_KEY)||'null');}catch{return null;}}
function fmtNumber(value, digits=0){const n=Number(value);return Number.isFinite(n)?n.toLocaleString('vi-VN',{maximumFractionDigits:digits}):'—'}
function riskAction(level){
  if(level>=5)return 'Tạm dừng hoạt động dùng lửa; bố trí trực, phương tiện và kiểm tra điểm nóng liên tục.';
  if(level===4)return 'Hạn chế tuyệt đối nguồn lửa; tăng tuần tra tại khu vực rừng dễ cháy và chuẩn bị lực lượng.';
  if(level===3)return 'Tăng cảnh giác, kiểm tra vật liệu cháy và nhắc nhở người dân không dùng lửa gần rừng.';
  if(level===2)return 'Duy trì theo dõi thời tiết và kiểm soát nguồn lửa khi vào rừng.';
  return 'Nguy cơ khí tượng thấp; vẫn tuân thủ quy định phòng cháy chữa cháy rừng.';
}
async function loadFireWeather(useGps=false){
  const hero=document.getElementById('weatherRiskHero'), now=document.getElementById('weatherNow'), forecast=document.getElementById('weatherForecast'), advice=document.getElementById('weatherAdvice');
  if(useGps){
    if(!currentPosition){status('Chưa có vị trí GPS. Hãy bấm Định vị trước.');return;}
    weatherCoords={latitude:Number(currentPosition.latitude),longitude:Number(currentPosition.longitude)};
    document.getElementById('weatherLocation').textContent=`Vị trí hiện tại ${weatherCoords.latitude.toFixed(4)}, ${weatherCoords.longitude.toFixed(4)}`;
  }
  if(!validWeatherCoords(weatherCoords)){
    resetWeatherCoords();
    status('Tọa độ thời tiết đã được tự khôi phục về trung tâm thành phố Huế.');
  }
  hero.innerHTML='<b>Đang phân tích thời tiết và nguy cơ…</b>';
  const renderWeather=(data,{stale=false}={})=>{
    const today=data.forecast?.[0], current=data.current||{};
    if(!today)throw new Error('Nguồn thời tiết chưa có dữ liệu dự báo.');
    hero.style.setProperty('--risk-color',today.risk.color); hero.innerHTML=`<span class="risk-level">${esc(today.risk.label)}</span><strong>${today.risk.score}/100</strong>${stale?'<small>Dữ liệu gần nhất</small>':''}`;
    fireRiskZoneLayer.clearLayers(); const radius=[0,2500,5000,8500,12000,16000][Math.max(1,Math.min(5,today.risk.level))]; L.circle([data.latitude,data.longitude],{radius,color:today.risk.color,weight:2,fillColor:today.risk.color,fillOpacity:.12,dashArray:'8 5'}).bindPopup(`<b>${esc(today.risk.label)}</b><br>Điểm nguy cơ ${today.risk.score}/100<br><small>Vùng minh họa từ dữ liệu thời tiết, không phải ranh giới cảnh báo chính thức.</small>`).addTo(fireRiskZoneLayer);
    now.innerHTML=`<div><b>${fmtNumber(current.temperature_2m,1)}°C</b><small>Nhiệt độ</small></div><div><b>${fmtNumber(current.relative_humidity_2m)}%</b><small>Độ ẩm</small></div><div><b>${fmtNumber(current.wind_speed_10m,1)} km/h</b><small>Gió</small></div><div><b>${fmtNumber(data.recentRain24h,1)} mm</b><small>Mưa 24 giờ</small></div>`;
    forecast.innerHTML=(data.forecast||[]).slice(0,4).map((d,i)=>`<article style="--risk-color:${d.risk.color}"><b>${i===0?'Hôm nay':new Date(d.date+'T00:00:00').toLocaleDateString('vi-VN',{weekday:'short'})}</b><span>${esc(d.weatherText)}</span><strong>${d.risk.level}/5</strong><small>${fmtNumber(d.maxTemp)}° • RH ${fmtNumber(d.minHumidity)}% • mưa ${fmtNumber(d.rainSum,1)}mm</small></article>`).join('');
    advice.innerHTML=`<b>Khuyến nghị:</b> ${esc(riskAction(today.risk.level))}<br><small>Yếu tố chính: ${esc(today.risk.reasons.join(', '))}. Cập nhật ${new Date(data.fetchedAt).toLocaleString('vi-VN')} • ${esc(data.source)}${data.cached?' • cache':''}${stale?' • bản lưu trên thiết bị':''}</small>`;
    document.getElementById('weatherDisclaimer').textContent=data.disclaimer||'Chỉ số hỗ trợ nghiệp vụ, không thay thế cấp dự báo chính thức.';
  };
  try{
    const query=new URLSearchParams({latitude:String(weatherCoords.latitude),longitude:String(weatherCoords.longitude)});
    const data=await api(`/api/fire-weather?${query.toString()}`);
    renderWeather(data); saveWeatherSnapshot(data);
  }catch(e){
    const snapshot=loadWeatherSnapshot();
    if(snapshot?.data){
      renderWeather(snapshot.data,{stale:true});
      status(`Không tải được dữ liệu mới: ${e.message}. Đang dùng dự báo gần nhất.`);
    }else{
      hero.innerHTML=`<b>Không tải được thời tiết</b><small>${esc(e.message)}</small>`;now.innerHTML='';forecast.innerHTML='';advice.innerHTML='Kiểm tra Internet rồi bấm <b>Làm mới thời tiết & nguy cơ</b>. Dữ liệu bản đồ và dữ liệu hiện trường vẫn hoạt động độc lập.';
    }
  }
}
document.getElementById('refreshWeatherBtn').addEventListener('click',()=>loadFireWeather(false));
document.getElementById('weatherHereBtn').addEventListener('click',()=>loadFireWeather(true));
loadFireWeather(false);

async function loadHueWards() {
  const select = document.getElementById('fireWard');
  try {
    const data = await api('/api/admin-units/hue');
    const wards = [...(data.wards || [])].sort((a,b) => String(a.ward_name || a.name || '').localeCompare(String(b.ward_name || b.name || ''), 'vi'));
    const specialNote=document.getElementById('specialUnitsNote');
    if(specialNote){const names=(data.specialUnits||[]).map(x=>x.name||x.ward_name).filter(Boolean);specialNote.textContent=names.length?`Đơn vị biển đảo theo 34tinhthanh.com: ${names.join(' • ')}`:'Đơn vị biển đảo: Đặc khu Hoàng Sa • Đặc khu Trường Sa';}
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
  statusBox.textContent = 'Đang tải cảnh báo và điểm nóng vệ tinh…';
  fireAlertLayer.clearLayers();
  const b=map.getBounds();
  const pcccrUrl=`/api/fire-alerts${wardCode ? `?ward_code=${encodeURIComponent(wardCode)}` : ''}`;
  const firmsUrl=`/api/fire-hotspots?west=${b.getWest().toFixed(4)}&south=${b.getSouth().toFixed(4)}&east=${b.getEast().toFixed(4)}&north=${b.getNorth().toFixed(4)}`;
  const [officialResult,firmsResult]=await Promise.allSettled([api(pcccrUrl),api(firmsUrl)]);
  let officialCount=0, firmsCount=0, messages=[];
  if(officialResult.status==='fulfilled'){
    const data=officialResult.value;
    document.getElementById('openPcccrBtn').href = data.sourceUrl || 'https://v2.pcccr.vn/diem-chay';
    const geojson = data.geojson || { type:'FeatureCollection', features:[] };
    const rendered = L.geoJSON(geojson, {
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 8, weight: 3, color:'#fff', fillColor:'#e53935', fillOpacity:.95 }),
      style: { color:'#e53935', weight:3, fillColor:'#ff7043', fillOpacity:.3 },
      onEachFeature: (feature, layer) => layer.bindPopup(firePopup(feature.properties || {}))
    });
    rendered.eachLayer(layer => fireAlertLayer.addLayer(layer)); officialCount=geojson.features?.length||0;
    if(!data.configured&&data.message)messages.push(data.message);
  }else messages.push('Không kết nối được nguồn PCCCR.');
  if(firmsResult.status==='fulfilled'){
    const data=firmsResult.value; const features=data.features||[]; firmsCount=features.length;
    if(data.configured){L.geoJSON({type:'FeatureCollection',features},{pointToLayer:(_f,ll)=>L.circleMarker(ll,{radius:7,color:'#fff',weight:2,fillColor:'#ff6d00',fillOpacity:.9}),onEachFeature:(f,l)=>l.bindPopup(`<b>Điểm nóng vệ tinh</b><br>Ngày: ${esc(f.properties.acq_date||'—')} ${esc(f.properties.acq_time||'')}<br>Độ tin cậy: ${esc(f.properties.confidence||'—')}<br>FRP: ${esc(f.properties.frp||'—')}<br><small>Nguồn: NASA FIRMS</small>`)}).eachLayer(l=>fireAlertLayer.addLayer(l));}
  }
  statusBox.textContent=`PCCCR: ${officialCount} điểm • NASA FIRMS: ${firmsCount} điểm${messages.length?' • '+messages.join(' '):''}`;
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
(async()=>{try{appConfig=await api('/api/app-config');}catch(_){ }await updateNetworkUI();if(navigator.onLine)syncPending();})();



// Nghiệp vụ hiện trường: SOS, nhiệm vụ, trực ban và so sánh tracklog.
const comparisonLayer=L.layerGroup().addTo(map);
async function loadAssignments(){
  const box=document.getElementById('assignmentSummary'); if(!box)return;
  try{const rows=await api('/api/assignments');box.innerHTML=rows.length?`<b>${rows.length} nhiệm vụ</b><br>${rows.slice(0,3).map(x=>`${esc(x.title)} • ${esc(x.status)}`).join('<br>')}`:'Chưa có nhiệm vụ được giao.';
    rows.forEach(a=>{if(a.geometry)L.geoJSON(a.geometry,{style:{color:'#7b1fa2',weight:3,dashArray:'8 5',fillOpacity:.06}}).bindPopup(`<b>Nhiệm vụ: ${esc(a.title)}</b><br>${esc(a.description||'')}<br>Trạng thái: ${esc(a.status)}`).addTo(comparisonLayer);});
  }catch(e){box.textContent='Không tải được nhiệm vụ: '+e.message;}
}
document.getElementById('sosBtn')?.addEventListener('click',async()=>{if(!currentPosition){status('Hãy bật Định vị trước khi gửi SOS.');return;}if(!confirm('Gửi SOS kèm vị trí hiện tại đến quản trị và nhóm?'))return;try{const out=await api('/api/sos',{method:'POST',body:JSON.stringify({latitude:currentPosition.latitude,longitude:currentPosition.longitude,accuracy:currentPosition.accuracy,message:'Yêu cầu hỗ trợ khẩn cấp từ hiện trường'})});showToast(out.message||'Đã gửi SOS.');}catch(e){showToast(e.message||'Không gửi được SOS.');}});
document.getElementById('compareTracksBtn')?.addEventListener('click',async()=>{const id1=document.getElementById('compareTrack1').value,id2=document.getElementById('compareTrack2').value,box=document.getElementById('compareResult');if(!id1||!id2||id1===id2){box.textContent='Hãy chọn hai tracklog khác nhau.';return;}try{const out=await api(`/api/tracks/compare?id1=${encodeURIComponent(id1)}&id2=${encodeURIComponent(id2)}`);comparisonLayer.clearLayers();const styles=[{color:'#1565c0',weight:5},{color:'#e65100',weight:5,dashArray:'8 5'}];out.tracks.forEach((t,i)=>L.polyline((t.points||[]).map(p=>[p.lat,p.lng]),styles[i]).bindPopup(`<b>${esc(t.name)}</b><br>${Math.round(t.distanceMeters||0)} m`).addTo(comparisonLayer));const all=out.tracks.flatMap(t=>(t.points||[]).map(p=>[p.lat,p.lng]));if(all.length)map.fitBounds(all,{padding:[30,30]});box.textContent=`Chênh lệch quãng đường: ${Math.round(out.distanceDifference||0)} m.`;}catch(e){box.textContent=e.message;}});
setInterval(()=>{if(!navigator.onLine)return;fetch('/api/presence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({latitude:currentPosition?.latitude,longitude:currentPosition?.longitude,tracking:isTracking})}).catch(()=>{});},60000);
loadAssignments();

setTimeout(() => map.invalidateSize(true), 350);

const vietnamOverviewBtn=document.getElementById('vietnamOverviewBtn');
if(vietnamOverviewBtn)vietnamOverviewBtn.addEventListener('click',showVietnamOverview);
