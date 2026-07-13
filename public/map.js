const map = L.map('map').setView([16.4637, 107.5909], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const waypointLayer = L.layerGroup().addTo(map);
const trackLayer = L.layerGroup().addTo(map);
const fireAlertLayer = L.layerGroup().addTo(map);
const uploadedLayers = new Map();
const layerControl = L.control.layers(null, { Waypoint: waypointLayer, Tracklog: trackLayer, 'Cảnh báo cháy rừng': fireAlertLayer }, { collapsed: false }).addTo(map);
let currentPosition = null;
let currentMarker = null;
let watchId = null;
let trackPoints = [];
let liveLine = null;
let pendingMode = null;
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
  const data = await api('/api/map-data');
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
    list.insertAdjacentHTML('beforeend', `<div class="data-item"><span class="wp-dot"></span><b>${esc(w.name)}</b><br><small>${w.latitude.toFixed(5)}, ${w.longitude.toFixed(5)}</small><br><button onclick="focusPoint(${w.latitude},${w.longitude})">Xem</button> <button class="danger" onclick="deleteWaypoint(${w.id})">Xóa</button></div>`);
  });
  data.tracks.forEach(t => {
    const pts = t.points.map(p => [p.lat, p.lng]);
    if (pts.length) {
      L.polyline(pts, { weight: 4 })
        .bindPopup(`<b>${esc(t.name)}</b><br>${Math.round(t.distanceMeters)} m<br><small>${esc(t.User?.name || '')}</small>`)
        .addTo(trackLayer);
      bounds.push(...pts);
    }
    list.insertAdjacentHTML('beforeend', `<div class="data-item"><span class="track-dot"></span><b>${esc(t.name)}</b><br><small>${Math.round(t.distanceMeters)} m • ${t.points.length} điểm</small><div class="data-actions"><button onclick='focusTrack(${JSON.stringify(pts)})'>Xem</button><a class="mini-link" href="/api/tracks/${t.id}/export/geojson">GeoJSON + WP</a><a class="mini-link" href="/api/tracks/${t.id}/export/gpx">GPX + WP</a><a class="mini-link" href="/api/tracks/${t.id}/export/kml">KML + WP</a><button class="danger" onclick="deleteTrack(${t.id})">Xóa</button></div></div>`);
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

function locate() {
  if (!navigator.geolocation) return status('Thiết bị không hỗ trợ định vị.');
  status('Đang xác định vị trí...');
  navigator.geolocation.getCurrentPosition(p => {
    currentPosition = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy };
    if (currentMarker) currentMarker.remove();
    currentMarker = L.circleMarker([currentPosition.latitude, currentPosition.longitude], { radius: 9, weight: 3, fillOpacity: 0.7 })
      .bindPopup(`Vị trí hiện tại<br>Độ chính xác ±${Math.round(currentPosition.accuracy)} m`).addTo(map).openPopup();
    map.setView([currentPosition.latitude, currentPosition.longitude], 17);
    status(`Đã định vị • chính xác khoảng ${Math.round(currentPosition.accuracy)} m`);
  }, e => status(`Không thể định vị: ${e.message}`), { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 });
}

document.getElementById('locateBtn').onclick = locate;
document.getElementById('addWpBtn').onclick = () => {
  if (!currentPosition) { locate(); status('Hãy bấm lại sau khi định vị xong.'); return; }
  pendingMode = 'waypoint';
  document.getElementById('modalTitle').textContent = 'Lưu waypoint';
  document.getElementById('categoryWrap').style.display = 'grid';
  modal.classList.remove('hidden');
};
document.getElementById('startTrackBtn').onclick = () => {
  if (!navigator.geolocation) return status('Thiết bị không hỗ trợ GPS.');
  trackPoints = [];
  if (liveLine) liveLine.remove();
  liveLine = L.polyline([], { weight: 5 }).addTo(map);
  watchId = navigator.geolocation.watchPosition(p => {
    const point = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, time: new Date().toISOString() };
    trackPoints.push(point); liveLine.addLatLng([point.lat, point.lng]); map.panTo([point.lat, point.lng]);
    status(`Đang ghi tracklog: ${trackPoints.length} điểm`);
  }, e => status(`Lỗi GPS: ${e.message}`), { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  document.getElementById('startTrackBtn').disabled = true;
  document.getElementById('stopTrackBtn').disabled = false;
};
document.getElementById('stopTrackBtn').onclick = () => {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  document.getElementById('startTrackBtn').disabled = false;
  document.getElementById('stopTrackBtn').disabled = true;
  if (trackPoints.length < 2) return status('Tracklog quá ngắn, chưa lưu.');
  pendingMode = 'track';
  document.getElementById('modalTitle').textContent = 'Lưu tracklog';
  document.getElementById('categoryWrap').style.display = 'none';
  modal.classList.remove('hidden');
};
document.getElementById('cancelModal').onclick = () => modal.classList.add('hidden');
document.getElementById('saveModal').onclick = async () => {
  const name = document.getElementById('itemName').value.trim() || undefined;
  const description = document.getElementById('itemDescription').value.trim();
  try {
    if (pendingMode === 'waypoint') await api('/api/waypoints', { method: 'POST', body: JSON.stringify({ ...currentPosition, name, description, category: document.getElementById('itemCategory').value }) });
    else await api('/api/tracks', { method: 'POST', body: JSON.stringify({ name, description, points: trackPoints }) });
    modal.classList.add('hidden');
    document.getElementById('itemName').value = '';
    document.getElementById('itemDescription').value = '';
    status('Đã lưu dữ liệu.');
    await loadData();
  } catch (e) { status(e.message); }
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
