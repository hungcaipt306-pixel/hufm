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
const mbtilesCache = new Map();

const HUE_PROVINCE_CODE = '46';
const ADMIN_API_BASE = process.env.ADMIN_API_BASE || 'https://34tinhthanh.com';
const PCCCR_PORTAL_URL = process.env.PCCCR_PORTAL_URL || 'https://v2.pcccr.vn/diem-chay';
const PCCCR_API_URL = process.env.PCCCR_API_URL || '';
const PCCCR_API_TOKEN = process.env.PCCCR_API_TOKEN || '';

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Nguồn dữ liệu trả về HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
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
  email: { type: DataTypes.STRING, allowNull: false, unique: true, validate: { isEmail: true } },
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

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org'],
      connectSrc: ["'self'", 'blob:'],
      fontSrc: ["'self'", 'data:']
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

const SequelizeStore = SequelizeStoreFactory(session.Store);
const sessionStore = new SequelizeStore({ db: sequelize });
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-change-this-secret',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 }
}));

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
function firstText(node, tag) {
  const item = node.getElementsByTagName(tag)[0];
  return item ? String(item.textContent || '').trim() : '';
}
function kmlToGeoJSON(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const parseErrors = doc.getElementsByTagName('parsererror');
  if (parseErrors.length) throw new Error('KML không hợp lệ.');
  const features = [];
  const placemarks = Array.from(doc.getElementsByTagName('Placemark'));
  for (const placemark of placemarks) {
    const properties = { name: firstText(placemark, 'name'), description: firstText(placemark, 'description') };
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
app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));

app.get('/register', (req, res) => res.render('register'));
app.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone, unit } = req.body;
    if (!name || !email || !password || password.length < 8) {
      flash(req, 'error', 'Vui lòng nhập đủ thông tin; mật khẩu tối thiểu 8 ký tự.');
      return res.redirect('/register');
    }
    const exists = await User.findOne({ where: { email: email.trim().toLowerCase() } });
    if (exists) { flash(req, 'error', 'Email đã được sử dụng.'); return res.redirect('/register'); }
    await User.create({ name: name.trim(), email: email.trim().toLowerCase(), passwordHash: await bcrypt.hash(password, 12), phone, unit, role: 'user', status: 'pending' });
    flash(req, 'success', 'Đăng ký thành công. Tài khoản đang chờ quản trị viên phê duyệt.');
    res.redirect('/login');
  } catch (e) { console.error(e); flash(req, 'error', 'Không thể đăng ký tài khoản.'); res.redirect('/register'); }
});

app.get('/login', (req, res) => res.render('login'));
app.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const user = await User.findOne({ where: { email }, include: Group });
  if (!user || !(await bcrypt.compare(req.body.password || '', user.passwordHash))) {
    flash(req, 'error', 'Email hoặc mật khẩu không đúng.'); return res.redirect('/login');
  }
  if (user.status !== 'approved') {
    flash(req, 'error', user.status === 'pending' ? 'Tài khoản đang chờ phê duyệt.' : 'Tài khoản đã bị từ chối.'); return res.redirect('/login');
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, groupId: user.groupId, groupName: user.Group?.name || null };
  res.redirect('/dashboard');
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/dashboard', requireAuth, async (req, res) => {
  const scope = dataScope(req.session.user);
  const [waypointCount, trackCount, userCount, pendingCount] = await Promise.all([
    Waypoint.count({ where: scope }), Tracklog.count({ where: scope }),
    req.session.user.role === 'admin' ? User.count() : req.session.user.role === 'mod' ? User.count({ where: { groupId: req.session.user.groupId } }) : 1,
    req.session.user.role === 'admin' ? User.count({ where: { status: 'pending' } }) : 0
  ]);
  res.render('dashboard', { stats: { waypointCount, trackCount, userCount, pendingCount } });
});

app.get('/map', requireAuth, (req, res) => res.render('map'));

app.get('/api/admin-units/hue', requireAuth, async (req, res) => {
  try {
    const wards = await fetchJsonWithTimeout(`${ADMIN_API_BASE}/api/wards?province_code=${HUE_PROVINCE_CODE}`);
    res.json({ provinceCode: HUE_PROVINCE_CODE, provinceName: 'Thành phố Huế', wards: Array.isArray(wards) ? wards : [], source: '34tinhthanh.com', fetchedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Không tải được đơn vị hành chính Huế:', error.message);
    res.status(502).json({ error: 'Không tải được danh sách phường/xã từ 34tinhthanh.com.', wards: [] });
  }
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
  res.status(201).json(wp);
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
  await wp.destroy(); res.json({ ok: true });
});

app.post('/api/tracks', requireAuth, async (req, res) => {
  const points = Array.isArray(req.body.points) ? req.body.points.filter(p => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))).map(p => ({ lat:Number(p.lat), lng:Number(p.lng), accuracy:Number(p.accuracy)||null, time:p.time||new Date().toISOString() })) : [];
  if (points.length < 2) return res.status(400).json({ error: 'Tracklog cần ít nhất 2 điểm.' });
  let distance = 0; for (let i=1;i<points.length;i++) distance += haversine(points[i-1], points[i]);
  const track = await Tracklog.create({ name: (req.body.name || `Track ${new Date().toLocaleString('vi-VN')}`).trim(), description: req.body.description || '', points, distanceMeters: Math.round(distance), startedAt: points[0].time, endedAt: points.at(-1).time, userId: req.session.user.id, groupId: req.session.user.groupId || null });
  res.status(201).json(track);
});

app.delete('/api/tracks/:id', requireAuth, async (req, res) => {
  const track = await Tracklog.findByPk(req.params.id);
  if (!track) return res.status(404).json({ error: 'Không tìm thấy.' });
  const u = req.session.user;
  if (!(u.role === 'admin' || (u.role === 'mod' && track.groupId === u.groupId) || track.userId === u.id)) return res.status(403).json({ error: 'Không có quyền.' });
  await track.destroy(); res.json({ ok: true });
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
  res.json(layers);
});

app.post('/api/layers', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Vui lòng chọn tệp bản đồ.' });
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    const type = ext === '.geojson' || ext === '.json' ? 'geojson' : ext === '.kml' ? 'kml' : ext === '.mbtiles' ? 'mbtiles' : null;
    if (!type) return res.status(400).json({ error: 'Chỉ hỗ trợ GeoJSON, KML và MBTiles.' });
    let vectorData = null, fileData = null, metadata = {};
    if (type === 'geojson') {
      vectorData = normalizeGeoJSON(JSON.parse(req.file.buffer.toString('utf8')));
      metadata.featureCount = vectorData.features.length;
    } else if (type === 'kml') {
      vectorData = normalizeGeoJSON(kmlToGeoJSON(req.file.buffer.toString('utf8')));
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
      name: (req.body.name || path.basename(req.file.originalname, ext)).trim(),
      description: (req.body.description || '').trim(), layerType: type,
      originalFilename: req.file.originalname, mimeType: req.file.mimetype,
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
  res.json(layer.vectorData);
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

app.delete('/api/layers/:id', requireAuth, async (req, res) => {
  const layer = await MapLayer.findByPk(req.params.id);
  if (!layer) return res.status(404).json({ error: 'Không tìm thấy lớp bản đồ.' });
  if (!canAccessRecord(req.session.user, layer)) return res.status(403).json({ error: 'Không có quyền.' });
  const db = mbtilesCache.get(layer.id); if (db) { try { db.close(); } catch {} mbtilesCache.delete(layer.id); }
  await layer.destroy();
  res.json({ ok: true });
});

app.get('/admin/users', requireRole('admin'), async (req, res) => {
  const users = await User.findAll({ include: Group, order: [['createdAt','DESC']] });
  const groups = await Group.findAll({ order: [['name','ASC']] });
  res.render('admin-users', { users, groups });
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
  const email = (process.env.ADMIN_EMAIL || 'admin@kiemlamhue.gov.vn').toLowerCase();
  const [admin, created] = await User.findOrCreate({ where:{email}, defaults:{ name:process.env.ADMIN_NAME || 'Quản trị hệ thống', passwordHash:await bcrypt.hash(process.env.ADMIN_PASSWORD || 'ChangeMe123!',12), role:'admin', status:'approved' } });
  if (!created && (admin.role !== 'admin' || admin.status !== 'approved')) await admin.update({role:'admin',status:'approved'});
  app.listen(PORT, () => console.log(`Hue Forest Manager running on port ${PORT}`));
}
bootstrap().catch(err => { console.error('Startup failed:', err); process.exit(1); });
