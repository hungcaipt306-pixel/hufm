require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const { Sequelize, DataTypes, Op } = require('sequelize');
const SequelizeStoreFactory = require('connect-session-sequelize');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

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
      connectSrc: ["'self'"],
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
