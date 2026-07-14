require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');
const multer = require('multer');
const initSqlJs = require('sql.js');
const { DOMParser } = require('@xmldom/xmldom');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const { Sequelize, DataTypes, Op } = require('sequelize');
const SequelizeStoreFactory = require('connect-session-sequelize');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Number(process.env.MAX_LAYER_FILE_MB || 50) * 1024 * 1024 } });
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const mbtilesCache = new Map();

const HUE_PROVINCE_CODE = '46';
const ADMIN_API_BASE = process.env.ADMIN_API_BASE || 'https://34tinhthanh.com';
const PCCCR_PORTAL_URL = process.env.PCCCR_PORTAL_URL || 'https://v2.pcccr.vn/diem-chay';
const PCCCR_API_URL = process.env.PCCCR_API_URL || '';
const PCCCR_API_TOKEN = process.env.PCCCR_API_TOKEN || '';
const TOPO_TILE_URL = process.env.TOPO_TILE_URL || 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png';
const OFFLINE_TILE_URL = process.env.OFFLINE_TILE_URL || TOPO_TILE_URL;
const OFFLINE_TILE_MAX = Number(process.env.OFFLINE_TILE_MAX || 1200);
const WEATHER_API_BASE = process.env.WEATHER_API_BASE || 'https://api.open-meteo.com';
const WEATHER_CACHE_MINUTES = Math.max(1, Number(process.env.WEATHER_CACHE_MINUTES || 10));
const FIRMS_MAP_KEY = process.env.FIRMS_MAP_KEY || '';
const FIRMS_SOURCE = process.env.FIRMS_SOURCE || 'VIIRS_SNPP_NRT';
const weatherCache = new Map();

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Nguồn dữ liệu trả về HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function weatherRiskLevel(score) {
  if (score >= 80) return { level: 5, label: 'Cấp V - Cực kỳ nguy hiểm', color: '#7f0000' };
  if (score >= 65) return { level: 4, label: 'Cấp IV - Nguy hiểm', color: '#d32f2f' };
  if (score >= 45) return { level: 3, label: 'Cấp III - Cao', color: '#f57c00' };
  if (score >= 25) return { level: 2, label: 'Cấp II - Trung bình', color: '#fbc02d' };
  return { level: 1, label: 'Cấp I - Thấp', color: '#388e3c' };
}
function calculateFireWeatherRisk({ maxTemp, minHumidity, maxWind, maxGust, rainSum, recentRain }) {
  const tempScore = clamp((Number(maxTemp) - 24) * 2.4, 0, 28);
  const humidityScore = clamp((60 - Number(minHumidity)) * 0.75, 0, 30);
  const windScore = clamp(Number(maxWind) * 0.65, 0, 18);
  const gustScore = clamp((Number(maxGust) - 25) * 0.35, 0, 8);
  const drynessScore = Number(rainSum) < 0.5 ? 12 : Number(rainSum) < 3 ? 7 : Number(rainSum) < 8 ? 3 : 0;
  const recentDrynessScore = Number(recentRain) < 1 ? 8 : Number(recentRain) < 5 ? 4 : 0;
  const score = Math.round(clamp(tempScore + humidityScore + windScore + gustScore + drynessScore + recentDrynessScore, 0, 100));
  const risk = weatherRiskLevel(score);
  const reasons = [];
  if (maxTemp >= 35) reasons.push('nhiệt độ rất cao'); else if (maxTemp >= 32) reasons.push('nhiệt độ cao');
  if (minHumidity <= 35) reasons.push('độ ẩm rất thấp'); else if (minHumidity <= 50) reasons.push('không khí khô');
  if (maxWind >= 25 || maxGust >= 40) reasons.push('gió mạnh làm tăng khả năng lan cháy');
  if (rainSum < 1 && recentRain < 3) reasons.push('ít mưa, vật liệu cháy dễ khô');
  if (!reasons.length) reasons.push('điều kiện khí tượng chưa cho thấy nguy cơ nổi bật');
  return { score, ...risk, reasons };
}
function weatherCodeText(code) {
  const map = {0:'Trời quang',1:'Ít mây',2:'Mây rải rác',3:'Nhiều mây',45:'Sương mù',48:'Sương mù đóng băng',51:'Mưa phùn nhẹ',53:'Mưa phùn',55:'Mưa phùn dày',61:'Mưa nhẹ',63:'Mưa vừa',65:'Mưa lớn',80:'Mưa rào nhẹ',81:'Mưa rào',82:'Mưa rào mạnh',95:'Dông',96:'Dông kèm mưa đá',99:'Dông mạnh kèm mưa đá'};
  return map[Number(code)] || 'Thời tiết biến đổi';
}
function parseOpenMeteo(payload) {
  const h = payload.hourly || {}, times = h.time || [];
  const nowMs = Date.now();
  const rows = times.map((time, i) => ({
    time, ms: new Date(time).getTime(),
    temperature: Number(h.temperature_2m?.[i]), humidity: Number(h.relative_humidity_2m?.[i]),
    precipitation: Number(h.precipitation?.[i] || 0), wind: Number(h.wind_speed_10m?.[i] || 0),
    gust: Number(h.wind_gusts_10m?.[i] || 0), weatherCode: Number(h.weather_code?.[i])
  })).filter(r => Number.isFinite(r.ms));
  const recent = rows.filter(r => r.ms >= nowMs - 24*3600e3 && r.ms <= nowMs);
  const recentRain = recent.reduce((a,r)=>a+(r.precipitation||0),0);
  const days = [];
  for (let d=0; d<4; d++) {
    const start = new Date(); start.setHours(0,0,0,0); start.setDate(start.getDate()+d);
    const end = new Date(start); end.setDate(end.getDate()+1);
    const dayRows = rows.filter(r => r.ms >= start.getTime() && r.ms < end.getTime());
    if (!dayRows.length) continue;
    const maxTemp = Math.max(...dayRows.map(r=>r.temperature).filter(Number.isFinite));
    const minHumidity = Math.min(...dayRows.map(r=>r.humidity).filter(Number.isFinite));
    const maxWind = Math.max(...dayRows.map(r=>r.wind).filter(Number.isFinite));
    const maxGust = Math.max(...dayRows.map(r=>r.gust).filter(Number.isFinite));
    const rainSum = dayRows.reduce((a,r)=>a+(r.precipitation||0),0);
    const noon = dayRows.reduce((best,r)=>Math.abs(new Date(r.time).getHours()-12)<Math.abs(new Date(best.time).getHours()-12)?r:best,dayRows[0]);
    days.push({ date:start.toISOString().slice(0,10), maxTemp, minHumidity, maxWind, maxGust, rainSum:Number(rainSum.toFixed(1)), weatherCode:noon.weatherCode, weatherText:weatherCodeText(noon.weatherCode), risk:calculateFireWeatherRisk({maxTemp,minHumidity,maxWind,maxGust,rainSum,recentRain}) });
  }
  return { current: payload.current || null, recentRain24h:Number(recentRain.toFixed(1)), forecast:days };
}

function normalizeFireAlerts(payload) {
  if (!payload) return { type: 'FeatureCollection', features: [] };
  if (payload.type === 'FeatureCollection' && Array.isArray(payload.features)) return payload;
  if (payload.data) return normalizeFireAlerts(payload.data);
  const rows = Array.isArray(payload) ? payload : (Array.isArray(payload.items) ? payload.items : (Array.isArray(payload.results) ? payload.results : []));
  const features = [];
  for (const item of rows) {
    if (item?.type === 'Feature' && item.geometry) { features.push(item); continue; }
    const lat = Number(item.latitude ?? item.lat ?? item.y);
    const lng = Number(item.longitude ?? item.lng ?? item.lon ?? item.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { ...item, latitude: undefined, longitude: undefined, lat: undefined, lng: undefined, lon: undefined, x: undefined, y: undefined } });
  }
  return { type: 'FeatureCollection', features };
}

let sqlJsPromise = null;
function getSqlJs() {
  if (!sqlJsPromise) sqlJsPromise = initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
  return sqlJsPromise;
}

if (!process.env.DATABASE_URL) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const sequelize = process.env.DATABASE_URL
  ? new Sequelize(process.env.DATABASE_URL, {
      dialect: 'postgres',
      logging: false,
      dialectOptions: isProduction ? { ssl: { require: true, rejectUnauthorized: false } } : {}
    })
  : new Sequelize({ dialect: 'sqlite', storage: path.join(__dirname, 'data', 'app.sqlite'), logging: false });

const User = sequelize.define('User', {
  name: { type: DataTypes.STRING, allowNull: false },
  // Giữ tên cột email để tương thích cơ sở dữ liệu cũ, nhưng giá trị có thể là
  // email thật hoặc định danh nội bộ username@hufm.local. Không dùng isEmail vì
  // validator của Sequelize từ chối tên miền .local và làm ứng dụng dừng khi khởi động.
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    validate: {
      notEmpty: true,
      isLoginKey(value) {
        const text = String(value || '').trim().toLowerCase();
        if (!text || !/^[^\s@]+@[^\s@]+$/.test(text)) {
          throw new Error('Tên đăng nhập không hợp lệ.');
        }
      }
    }
  },
  passwordHash: { type: DataTypes.STRING, allowNull: false },
  phone: DataTypes.STRING,
  unit: DataTypes.STRING,
  role: { type: DataTypes.ENUM('admin', 'mod', 'user'), allowNull: false, defaultValue: 'user' },
  status: { type: DataTypes.ENUM('pending', 'approved', 'rejected'), allowNull: false, defaultValue: 'pending' }
});

const Group = sequelize.define('Group', {
  name: { type: DataTypes.STRING, allowNull: false, unique: true },
  description: DataTypes.TEXT
});

const Waypoint = sequelize.define('Waypoint', {
  name: { type: DataTypes.STRING, allowNull: false },
  description: DataTypes.TEXT,
  latitude: { type: DataTypes.DOUBLE, allowNull: false },
  longitude: { type: DataTypes.DOUBLE, allowNull: false },
  accuracy: DataTypes.DOUBLE,
  category: { type: DataTypes.STRING, defaultValue: 'Khác' }
});

const Tracklog = sequelize.define('Tracklog', {
  name: { type: DataTypes.STRING, allowNull: false },
  description: DataTypes.TEXT,
  points: { type: DataTypes.JSON, allowNull: false },
  distanceMeters: { type: DataTypes.DOUBLE, defaultValue: 0 },
  startedAt: DataTypes.DATE,
  endedAt: DataTypes.DATE
});

const SyncReceipt = sequelize.define('SyncReceipt', {
  clientId: { type: DataTypes.STRING, allowNull: false, unique: true },
  recordType: { type: DataTypes.ENUM('waypoint', 'track'), allowNull: false },
  serverRecordId: DataTypes.INTEGER
});

const MapLayer = sequelize.define('MapLayer', {
  name: { type: DataTypes.STRING, allowNull: false },
  description: DataTypes.TEXT,
  layerType: { type: DataTypes.ENUM('geojson', 'kml', 'mbtiles'), allowNull: false },
  originalFilename: DataTypes.STRING,
  mimeType: DataTypes.STRING,
  sizeBytes: DataTypes.INTEGER,
  vectorData: DataTypes.JSON,
  fileData: DataTypes.BLOB('long'),
  metadata: DataTypes.JSON
});

const PatrolAssignment = sequelize.define('PatrolAssignment', {
  title: { type: DataTypes.STRING, allowNull: false },
  description: DataTypes.TEXT,
  geometry: { type: DataTypes.JSON, allowNull: false },
  riskThreshold: { type: DataTypes.INTEGER, defaultValue: 4 },
  status: { type: DataTypes.ENUM('assigned','in_progress','completed','cancelled'), defaultValue: 'assigned' },
  dueAt: DataTypes.DATE
});

const SOSAlert = sequelize.define('SOSAlert', {
  message: DataTypes.TEXT,
  latitude: { type: DataTypes.DOUBLE, allowNull: false },
  longitude: { type: DataTypes.DOUBLE, allowNull: false },
  accuracy: DataTypes.DOUBLE,
  status: { type: DataTypes.ENUM('open','acknowledged','resolved'), defaultValue: 'open' },
  resolvedAt: DataTypes.DATE
});

const AuditLog = sequelize.define('AuditLog', {
  action: { type: DataTypes.STRING, allowNull: false },
  entityType: { type: DataTypes.STRING, allowNull: false },
  entityId: DataTypes.STRING,
  beforeData: DataTypes.JSON,
  afterData: DataTypes.JSON
});


Group.hasMany(User, { foreignKey: 'groupId' });
User.belongsTo(Group, { foreignKey: 'groupId' });
User.hasMany(Waypoint, { foreignKey: 'userId', onDelete: 'CASCADE' });
Waypoint.belongsTo(User, { foreignKey: 'userId' });
Group.hasMany(Waypoint, { foreignKey: 'groupId' });
Waypoint.belongsTo(Group, { foreignKey: 'groupId' });
User.hasMany(Tracklog, { foreignKey: 'userId', onDelete: 'CASCADE' });
Tracklog.belongsTo(User, { foreignKey: 'userId' });
Group.hasMany(Tracklog, { foreignKey: 'groupId' });
Tracklog.belongsTo(Group, { foreignKey: 'groupId' });
User.hasMany(MapLayer, { foreignKey: 'userId', onDelete: 'CASCADE' });
MapLayer.belongsTo(User, { foreignKey: 'userId' });
Group.hasMany(MapLayer, { foreignKey: 'groupId' });
MapLayer.belongsTo(Group, { foreignKey: 'groupId' });
User.hasMany(PatrolAssignment, { foreignKey:'assigneeId' });
PatrolAssignment.belongsTo(User, { as:'Assignee', foreignKey:'assigneeId' });
Group.hasMany(PatrolAssignment, { foreignKey:'groupId' });
PatrolAssignment.belongsTo(Group, { foreignKey:'groupId' });
User.hasMany(PatrolAssignment, { as:'CreatedAssignments', foreignKey:'createdById' });
PatrolAssignment.belongsTo(User, { as:'Creator', foreignKey:'createdById' });
User.hasMany(SOSAlert, { foreignKey:'userId' });
SOSAlert.belongsTo(User, { foreignKey:'userId' });
Group.hasMany(SOSAlert, { foreignKey:'groupId' });
SOSAlert.belongsTo(Group, { foreignKey:'groupId' });
User.hasMany(AuditLog, { foreignKey:'userId' });
AuditLog.belongsTo(User, { foreignKey:'userId' });


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org', 'https://*.tile.opentopomap.org', 'https://mt0.google.com', 'https://mt1.google.com', 'https://mt2.google.com', 'https://mt3.google.com'],
      connectSrc: ["'self'", 'blob:'],
      fontSrc: ["'self'", 'data:']
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));
app.use('/vendor/vectorgrid', express.static(path.join(__dirname, 'node_modules', 'leaflet.vectorgrid', 'dist')));
app.use((req, res, next) => { res.setHeader('Permissions-Policy', 'geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)'); next(); });

// Same-origin map tile proxies: avoid CSP/CDN failures on mobile Safari and installed PWA.
function validTileCoordinates(req, maxZoom = 19) {
  const z=Number(req.params.z), x=Number(req.params.x), y=Number(req.params.y);
  const max=Math.pow(2,z);
  if(!Number.isInteger(z)||!Number.isInteger(x)||!Number.isInteger(y)||z<0||z>maxZoom||x<0||y<0||x>=max||y>=max) return null;
  return {z,x,y};
}
async function proxyMapTile(res, upstream, source, fallbackType='image/png') {
  try {
    const response=await fetch(upstream,{headers:{'User-Agent':'HUFM-Hue-Forest-Manager/1.3 (forest-management-webapp)','Accept':'image/avif,image/webp,image/jpeg,image/png,image/*,*/*;q=0.8'},signal:AbortSignal.timeout(15000)});
    if(!response.ok) return res.status(response.status).end();
    const body=Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type',response.headers.get('content-type')||fallbackType);
    res.setHeader('Cache-Control','public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('X-Map-Source',source);
    return res.send(body);
  } catch(error) {
    console.error(`${source} tile proxy error:`,error.message);
    return res.status(502).end();
  }
}

app.get('/api/base-tiles/osm/:z/:x/:y.png', async (req, res) => {
  const tile=validTileCoordinates(req,19); if(!tile) return res.status(400).end();
  const {z,x,y}=tile, sub=['a','b','c'][(x+y)%3];
  return proxyMapTile(res,`https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`,'OpenStreetMap');
});
app.get('/api/base-tiles/topo/:z/:x/:y.png', async (req, res) => {
  const tile=validTileCoordinates(req,17); if(!tile) return res.status(400).end();
  const {z,x,y}=tile, sub=['a','b','c'][(x+y)%3];
  return proxyMapTile(res,`https://${sub}.tile.opentopomap.org/${z}/${x}/${y}.png`,'OpenTopoMap');
});
app.get('/api/base-tiles/google-hybrid/:z/:x/:y.jpg', async (req, res) => {
  const tile=validTileCoordinates(req,22); if(!tile) return res.status(400).end();
  const {z,x,y}=tile, server=(x+y)%4;
  return proxyMapTile(
    res,
    `https://mt${server}.google.com/vt/lyrs=y&x=${x}&y=${y}&z=${z}`,
    'Google Satellite Hybrid',
    'image/jpeg'
  );
});
const SequelizeStore = SequelizeStoreFactory(session.Store);
const sessionStore = new SequelizeStore({ db: sequelize });
app.use(session({
  name: 'hufm.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-change-this-secret',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: isProduction,
  cookie: {
    httpOnly: true,
    secure: isProduction ? 'auto' : false,
    sameSite: 'lax',
    path: '/',
    maxAge: 1000 * 60 * 60 * 12
  }
}));

// Không cho trình duyệt/PWA cache các trang xác thực hoặc phản hồi chứa phiên đăng nhập.
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/register' || req.path === '/logout' || req.path.startsWith('/admin/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

function flash(req, type, message) { req.session.flash = { type, message }; }
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) return res.status(403).render('error', { message: 'Bạn không có quyền truy cập.' });
    next();
  };
}
function dataScope(user) {
  if (user.role === 'admin') return {};
  if (user.role === 'mod') return { groupId: user.groupId || -1 };
  return { userId: user.id };
}

function canAccessRecord(user, record) {
  return user.role === 'admin' || (user.role === 'mod' && record.groupId === user.groupId) || record.userId === user.id;
}
function normalizeGeoJSON(data) {
  if (!data || typeof data !== 'object') throw new Error('GeoJSON không hợp lệ.');
  if (data.type === 'FeatureCollection' && Array.isArray(data.features)) return data;
  if (data.type === 'Feature') return { type: 'FeatureCollection', features: [data] };
  if (data.type && data.coordinates) return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: data }] };
  throw new Error('Tệp không chứa FeatureCollection, Feature hoặc Geometry hợp lệ.');
}
function parseCoordinates(text) {
  return String(text || '').trim().split(/\s+/).map(item => item.split(',').slice(0, 3).map(Number)).filter(c => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]));
}
function looksLikeMojibake(value = '') {
  return /(?:Ã.|Â.|áº.|á».|Ä‘|Æ°|Æ¡|á»|áº|ï»¿|�)/.test(String(value));
}
function repairVietnameseMojibake(value = '') {
  let text = String(value || '').replace(/^\uFEFF/, '').normalize('NFC');
  if (!looksLikeMojibake(text)) return text;
  // Trường hợp UTF-8 từng bị đọc nhầm thành Latin-1/Windows-1252, ví dụ Huáº¿.
  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf8').normalize('NFC');
    const oldBad = (text.match(/(?:Ã.|Â.|áº.|á».|Ä‘|Æ°|Æ¡|�)/g) || []).length;
    const newBad = (repaired.match(/(?:Ã.|Â.|áº.|á».|Ä‘|Æ°|Æ¡|�)/g) || []).length;
    if (!repaired.includes('�') && newBad < oldBad) text = repaired;
  } catch (_) {}
  return text;
}
function decodeKmlBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || '');
  let encoding = 'utf-8';
  let offset = 0;
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    offset = 3;
  } else if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    encoding = 'utf-16le'; offset = 2;
  } else if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    const body = Buffer.from(buffer.subarray(2));
    for (let i = 0; i + 1 < body.length; i += 2) [body[i], body[i + 1]] = [body[i + 1], body[i]];
    return repairVietnameseMojibake(new TextDecoder('utf-16le').decode(body));
  } else {
    const head = buffer.subarray(0, Math.min(buffer.length, 512)).toString('latin1');
    const declared = head.match(/<\?xml[^>]*encoding=["']\s*([^"']+)\s*["']/i)?.[1]?.toLowerCase();
    const aliases = {
      'utf8': 'utf-8', 'utf_8': 'utf-8',
      'windows-1258': 'windows-1258', 'cp1258': 'windows-1258', 'win1258': 'windows-1258',
      'windows-1252': 'windows-1252', 'cp1252': 'windows-1252',
      'iso-8859-1': 'windows-1252', 'latin1': 'windows-1252',
      'utf-16': 'utf-16le', 'utf-16le': 'utf-16le'
    };
    if (declared && aliases[declared]) encoding = aliases[declared];
    else {
      try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch (_) { encoding = 'windows-1258'; }
    }
  }
  let text;
  try { text = new TextDecoder(encoding, { fatal: false }).decode(buffer.subarray(offset)); }
  catch (_) { text = new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(offset)); }
  return repairVietnameseMojibake(text);
}
function decodeCsvBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || '');
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) return repairVietnameseMojibake(new TextDecoder('utf-16le').decode(buffer.subarray(2)));
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    const body = Buffer.from(buffer.subarray(2));
    for (let i = 0; i + 1 < body.length; i += 2) [body[i], body[i + 1]] = [body[i + 1], body[i]];
    return repairVietnameseMojibake(new TextDecoder('utf-16le').decode(body));
  }
  let source = buffer;
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) source = buffer.subarray(3);
  try { return repairVietnameseMojibake(new TextDecoder('utf-8', { fatal: true }).decode(source)); }
  catch (_) { return repairVietnameseMojibake(new TextDecoder('windows-1258').decode(source)); }
}
function detectCsvDelimiter(text) {
  const first = String(text || '').split(/\r?\n/, 1)[0] || '';
  const count = delimiter => { let quoted=false,n=0; for(let i=0;i<first.length;i++){ if(first[i]==='"' && first[i+1]==='"'){i++;continue;} if(first[i]==='"') quoted=!quoted; else if(first[i]===delimiter&&!quoted)n++; } return n; };
  return count(';') > count(',') ? ';' : ',';
}
function parseCsv(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  const delimiter = detectCsvDelimiter(text);
  const rows=[]; let row=[], field='', quoted=false;
  for (let i=0;i<text.length;i++) {
    const ch=text[i];
    if (quoted) {
      if (ch==='"' && text[i+1]==='"') { field+='"'; i++; }
      else if (ch==='"') quoted=false;
      else field+=ch;
    } else if (ch==='"') quoted=true;
    else if (ch===delimiter) { row.push(field.trim()); field=''; }
    else if (ch==='\n') { row.push(field.trim()); if(row.some(v=>v!=='')) rows.push(row); row=[]; field=''; }
    else if (ch!=='\r') field+=ch;
  }
  row.push(field.trim()); if(row.some(v=>v!=='')) rows.push(row);
  if (!rows.length) return [];
  const aliases = {
    'họ tên':'name','ho ten':'name','tên':'name','ten':'name','name':'name',
    'username':'username','tên đăng nhập':'username','ten dang nhap':'username','tài khoản':'username','tai khoan':'username',
    'email':'email','thư điện tử':'email','thu dien tu':'email',
    'mật khẩu':'password','mat khau':'password','password':'password',
    'vai trò':'role','vai tro':'role','role':'role',
    'điện thoại':'phone','dien thoai':'phone','số điện thoại':'phone','so dien thoai':'phone','phone':'phone',
    'đơn vị':'unit','don vi':'unit','unit':'unit',
    'nhóm':'group_name','nhom':'group_name','tên nhóm':'group_name','ten nhom':'group_name','group':'group_name','group_name':'group_name',
    'trạng thái':'status','trang thai':'status','status':'status'
  };
  const normalizeHeader = value => repairVietnameseMojibake(String(value||'')).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/\s+/g,' ');
  const normalizedAliases={}; for(const [k,v] of Object.entries(aliases)) normalizedAliases[normalizeHeader(k)]=v;
  const headers=rows.shift().map(h=>normalizedAliases[normalizeHeader(h)]||normalizeHeader(h).replace(/ /g,'_'));
  return rows.map((values,index)=>({ line:index+2, data:Object.fromEntries(headers.map((h,i)=>[h,repairVietnameseMojibake(values[i]||'').trim()])) }));
}
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').toLowerCase()); }
function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9._-]+/g, '');
}
function loginKeyToEmail(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw.includes('@')) return raw; // tương thích tài khoản email cũ
  const username = normalizeUsername(raw);
  return username ? `${username}@hufm.local` : '';
}
function displayLogin(value) {
  const text = String(value || '');
  return text.endsWith('@hufm.local') ? text.slice(0, -11) : text;
}
function deepRepairVietnamese(value) {
  if (typeof value === 'string') return repairVietnameseMojibake(value);
  if (Array.isArray(value)) return value.map(deepRepairVietnamese);
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) output[repairVietnameseMojibake(key)] = deepRepairVietnamese(item);
    return output;
  }
  return value;
}
function repairUploadedFilename(value = '') {
  const name = String(value || '');
  if (!looksLikeMojibake(name)) {
    try {
      const utf8 = Buffer.from(name, 'latin1').toString('utf8');
      if (!utf8.includes('�') && /[À-ỹĐđ]/.test(utf8)) return utf8.normalize('NFC');
    } catch (_) {}
    return name.normalize('NFC');
  }
  return repairVietnameseMojibake(name);
}
function firstText(node, tag) {
  const item = node.getElementsByTagName(tag)[0];
  return item ? repairVietnameseMojibake(String(item.textContent || '').trim()) : '';
}
function readExtendedData(placemark) {
  const result = {};
  for (const data of Array.from(placemark.getElementsByTagName('Data'))) {
    const key = repairVietnameseMojibake(data.getAttribute('name') || '').trim();
    const valueNode = data.getElementsByTagName('value')[0];
    if (key && valueNode) result[key] = repairVietnameseMojibake(String(valueNode.textContent || '').trim());
  }
  for (const item of Array.from(placemark.getElementsByTagName('SimpleData'))) {
    const key = repairVietnameseMojibake(item.getAttribute('name') || '').trim();
    if (key) result[key] = repairVietnameseMojibake(String(item.textContent || '').trim());
  }
  return result;
}
function kmlToGeoJSON(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const parseErrors = doc.getElementsByTagName('parsererror');
  if (parseErrors.length) throw new Error('KML không hợp lệ.');
  const features = [];
  const placemarks = Array.from(doc.getElementsByTagName('Placemark'));
  for (const placemark of placemarks) {
    const properties = { name: firstText(placemark, 'name'), description: firstText(placemark, 'description'), ...readExtendedData(placemark) };
    const geometries = [];
    for (const point of Array.from(placemark.getElementsByTagName('Point'))) {
      const c = parseCoordinates(firstText(point, 'coordinates'))[0]; if (c) geometries.push({ type: 'Point', coordinates: c });
    }
    for (const line of Array.from(placemark.getElementsByTagName('LineString'))) {
      const c = parseCoordinates(firstText(line, 'coordinates')); if (c.length >= 2) geometries.push({ type: 'LineString', coordinates: c });
    }
    for (const polygon of Array.from(placemark.getElementsByTagName('Polygon'))) {
      const rings = [];
      for (const ring of Array.from(polygon.getElementsByTagName('LinearRing'))) {
        const c = parseCoordinates(firstText(ring, 'coordinates')); if (c.length >= 4) rings.push(c);
      }
      if (rings.length) geometries.push({ type: 'Polygon', coordinates: rings });
    }
    if (!geometries.length) continue;
    const geometry = geometries.length === 1 ? geometries[0] : { type: 'GeometryCollection', geometries };
    features.push({ type: 'Feature', properties, geometry });
  }
  return { type: 'FeatureCollection', features };
}
async function getMbtilesDb(layer) {
  let db = mbtilesCache.get(layer.id);
  if (db) return db;
  const SQL = await getSqlJs();
  db = new SQL.Database(new Uint8Array(layer.fileData));
  mbtilesCache.set(layer.id, db);
  return db;
}
function sqlRows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally { stmt.free(); }
}


function xmlEscape(value = '') {
  return String(value).replace(/[<>&"']/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' }[c]));
}
function safeFilename(value = 'tracklog') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'tracklog';
}
function trackExportGeoJSON(track, waypoints) {
  return { type: 'FeatureCollection', features: [
    { type:'Feature', geometry:{ type:'LineString', coordinates:track.points.map(p => [p.lng, p.lat, Number.isFinite(Number(p.altitude)) ? Number(p.altitude) : undefined].filter(v => v !== undefined)) }, properties:{ kind:'tracklog', id:track.id, name:track.name, description:track.description, distanceMeters:track.distanceMeters, startedAt:track.startedAt, endedAt:track.endedAt } },
    ...waypoints.map(w => ({ type:'Feature', geometry:{ type:'Point', coordinates:[w.longitude, w.latitude] }, properties:{ kind:'waypoint', id:w.id, name:w.name, description:w.description, category:w.category, accuracy:w.accuracy, createdAt:w.createdAt } }))
  ]};
}
function trackExportGpx(track, waypoints) {
  const waypointXml = waypoints.map(w => `  <wpt lat="${w.latitude}" lon="${w.longitude}"><name>${xmlEscape(w.name)}</name><desc>${xmlEscape(w.description || '')}</desc><type>${xmlEscape(w.category || 'Waypoint')}</type><extensions><accuracy>${w.accuracy || ''}</accuracy></extensions></wpt>`).join('\n');
  const pointsXml = track.points.map(p => `      <trkpt lat="${p.lat}" lon="${p.lng}">${p.time ? `<time>${xmlEscape(new Date(p.time).toISOString())}</time>` : ''}${Number.isFinite(Number(p.accuracy)) ? `<extensions><accuracy>${p.accuracy}</accuracy></extensions>` : ''}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Hue Forest Manager" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${xmlEscape(track.name)} và waypoint đối chiếu</name><time>${new Date().toISOString()}</time></metadata>\n${waypointXml}\n  <trk><name>${xmlEscape(track.name)}</name><desc>${xmlEscape(track.description || '')}</desc><trkseg>\n${pointsXml}\n  </trkseg></trk>\n</gpx>`;
}
function trackExportKml(track, waypoints) {
  const waypointXml = waypoints.map(w => `<Placemark><name>${xmlEscape(w.name)}</name><description>${xmlEscape(`${w.category || ''} - ${w.description || ''}`)}</description><Point><coordinates>${w.longitude},${w.latitude},0</coordinates></Point></Placemark>`).join('\n');
  const coords = track.points.map(p => `${p.lng},${p.lat},${Number.isFinite(Number(p.altitude)) ? p.altitude : 0}`).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xmlEscape(track.name)} và waypoint đối chiếu</name><Style id="track"><LineStyle><color>ff0000ff</color><width>4</width></LineStyle></Style><Placemark><name>${xmlEscape(track.name)}</name><description>${xmlEscape(track.description || '')}</description><styleUrl>#track</styleUrl><LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString></Placemark>${waypointXml}</Document></kml>`;
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lng - a.lng);
  const x = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.redirect(req.session.user ? '/map' : '/login'));

app.get('/register', (req, res) => res.render('register'));
app.post('/register', async (req, res) => {
  try {
    const { name, username, password, phone, unit } = req.body;
    const cleanUsername = normalizeUsername(username);
    const email = loginKeyToEmail(cleanUsername);
    if (!name || cleanUsername.length < 3 || !password || password.length < 8) {
      flash(req, 'error', 'Vui lòng nhập họ tên, tên đăng nhập từ 3 ký tự và mật khẩu tối thiểu 8 ký tự.');
      return res.redirect('/register');
    }
    const exists = await User.findOne({ where: { email } });
    if (exists) { flash(req, 'error', 'Tên đăng nhập đã được sử dụng.'); return res.redirect('/register'); }
    await User.create({ name: name.trim(), email, passwordHash: await bcrypt.hash(password, 12), phone, unit, role: 'user', status: 'pending' });
    flash(req, 'success', 'Đăng ký thành công. Tài khoản đang chờ quản trị viên phê duyệt.');
    res.redirect('/login');
  } catch (e) { console.error(e); flash(req, 'error', 'Không thể đăng ký tài khoản.'); res.redirect('/register'); }
});

app.get('/login', (req, res) => res.render('login'));
app.post('/login', async (req, res) => {
  try {
    const email = loginKeyToEmail(req.body.username || req.body.email);
    const user = await User.findOne({ where: { email }, include: Group });
    if (!user || !(await bcrypt.compare(req.body.password || '', user.passwordHash))) {
      flash(req, 'error', 'Tên đăng nhập hoặc mật khẩu không đúng.');
      return req.session.save(() => res.redirect('/login'));
    }
    if (user.status !== 'approved') {
      flash(req, 'error', user.status === 'pending' ? 'Tài khoản đang chờ phê duyệt.' : 'Tài khoản đã bị từ chối.');
      return req.session.save(() => res.redirect('/login'));
    }

    // Tạo session mới và chờ session store ghi xong trước khi chuyển sang bản đồ.
    return req.session.regenerate(error => {
      if (error) {
        console.error('Không thể tạo phiên đăng nhập:', error);
        return res.status(500).render('error', { message: 'Không thể tạo phiên đăng nhập. Vui lòng thử lại.' });
      }
      req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        username: displayLogin(user.email),
        role: user.role,
        groupId: user.groupId,
        groupName: user.Group?.name || null
      };
      req.session.save(saveError => {
        if (saveError) {
          console.error('Không thể lưu phiên đăng nhập:', saveError);
          return res.status(500).render('error', { message: 'Không thể lưu phiên đăng nhập. Vui lòng thử lại.' });
        }
        res.redirect(303, '/map');
      });
    });
  } catch (error) {
    console.error('Lỗi đăng nhập:', error);
    flash(req, 'error', 'Không thể đăng nhập lúc này. Vui lòng thử lại.');
    req.session.save(() => res.redirect('/login'));
  }
});
app.post('/logout', (req, res) => req.session.destroy(() => {
  res.clearCookie('hufm.sid', { path: '/', sameSite: 'lax', secure: isProduction });
  res.redirect('/login');
}));


const livePresence = new Map();
async function writeAudit(req, action, entityType, entityId, beforeData=null, afterData=null) {
  try { await AuditLog.create({ action, entityType, entityId:String(entityId||''), beforeData, afterData, userId:req.session.user?.id || null }); }
  catch (error) { console.warn('Không ghi được nhật ký:', error.message); }
}
function operationScope(user) {
  if (user.role === 'admin') return {};
  if (user.role === 'mod') return { groupId:user.groupId };
  return { [Op.or]:[{assigneeId:user.id},{groupId:user.groupId || -1}] };
}

app.get('/dashboard', requireAuth, async (req, res) => {
  const scope = dataScope(req.session.user);
  const [waypointCount, trackCount, userCount, pendingCount] = await Promise.all([
    Waypoint.count({ where: scope }), Tracklog.count({ where: scope }),
    req.session.user.role === 'admin' ? User.count() : req.session.user.role === 'mod' ? User.count({ where: { groupId: req.session.user.groupId } }) : 1,
    req.session.user.role === 'admin' ? User.count({ where: { status: 'pending' } }) : 0
  ]);
  res.render('dashboard', { stats: { waypointCount, trackCount, userCount, pendingCount } });
});


app.get('/operations', requireAuth, async (req,res) => {
  const where=operationScope(req.session.user);
  const [assignments,alerts,groups,users,logs]=await Promise.all([
    PatrolAssignment.findAll({where,include:[{model:User,as:'Assignee',attributes:['id','name','email']},{model:Group,attributes:['id','name']}],order:[['createdAt','DESC']],limit:100}),
    SOSAlert.findAll({where:req.session.user.role==='admin'?{}:req.session.user.role==='mod'?{groupId:req.session.user.groupId}:{userId:req.session.user.id},include:[{model:User,attributes:['id','name']}],order:[['createdAt','DESC']],limit:100}),
    req.session.user.role==='admin'?Group.findAll({order:[['name','ASC']]}):Group.findAll({where:{id:req.session.user.groupId||-1}}),
    ['admin','mod'].includes(req.session.user.role)?User.findAll({where:req.session.user.role==='admin'?{status:'approved'}:{groupId:req.session.user.groupId,status:'approved'},order:[['name','ASC']]}):[],
    AuditLog.findAll({include:[{model:User,attributes:['id','name']}],order:[['createdAt','DESC']],limit:50})
  ]);
  const cutoff=Date.now()-5*60*1000; const presence=[...livePresence.values()].filter(x=>x.updatedAt>=cutoff).filter(x=>req.session.user.role==='admin'||x.user.groupId===req.session.user.groupId||x.user.id===req.session.user.id); res.render('operations',{assignments,alerts,groups,users,logs,presence});
});
app.post('/api/presence', requireAuth, (req,res)=>{ livePresence.set(req.session.user.id,{user:req.session.user,latitude:Number(req.body.latitude)||null,longitude:Number(req.body.longitude)||null,tracking:!!req.body.tracking,updatedAt:Date.now()}); res.json({ok:true}); });
app.get('/api/operations/presence', requireAuth, (req,res)=>{ const cutoff=Date.now()-5*60*1000; const rows=[...livePresence.values()].filter(x=>x.updatedAt>=cutoff).filter(x=>req.session.user.role==='admin'||x.user.groupId===req.session.user.groupId||x.user.id===req.session.user.id); res.json(rows); });
app.get('/api/assignments', requireAuth, async (req,res)=>{ const rows=await PatrolAssignment.findAll({where:operationScope(req.session.user),include:[{model:User,as:'Assignee',attributes:['id','name']},{model:Group,attributes:['id','name']}],order:[['createdAt','DESC']]}); res.json(rows); });
app.post('/operations/assignments', requireRole('admin','mod'), async (req,res)=>{
  try{ const n=Number(req.body.north),s=Number(req.body.south),e=Number(req.body.east),w=Number(req.body.west); if(![n,s,e,w].every(Number.isFinite)) throw new Error('Phạm vi giao nhiệm vụ không hợp lệ.'); const geometry={type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}; const row=await PatrolAssignment.create({title:req.body.title||'Nhiệm vụ tuần tra',description:req.body.description||'',geometry,riskThreshold:Number(req.body.riskThreshold)||4,status:'assigned',dueAt:req.body.dueAt||null,assigneeId:req.body.assigneeId?Number(req.body.assigneeId):null,groupId:req.session.user.role==='mod'?req.session.user.groupId:(req.body.groupId?Number(req.body.groupId):null),createdById:req.session.user.id}); await writeAudit(req,'create','assignment',row.id,null,row.toJSON()); flash(req,'success','Đã giao nhiệm vụ tuần tra.'); }catch(error){flash(req,'error',error.message);} res.redirect('/operations');
});
app.post('/operations/assignments/:id/status', requireAuth, async (req,res)=>{ const row=await PatrolAssignment.findByPk(req.params.id); if(!row) return res.redirect('/operations'); if(req.session.user.role!=='admin'&&row.groupId!==req.session.user.groupId&&row.assigneeId!==req.session.user.id) return res.status(403).render('error',{message:'Không có quyền.'}); const before=row.toJSON(); const status=['assigned','in_progress','completed','cancelled'].includes(req.body.status)?req.body.status:row.status; await row.update({status}); await writeAudit(req,'update','assignment',row.id,before,row.toJSON()); flash(req,'success','Đã cập nhật nhiệm vụ.'); res.redirect('/operations'); });
app.post('/api/sos', requireAuth, async (req,res)=>{ const latitude=Number(req.body.latitude),longitude=Number(req.body.longitude); if(!Number.isFinite(latitude)||!Number.isFinite(longitude)) return res.status(400).json({error:'Chưa có tọa độ GPS hợp lệ.'}); const row=await SOSAlert.create({message:req.body.message||'Yêu cầu hỗ trợ khẩn cấp',latitude,longitude,accuracy:Number(req.body.accuracy)||null,userId:req.session.user.id,groupId:req.session.user.groupId||null}); await writeAudit(req,'create','sos',row.id,null,row.toJSON()); res.json({ok:true,message:'Đã gửi SOS đến quản trị và nhóm.',alert:row}); });
app.post('/operations/sos/:id/status', requireRole('admin','mod'), async (req,res)=>{ const row=await SOSAlert.findByPk(req.params.id); if(!row) return res.redirect('/operations'); if(req.session.user.role==='mod'&&row.groupId!==req.session.user.groupId) return res.status(403).render('error',{message:'Không có quyền.'}); const before=row.toJSON(); const status=['open','acknowledged','resolved'].includes(req.body.status)?req.body.status:row.status; await row.update({status,resolvedAt:status==='resolved'?new Date():null}); await writeAudit(req,'update','sos',row.id,before,row.toJSON()); flash(req,'success','Đã cập nhật cảnh báo SOS.'); res.redirect('/operations'); });
app.get('/api/tracks/compare', requireAuth, async (req,res)=>{ const ids=[Number(req.query.id1),Number(req.query.id2)]; if(ids.some(x=>!Number.isFinite(x))) return res.status(400).json({error:'Chọn đủ hai tracklog.'}); const rows=await Tracklog.findAll({where:{id:{[Op.in]:ids},...dataScope(req.session.user)}}); if(rows.length!==2) return res.status(404).json({error:'Không tìm thấy đủ hai tracklog.'}); const bbox=t=>{const lats=t.points.map(p=>p.lat),lngs=t.points.map(p=>p.lng);return {south:Math.min(...lats),north:Math.max(...lats),west:Math.min(...lngs),east:Math.max(...lngs)}}; res.json({tracks:rows,bounds:rows.map(bbox),distanceDifference:Math.abs((rows[0].distanceMeters||0)-(rows[1].distanceMeters||0))}); });
app.get('/reports/track/:id', requireAuth, async (req,res)=>{ const track=await Tracklog.findByPk(req.params.id,{include:[{model:User,attributes:['name','unit']},{model:Group,attributes:['name']}]}); if(!track||!canAccessRecord(req.session.user,track)) return res.status(404).render('error',{message:'Không tìm thấy tracklog.'}); const waypoints=await Waypoint.findAll({where:dataScope(req.session.user),order:[['createdAt','ASC']]}); res.render('track-report',{track,waypoints}); });

app.get('/map', requireAuth, (req, res) => res.render('map'));

function canonicalAdministrativeName(value='') {
  const text=deepRepairVietnamese(String(value||'')).trim();
  const plain=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if(plain.includes('hoang sa')) return 'Đặc khu Hoàng Sa';
  if(plain.includes('truong sa')) return 'Đặc khu Trường Sa';
  return text;
}
function normalizeAdministrativeUnit(unit={}) {
  const result={...unit};
  for(const key of ['name','ward_name','province_name','new_name','old_name']) if(result[key]) result[key]=canonicalAdministrativeName(result[key]);
  return result;
}
const specialUnitCache={expiresAt:0,value:null};
async function loadSpecialAdministrativeUnits(){
  if(specialUnitCache.value&&specialUnitCache.expiresAt>Date.now()) return specialUnitCache.value;
  const fallback=[{name:'Đặc khu Hoàng Sa',provinceName:'Thành phố Đà Nẵng'},{name:'Đặc khu Trường Sa',provinceName:'Tỉnh Khánh Hòa'}];
  try{
    const results=await Promise.all(['Hoang Sa','Truong Sa'].map(q=>fetchJsonWithTimeout(`${ADMIN_API_BASE}/api/search?q=${encodeURIComponent(q)}`,{},10000)));
    const found=[];
    for(const payload of results){
      const items=Array.isArray(payload)?payload:(payload?.results||payload?.data||[]);
      for(const raw of items){
        const item=normalizeAdministrativeUnit(raw);
        const name=canonicalAdministrativeName(item.ward_name||item.name||'');
        if(name==='Đặc khu Hoàng Sa'||name==='Đặc khu Trường Sa') found.push({...item,name});
      }
    }
    const unique=[...new Map(found.map(x=>[x.name,x])).values()];
    specialUnitCache.value=unique.length?unique:fallback;
  }catch(error){specialUnitCache.value=fallback;}
  specialUnitCache.expiresAt=Date.now()+24*60*60*1000;
  return specialUnitCache.value;
}
app.get('/api/admin-units/hue', requireAuth, async (req, res) => {
  try {
    const [wards,specialUnits] = await Promise.all([
      fetchJsonWithTimeout(`${ADMIN_API_BASE}/api/wards?province_code=${HUE_PROVINCE_CODE}`),
      loadSpecialAdministrativeUnits()
    ]);
    const normalized=Array.isArray(wards)?wards.map(normalizeAdministrativeUnit):[];
    res.json({ provinceCode:HUE_PROVINCE_CODE, provinceName:'Thành phố Huế', wards:normalized, specialUnits, source:'34tinhthanh.com', fetchedAt:new Date().toISOString() });
  } catch (error) {
    console.error('Không tải được đơn vị hành chính Huế:', error.message);
    res.status(502).json({ error:'Không tải được danh sách phường/xã từ 34tinhthanh.com.', wards:[], specialUnits:await loadSpecialAdministrativeUnits() });
  }
});


app.get('/api/fire-weather', requireAuth, async (req, res) => {
  const rawLatitude = req.query.latitude ?? req.query.lat;
  const rawLongitude = req.query.longitude ?? req.query.lng ?? req.query.lon;
  let latitude = Number(rawLatitude);
  let longitude = Number(rawLongitude);
  let coordinateFallback = false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    latitude = 16.4637;
    longitude = 107.5909;
    coordinateFallback = true;
  }
  const roundedLat = latitude.toFixed(3), roundedLng = longitude.toFixed(3);
  const cacheKey = `${roundedLat},${roundedLng}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return res.json({ ...cached.value, cached: true });
  try {
    const url = new URL('/v1/forecast', WEATHER_API_BASE);
    url.searchParams.set('latitude', roundedLat); url.searchParams.set('longitude', roundedLng);
    url.searchParams.set('timezone', 'Asia/Bangkok'); url.searchParams.set('past_days', '1'); url.searchParams.set('forecast_days', '4');
    url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m');
    url.searchParams.set('hourly', 'temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m');
    const payload = await fetchJsonWithTimeout(url.toString(), { headers: { Accept: 'application/json', 'User-Agent': 'HUFM/1.1' } }, 18000);
    const parsed = parseOpenMeteo(payload);
    const value = { source:'Open-Meteo', latitude, longitude, coordinateFallback, timezone:payload.timezone, fetchedAt:new Date().toISOString(), disclaimer:'Chỉ số nguy cơ do HUFM ước tính từ thời tiết, phục vụ hỗ trợ nghiệp vụ; không thay thế cấp dự báo cháy rừng chính thức.', ...parsed };
    weatherCache.set(cacheKey, { expiresAt:Date.now()+WEATHER_CACHE_MINUTES*60*1000, value });
    res.json(value);
  } catch (error) {
    console.error('Không tải được thời tiết:', error.message);
    res.status(502).json({ error:'Không thể tải dữ liệu thời tiết. Vui lòng thử lại khi có mạng.' });
  }
});

app.get('/api/fire-hotspots', requireAuth, async (req, res) => {
  if (!FIRMS_MAP_KEY) return res.json({ configured:false, source:'NASA FIRMS', message:'Chưa cấu hình FIRMS_MAP_KEY.', features:[] });
  const west=Number(req.query.west||107.0), south=Number(req.query.south||15.8), east=Number(req.query.east||108.4), north=Number(req.query.north||16.9);
  try {
    const area=`${west},${south},${east},${north}`;
    const url=`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(FIRMS_MAP_KEY)}/${encodeURIComponent(FIRMS_SOURCE)}/${area}/2`;
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),18000);
    const response=await fetch(url,{signal:controller.signal,headers:{'User-Agent':'HUFM/1.1'}}); clearTimeout(timer);
    if(!response.ok) throw new Error(`NASA FIRMS HTTP ${response.status}`);
    const text=await response.text(); const lines=text.trim().split(/\r?\n/); if(lines.length<2) return res.json({configured:true,source:'NASA FIRMS',features:[],fetchedAt:new Date().toISOString()});
    const headers=lines[0].split(','); const idx=n=>headers.indexOf(n); const features=[];
    for(const line of lines.slice(1)){const c=line.split(','); const lat=Number(c[idx('latitude')]),lng=Number(c[idx('longitude')]); if(!Number.isFinite(lat)||!Number.isFinite(lng))continue; features.push({type:'Feature',geometry:{type:'Point',coordinates:[lng,lat]},properties:{source:'NASA FIRMS',confidence:c[idx('confidence')],acq_date:c[idx('acq_date')],acq_time:c[idx('acq_time')],frp:c[idx('frp')],satellite:c[idx('satellite')]}})}
    res.json({configured:true,source:'NASA FIRMS',features,fetchedAt:new Date().toISOString()});
  } catch(error){console.error('NASA FIRMS:',error.message);res.status(502).json({error:'Không thể tải điểm nóng vệ tinh NASA FIRMS.',features:[]});}
});

app.get('/api/fire-alerts', requireAuth, async (req, res) => {
  const wardCode = String(req.query.ward_code || '').trim();
  if (!PCCCR_API_URL) return res.json({
    configured: false,
    source: 'v2.pcccr.vn',
    sourceUrl: PCCCR_PORTAL_URL,
    message: 'Chưa cấu hình endpoint API PCCCR. Hãy mở bản đồ chính thức hoặc thiết lập PCCCR_API_URL trên Render.',
    geojson: { type: 'FeatureCollection', features: [] },
    fetchedAt: new Date().toISOString()
  });
  try {
    const url = new URL(PCCCR_API_URL);
    url.searchParams.set('province_code', HUE_PROVINCE_CODE);
    if (wardCode) url.searchParams.set('ward_code', wardCode);
    const headers = { Accept: 'application/json' };
    if (PCCCR_API_TOKEN) headers.Authorization = `Bearer ${PCCCR_API_TOKEN}`;
    const payload = await fetchJsonWithTimeout(url.toString(), { headers }, 20000);
    const geojson = normalizeFireAlerts(payload);
    res.json({ configured: true, source: 'v2.pcccr.vn', sourceUrl: PCCCR_PORTAL_URL, geojson, count: geojson.features.length, fetchedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Không tải được cảnh báo PCCCR:', error.message);
    res.status(502).json({ error: 'Không thể kết nối nguồn cảnh báo cháy rừng.', sourceUrl: PCCCR_PORTAL_URL, geojson: { type: 'FeatureCollection', features: [] } });
  }
});



app.get('/api/app-config', requireAuth, (req, res) => {
  res.json({ offlineTileUrl: OFFLINE_TILE_URL, offlineTileMax: OFFLINE_TILE_MAX });
});

app.post('/api/sync', requireAuth, async (req, res) => {
  const records = Array.isArray(req.body.records) ? req.body.records.slice(0, 200) : [];
  const results = [];
  for (const item of records) {
    const clientId = String(item.clientId || '').slice(0, 120);
    const type = item.type;
    const payload = item.payload || {};
    if (!clientId || !['waypoint','track'].includes(type)) { results.push({ clientId, ok:false, error:'Bản ghi đồng bộ không hợp lệ.' }); continue; }
    const existing = await SyncReceipt.findOne({ where: { clientId } });
    if (existing) { results.push({ clientId, ok:true, duplicate:true, serverRecordId:existing.serverRecordId }); continue; }
    try {
      let record;
      if (type === 'waypoint') {
        const lat=Number(payload.latitude), lng=Number(payload.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Tọa độ không hợp lệ.');
        record = await Waypoint.create({ name:(payload.name||'Điểm offline').trim(), description:payload.description||'', category:payload.category||'Khác', latitude:lat, longitude:lng, accuracy:Number(payload.accuracy)||null, userId:req.session.user.id, groupId:req.session.user.groupId||null });
      } else {
        const points = Array.isArray(payload.points) ? payload.points.filter(q=>Number.isFinite(Number(q.lat))&&Number.isFinite(Number(q.lng))).map(q=>({lat:Number(q.lat),lng:Number(q.lng),accuracy:Number(q.accuracy)||null,time:q.time||new Date().toISOString()})) : [];
        if (points.length < 2) throw new Error('Tracklog cần ít nhất 2 điểm.');
        let distance=0; for(let i=1;i<points.length;i++) distance += haversine(points[i-1],points[i]);
        record = await Tracklog.create({ name:(payload.name||'Track offline').trim(), description:payload.description||'', points, distanceMeters:Math.round(distance), startedAt:points[0].time, endedAt:points.at(-1).time, userId:req.session.user.id, groupId:req.session.user.groupId||null });
      }
      await SyncReceipt.create({ clientId, recordType:type, serverRecordId:record.id });
      results.push({ clientId, ok:true, serverRecordId:record.id });
    } catch (error) { results.push({ clientId, ok:false, error:error.message }); }
  }
  res.json({ results, synced: results.filter(x=>x.ok).length });
});

app.get('/api/map-data', requireAuth, async (req, res) => {
  const scope = dataScope(req.session.user);
  const [waypoints, tracks] = await Promise.all([
    Waypoint.findAll({ where: scope, include: [{ model: User, attributes: ['id','name'] }, { model: Group, attributes: ['id','name'] }], order: [['createdAt','DESC']] }),
    Tracklog.findAll({ where: scope, include: [{ model: User, attributes: ['id','name'] }, { model: Group, attributes: ['id','name'] }], order: [['createdAt','DESC']] })
  ]);
  res.json({ waypoints, tracks });
});

app.post('/api/waypoints', requireAuth, async (req, res) => {
  const lat = Number(req.body.latitude), lng = Number(req.body.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'Tọa độ không hợp lệ.' });
  const wp = await Waypoint.create({
    name: (req.body.name || 'Điểm mới').trim(), description: req.body.description || '', category: req.body.category || 'Khác',
    latitude: lat, longitude: lng, accuracy: Number(req.body.accuracy) || null,
    userId: req.session.user.id, groupId: req.session.user.groupId || null
  });
  await writeAudit(req,'create','waypoint',wp.id,null,wp.toJSON()); res.status(201).json(wp);
});

app.put('/api/waypoints/:id', requireAuth, async (req, res) => {
  const wp = await Waypoint.findByPk(req.params.id);
  if (!wp) return res.status(404).json({ error: 'Không tìm thấy.' });
  const u = req.session.user;
  if (!(u.role === 'admin' || (u.role === 'mod' && wp.groupId === u.groupId) || wp.userId === u.id)) return res.status(403).json({ error: 'Không có quyền.' });
  await wp.update({ name: req.body.name || wp.name, description: req.body.description ?? wp.description, category: req.body.category || wp.category });
  res.json(wp);
});

app.delete('/api/waypoints/:id', requireAuth, async (req, res) => {
  const wp = await Waypoint.findByPk(req.params.id);
  if (!wp) return res.status(404).json({ error: 'Không tìm thấy.' });
  const u = req.session.user;
  if (!(u.role === 'admin' || (u.role === 'mod' && wp.groupId === u.groupId) || wp.userId === u.id)) return res.status(403).json({ error: 'Không có quyền.' });
  await wp.destroy(); res.json({ ok: true, message: 'Đã xóa waypoint thành công.' });
});

app.post('/api/tracks', requireAuth, async (req, res) => {
  const points = Array.isArray(req.body.points) ? req.body.points.filter(p => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))).map(p => ({ lat:Number(p.lat), lng:Number(p.lng), accuracy:Number(p.accuracy)||null, time:p.time||new Date().toISOString() })) : [];
  if (points.length < 2) return res.status(400).json({ error: 'Tracklog cần ít nhất 2 điểm.' });
  let distance = 0; for (let i=1;i<points.length;i++) distance += haversine(points[i-1], points[i]);
  const track = await Tracklog.create({ name: (req.body.name || `Track ${new Date().toLocaleString('vi-VN')}`).trim(), description: req.body.description || '', points, distanceMeters: Math.round(distance), startedAt: points[0].time, endedAt: points.at(-1).time, userId: req.session.user.id, groupId: req.session.user.groupId || null });
  await writeAudit(req,'create','tracklog',track.id,null,track.toJSON()); res.status(201).json(track);
});

app.put('/api/tracks/:id', requireAuth, async (req, res) => {
  const track = await Tracklog.findByPk(req.params.id);
  if (!track) return res.status(404).json({ error: 'Không tìm thấy tracklog.' });
  const u = req.session.user;
  if (!(u.role === 'admin' || (u.role === 'mod' && track.groupId === u.groupId) || track.userId === u.id)) return res.status(403).json({ error: 'Không có quyền chỉnh sửa.' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Tên tracklog không được để trống.' });
  await track.update({ name: name.slice(0, 180), description: String(req.body.description ?? '').slice(0, 4000) });
  res.json({ ok: true, track });
});

app.delete('/api/tracks/:id', requireAuth, async (req, res) => {
  const track = await Tracklog.findByPk(req.params.id);
  if (!track) return res.status(404).json({ error: 'Không tìm thấy.' });
  const u = req.session.user;
  if (!(u.role === 'admin' || (u.role === 'mod' && track.groupId === u.groupId) || track.userId === u.id)) return res.status(403).json({ error: 'Không có quyền.' });
  await track.destroy(); res.json({ ok: true, message: 'Đã xóa tracklog thành công.' });
});

// Endpoint POST dự phòng cho Safari/PWA hoặc proxy chặn phương thức DELETE.
app.post('/api/waypoints/:id/delete', requireAuth, async (req, res) => {
  const wp = await Waypoint.findByPk(req.params.id);
  if (!wp) return res.status(404).json({ error: 'Không tìm thấy waypoint.' });
  const u = req.session.user;
  if (!(u.role === 'admin' || (u.role === 'mod' && wp.groupId === u.groupId) || wp.userId === u.id)) return res.status(403).json({ error: 'Không có quyền xóa.' });
  await wp.destroy(); res.json({ ok: true, message: 'Đã xóa waypoint thành công.' });
});
app.post('/api/tracks/:id/delete', requireAuth, async (req, res) => {
  const track = await Tracklog.findByPk(req.params.id);
  if (!track) return res.status(404).json({ error: 'Không tìm thấy tracklog.' });
  const u = req.session.user;
  if (!(u.role === 'admin' || (u.role === 'mod' && track.groupId === u.groupId) || track.userId === u.id)) return res.status(403).json({ error: 'Không có quyền xóa.' });
  await track.destroy(); res.json({ ok: true, message: 'Đã xóa tracklog thành công.' });
});


app.get('/api/tracks/:id/export/:format', requireAuth, async (req, res) => {
  const track = await Tracklog.findByPk(req.params.id);
  if (!track) return res.status(404).json({ error: 'Không tìm thấy tracklog.' });
  if (!canAccessRecord(req.session.user, track)) return res.status(403).json({ error: 'Không có quyền.' });
  const waypoints = await Waypoint.findAll({ where: dataScope(req.session.user), order: [['createdAt','ASC']] });
  const format = String(req.params.format || '').toLowerCase();
  const base = `${safeFilename(track.name)}-kem-waypoint`;
  if (format === 'geojson') {
    res.setHeader('Content-Disposition', `attachment; filename="${base}.geojson"`);
    return res.type('application/geo+json').send(JSON.stringify(trackExportGeoJSON(track, waypoints), null, 2));
  }
  if (format === 'gpx') {
    res.setHeader('Content-Disposition', `attachment; filename="${base}.gpx"`);
    return res.type('application/gpx+xml').send(trackExportGpx(track, waypoints));
  }
  if (format === 'kml') {
    res.setHeader('Content-Disposition', `attachment; filename="${base}.kml"`);
    return res.type('application/vnd.google-earth.kml+xml').send(trackExportKml(track, waypoints));
  }
  return res.status(400).json({ error: 'Định dạng xuất không được hỗ trợ.' });
});

app.get('/api/export/geojson', requireAuth, async (req, res) => {
  const scope = dataScope(req.session.user);
  const [wps, tracks] = await Promise.all([Waypoint.findAll({ where: scope }), Tracklog.findAll({ where: scope })]);
  const features = [
    ...wps.map(w => ({ type:'Feature', geometry:{type:'Point',coordinates:[w.longitude,w.latitude]}, properties:{kind:'waypoint',name:w.name,description:w.description,category:w.category,createdAt:w.createdAt} })),
    ...tracks.map(t => ({ type:'Feature', geometry:{type:'LineString',coordinates:t.points.map(p=>[p.lng,p.lat])}, properties:{kind:'tracklog',name:t.name,description:t.description,distanceMeters:t.distanceMeters,createdAt:t.createdAt} }))
  ];
  res.setHeader('Content-Disposition', 'attachment; filename="hue-forest-data.geojson"');
  res.type('application/geo+json').send(JSON.stringify({ type:'FeatureCollection', features }, null, 2));
});


app.get('/api/layers', requireAuth, async (req, res) => {
  const layers = await MapLayer.findAll({
    where: dataScope(req.session.user),
    attributes: ['id','name','description','layerType','originalFilename','sizeBytes','metadata','userId','groupId','createdAt'],
    include: [{ model: User, attributes: ['id','name'] }, { model: Group, attributes: ['id','name'] }],
    order: [['createdAt','DESC']]
  });
  res.json(layers.map(layer => deepRepairVietnamese(layer.toJSON())));
});

app.post('/api/layers', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Vui lòng chọn tệp bản đồ.' });
    const originalFilename = repairUploadedFilename(req.file.originalname || '');
    const ext = path.extname(originalFilename).toLowerCase();
    const type = ext === '.geojson' || ext === '.json' ? 'geojson' : ext === '.kml' ? 'kml' : ext === '.mbtiles' ? 'mbtiles' : null;
    if (!type) return res.status(400).json({ error: 'Chỉ hỗ trợ GeoJSON, KML và MBTiles.' });
    let vectorData = null, fileData = null, metadata = {};
    if (type === 'geojson') {
      vectorData = normalizeGeoJSON(JSON.parse(req.file.buffer.toString('utf8')));
      metadata.featureCount = vectorData.features.length;
    } else if (type === 'kml') {
      vectorData = normalizeGeoJSON(kmlToGeoJSON(decodeKmlBuffer(req.file.buffer)));
      metadata.featureCount = vectorData.features.length;
    } else {
      const SQL = await getSqlJs();
      const db = new SQL.Database(new Uint8Array(req.file.buffer));
      try {
        const tables = sqlRows(db, "SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
        if (!tables.includes('tiles')) throw new Error('MBTiles không có bảng tiles.');
        const rows = tables.includes('metadata') ? sqlRows(db, 'SELECT name, value FROM metadata') : [];
        metadata = Object.fromEntries(rows.map(r => [r.name, r.value]));
        metadata.tileCount = Number(sqlRows(db, 'SELECT COUNT(*) AS count FROM tiles')[0]?.count || 0);
      } finally { db.close(); }
      fileData = req.file.buffer;
    }
    const layer = await MapLayer.create({
      name: repairVietnameseMojibake((req.body.name || path.basename(originalFilename, ext)).trim()),
      description: repairVietnameseMojibake((req.body.description || '').trim()), layerType: type,
      originalFilename, mimeType: req.file.mimetype,
      sizeBytes: req.file.size, vectorData, fileData, metadata,
      userId: req.session.user.id, groupId: req.session.user.groupId || null
    });
    res.status(201).json({ id: layer.id, name: layer.name, layerType: layer.layerType });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || 'Không thể xử lý tệp bản đồ.' });
  }
});

app.get('/api/layers/:id/data', requireAuth, async (req, res) => {
  const layer = await MapLayer.findByPk(req.params.id, { attributes: ['id','layerType','vectorData','userId','groupId'] });
  if (!layer) return res.status(404).json({ error: 'Không tìm thấy lớp bản đồ.' });
  if (!canAccessRecord(req.session.user, layer)) return res.status(403).json({ error: 'Không có quyền.' });
  if (layer.layerType === 'mbtiles') return res.status(400).json({ error: 'Lớp MBTiles được truy cập qua tile endpoint.' });
  res.json(deepRepairVietnamese(layer.vectorData));
});

app.get('/api/layers/:id/tiles/:z/:x/:y.:ext', requireAuth, async (req, res) => {
  const layer = await MapLayer.findByPk(req.params.id, { attributes: ['id','layerType','fileData','metadata','userId','groupId'] });
  if (!layer || layer.layerType !== 'mbtiles') return res.status(404).end();
  if (!canAccessRecord(req.session.user, layer)) return res.status(403).end();
  const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
  if (![z,x,y].every(Number.isInteger)) return res.status(400).end();
  const tmsY = Math.pow(2, z) - 1 - y;
  const db = await getMbtilesDb(layer);
  const row = sqlRows(db, 'SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?', [z, x, tmsY])[0];
  if (!row) return res.status(404).end();
  let format = String(layer.metadata?.format || req.params.ext || 'png').toLowerCase();
  const contentTypes = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', pbf:'application/x-protobuf', mvt:'application/vnd.mapbox-vector-tile' };
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type(contentTypes[format] || 'application/octet-stream').send(Buffer.from(row.tile_data));
});

async function deleteMapLayer(req, res) {
  try {
    const layerId = Number(req.params.id);
    if (!Number.isInteger(layerId) || layerId <= 0) return res.status(400).json({ error: 'Mã lớp bản đồ không hợp lệ.' });
    const layer = await MapLayer.findByPk(layerId);
    if (!layer) return res.status(404).json({ error: 'Không tìm thấy lớp bản đồ hoặc lớp đã được xóa.' });
    if (!canAccessRecord(req.session.user, layer)) return res.status(403).json({ error: 'Bạn không có quyền xóa lớp bản đồ này.' });

    const db = mbtilesCache.get(layer.id);
    if (db) {
      try { db.close(); } catch (error) { console.warn('Không thể đóng MBTiles cache:', error.message); }
      mbtilesCache.delete(layer.id);
    }

    const deleted = await MapLayer.destroy({ where: { id: layer.id } });
    if (!deleted) return res.status(409).json({ error: 'Lớp bản đồ chưa được xóa. Vui lòng thử lại.' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, id: layer.id, message: 'Đã xóa lớp bản đồ thành công.' });
  } catch (error) {
    console.error('deleteMapLayer error:', error);
    return res.status(500).json({ error: error.message || 'Không thể xóa lớp bản đồ.' });
  }
}

app.delete('/api/layers/:id', requireAuth, deleteMapLayer);
// Endpoint POST dự phòng cho Safari/PWA hoặc proxy không chuyển tiếp phương thức DELETE ổn định.
app.post('/api/layers/:id/delete', requireAuth, deleteMapLayer);

app.get('/admin/users', requireRole('admin'), async (req, res) => {
  const users = await User.findAll({ include: Group, order: [['createdAt','DESC']] });
  const groups = await Group.findAll({ order: [['name','ASC']] });
  const importResult = req.session.importResult || null;
  delete req.session.importResult;
  res.render('admin-users', { users, groups, importResult });
});
app.post('/admin/users/create', requireRole('admin'), async (req, res) => {
  try {
    const name = repairVietnameseMojibake(req.body.name || '').trim();
    const username = normalizeUsername(req.body.username || req.body.email);
    const email = loginKeyToEmail(username);
    const password = String(req.body.password || '');
    const role = ['user','mod'].includes(req.body.role) ? req.body.role : 'user';
    if (!name || username.length < 3 || password.length < 8) throw new Error('Họ tên, tên đăng nhập từ 3 ký tự và mật khẩu từ 8 ký tự là bắt buộc.');
    if (await User.count({ where:{ email } })) throw new Error('Tên đăng nhập đã tồn tại.');
    const groupId = req.body.groupId ? Number(req.body.groupId) : null;
    if (groupId && !(await Group.findByPk(groupId))) throw new Error('Nhóm được chọn không tồn tại.');
    await User.create({ name, email, passwordHash:await bcrypt.hash(password,12), phone:repairVietnameseMojibake(req.body.phone||'').trim(), unit:repairVietnameseMojibake(req.body.unit||'').trim(), role, status:'approved', groupId });
    flash(req,'success',`Đã tạo tài khoản ${username} với vai trò ${role}.`);
  } catch (error) { flash(req,'error',error.message || 'Không thể tạo tài khoản.'); }
  res.redirect('/admin/users');
});
app.post('/admin/users/import', requireRole('admin'), csvUpload.single('csvFile'), async (req, res) => {
  const result = { created:[], skipped:[], total:0 };
  try {
    if (!req.file) throw new Error('Vui lòng chọn file CSV.');
    if (!/\.csv$/i.test(req.file.originalname || '')) throw new Error('Chỉ chấp nhận file có đuôi .csv.');
    const rows = parseCsv(decodeCsvBuffer(req.file.buffer));
    if (!rows.length) throw new Error('File CSV không có dòng dữ liệu.');
    if (rows.length > 1000) throw new Error('Mỗi lần chỉ nhập tối đa 1.000 tài khoản.');
    result.total = rows.length;
    const groups = await Group.findAll();
    const groupMap = new Map(groups.map(g=>[repairVietnameseMojibake(g.name).trim().toLowerCase(),g.id]));
    const emails = rows.map(r=>loginKeyToEmail(r.data.username||r.data.email)).filter(Boolean);
    const existing = new Set((await User.findAll({ where:{email:{[Op.in]:emails}}, attributes:['email'] })).map(u=>u.email.toLowerCase()));
    const seen = new Set();
    for (const row of rows) {
      const d=row.data, name=repairVietnameseMojibake(d.name||'').trim(), username=normalizeUsername(d.username||d.email), email=loginKeyToEmail(username), password=String(d.password||'');
      const role=String(d.role||'user').trim().toLowerCase(), status=String(d.status||'approved').trim().toLowerCase();
      const errors=[];
      if(!name) errors.push('thiếu họ tên');
      if(username.length<3) errors.push('tên đăng nhập phải có ít nhất 3 ký tự');
      if(password.length<8) errors.push('mật khẩu dưới 8 ký tự');
      if(!['user','mod'].includes(role)) errors.push('vai trò chỉ được user hoặc mod');
      if(!['approved','pending'].includes(status)) errors.push('trạng thái chỉ được approved hoặc pending');
      if(existing.has(email)||seen.has(email)) errors.push('tên đăng nhập đã tồn tại hoặc bị trùng trong file');
      let groupId=null; const groupName=repairVietnameseMojibake(d.group_name||'').trim();
      if(groupName){ groupId=groupMap.get(groupName.toLowerCase())||null; if(!groupId) errors.push(`không tìm thấy nhóm “${groupName}”`); }
      if(errors.length){ result.skipped.push({line:row.line,email:username||'(trống)',reason:errors.join('; ')}); continue; }
      try {
        await User.create({ name,email,passwordHash:await bcrypt.hash(password,12),role,status,phone:repairVietnameseMojibake(d.phone||'').trim(),unit:repairVietnameseMojibake(d.unit||'').trim(),groupId });
        seen.add(email); existing.add(email); result.created.push({line:row.line,email:username,role,group:groupName||''});
      } catch(error){ result.skipped.push({line:row.line,email,reason:error.name==='SequelizeUniqueConstraintError'?'tên đăng nhập đã tồn tại':'lỗi cơ sở dữ liệu'}); }
    }
    req.session.importResult=result;
    flash(req,'success',`Đã tạo ${result.created.length}/${result.total} tài khoản; bỏ qua ${result.skipped.length} dòng.`);
  } catch(error) { flash(req,'error',error.message || 'Không thể nhập CSV.'); }
  res.redirect('/admin/users');
});
app.post('/admin/users/:id/approve', requireRole('admin'), async (req, res) => { await User.update({ status:'approved' }, { where:{ id:req.params.id } }); flash(req,'success','Đã duyệt tài khoản.'); res.redirect('/admin/users'); });
app.post('/admin/users/:id/reject', requireRole('admin'), async (req, res) => { await User.update({ status:'rejected' }, { where:{ id:req.params.id } }); flash(req,'success','Đã từ chối tài khoản.'); res.redirect('/admin/users'); });
app.post('/admin/users/:id/update', requireRole('admin'), async (req, res) => {
  const user = await User.findByPk(req.params.id); if (!user) return res.redirect('/admin/users');
  const role = ['admin','mod','user'].includes(req.body.role) ? req.body.role : user.role;
  await user.update({ name:req.body.name || user.name, phone:req.body.phone || '', unit:req.body.unit || '', role, groupId:req.body.groupId ? Number(req.body.groupId) : null });
  flash(req,'success','Đã cập nhật thành viên.'); res.redirect('/admin/users');
});

app.get('/admin/groups', requireRole('admin'), async (req, res) => {
  const groups = await Group.findAll({ include:[{ model:User, attributes:['id','name','email','role'] }], order:[['name','ASC']] });
  res.render('admin-groups', { groups });
});
app.post('/admin/groups', requireRole('admin'), async (req, res) => {
  try { await Group.create({ name:req.body.name.trim(), description:req.body.description || '' }); flash(req,'success','Đã tạo nhóm.'); }
  catch { flash(req,'error','Không thể tạo nhóm; tên nhóm có thể đã tồn tại.'); }
  res.redirect('/admin/groups');
});
app.post('/admin/groups/:id/update', requireRole('admin'), async (req, res) => { await Group.update({ name:req.body.name, description:req.body.description || '' }, { where:{id:req.params.id} }); flash(req,'success','Đã cập nhật nhóm.'); res.redirect('/admin/groups'); });
app.post('/admin/groups/:id/delete', requireRole('admin'), async (req, res) => {
  const count = await User.count({ where:{groupId:req.params.id} });
  if (count) flash(req,'error','Không thể xóa nhóm đang có thành viên.'); else { await Group.destroy({ where:{id:req.params.id} }); flash(req,'success','Đã xóa nhóm.'); }
  res.redirect('/admin/groups');
});

app.get('/group/members', requireRole('mod'), async (req, res) => {
  const users = await User.findAll({ where:{groupId:req.session.user.groupId}, order:[['name','ASC']] });
  res.render('group-members', { users });
});
app.post('/group/members/:id/update', requireRole('mod'), async (req, res) => {
  const member = await User.findOne({ where:{id:req.params.id, groupId:req.session.user.groupId} });
  if (!member) return res.status(403).render('error',{message:'Không có quyền chỉnh sửa thành viên này.'});
  await member.update({ name:req.body.name || member.name, phone:req.body.phone || '', unit:req.body.unit || '' });
  flash(req,'success','Đã cập nhật thông tin thành viên.'); res.redirect('/group/members');
});

app.use((req, res) => res.status(404).render('error', { message:'Không tìm thấy trang.' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).render('error', { message:'Đã xảy ra lỗi hệ thống.' }); });

async function bootstrap() {
  await sequelize.authenticate();
  await sequelize.sync();
  await sessionStore.sync();
  // ADMIN_EMAIL vẫn được hỗ trợ để tương thích cấu hình cũ. Nếu người quản trị
  // nhập chỉ một tên đăng nhập (ví dụ: admin), tự đổi thành admin@hufm.local.
  const adminLoginInput = process.env.ADMIN_USERNAME || process.env.ADMIN_EMAIL || 'admin@kiemlamhue.gov.vn';
  const email = loginKeyToEmail(adminLoginInput);
  if (!email) throw new Error('ADMIN_USERNAME hoặc ADMIN_EMAIL không hợp lệ.');
  const configuredAdminPassword = String(process.env.ADMIN_PASSWORD || 'ChangeMe123!');
  const [admin, created] = await User.findOrCreate({
    where:{email},
    defaults:{
      name:process.env.ADMIN_NAME || 'Quản trị hệ thống',
      passwordHash:await bcrypt.hash(configuredAdminPassword,12),
      role:'admin',
      status:'approved'
    }
  });
  if (!created) {
    const updates = {};
    if (admin.role !== 'admin') updates.role = 'admin';
    if (admin.status !== 'approved') updates.status = 'approved';
    // ADMIN_PASSWORD trên Render là nguồn mật khẩu quản trị chính thức.
    // Đồng bộ lại hash sau mỗi lần deploy để tránh tài khoản admin giữ mật khẩu cũ.
    if (!(await bcrypt.compare(configuredAdminPassword, admin.passwordHash))) {
      updates.passwordHash = await bcrypt.hash(configuredAdminPassword, 12);
    }
    if (Object.keys(updates).length) await admin.update(updates);
  }
  app.listen(PORT, () => console.log(`Hue Forest Manager running on port ${PORT}`));
}
bootstrap().catch(err => { console.error('Startup failed:', err); process.exit(1); });
