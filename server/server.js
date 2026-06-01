/**
 * ═══════════════════════════════════════════════════════════
 *  NOQTA SERVER  —  نظام نقطة السيرفر
 *  Stack: Node.js + Express + sql.js (no compilation needed!)
 * ═══════════════════════════════════════════════════════════
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');
const cors      = require('cors');
const path      = require('path');
const crypto    = require('crypto');
const fs        = require('fs');
const initSqlJs = require('sql.js');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── Config ───────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'noqta_super_secret_2024_change_in_prod';
const DB_PATH    = process.env.DB_PATH    || path.join(__dirname, 'noqta.db');

// ── Helpers ──────────────────────────────────────────────────
const uid = () => crypto.randomUUID();
const now = () => Date.now();

// ── Database (sql.js — pure JS, no compilation) ──────────────
let db;

function dbSave() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch(e) { console.error('DB save error:', e.message); }
}

// Run a SELECT and return all rows as objects
function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Run a SELECT and return first row
function dbGet(sql, params = []) {
  const rows = dbAll(sql, params);
  return rows[0] || null;
}

// Run INSERT/UPDATE/DELETE
function dbRun(sql, params = []) {
  db.run(sql, params);
}

// Auto-save every 30 seconds
setInterval(dbSave, 30000);

// ── Schema ───────────────────────────────────────────────────
function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id            TEXT PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      owner_name    TEXT NOT NULL DEFAULT 'صاحب الكشف',
      header_color  TEXT NOT NULL DEFAULT '#1a1208',
      plan          TEXT NOT NULL DEFAULT 'monthly',
      sub_start     INTEGER,
      sub_end       INTEGER,
      is_active     INTEGER NOT NULL DEFAULT 1,
      notes         TEXT DEFAULT '',
      created_at    INTEGER NOT NULL,
      last_login    INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS people (
      id         TEXT PRIMARY KEY,
      client_id  TEXT NOT NULL,
      type       TEXT NOT NULL,
      name       TEXT NOT NULL,
      country    TEXT DEFAULT '',
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS entries (
      id         TEXT PRIMARY KEY,
      person_id  TEXT NOT NULL,
      client_id  TEXT NOT NULL,
      amount     REAL NOT NULL DEFAULT 0,
      occasion   TEXT DEFAULT '',
      date       TEXT DEFAULT '',
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS admin (
      id            INTEGER PRIMARY KEY,
      username      TEXT NOT NULL DEFAULT 'admin',
      password_hash TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_people_client ON people(client_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_entries_person ON entries(person_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_entries_client ON entries(client_id)`);
}

function seedAdmin() {
  const adminExists = dbGet('SELECT id FROM admin LIMIT 1');
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    dbRun('INSERT INTO admin (id, username, password_hash) VALUES (1, ?, ?)', ['admin', hash]);
    dbSave();
    console.log('✅ Admin created  — user: admin  pass: admin123');
    console.log('⚠️  Change admin password after first login!');
  }
}

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../app')));
app.use('/admin', express.static(path.join(__dirname, '../admin')));

function makeToken(payload, expiresIn = '30d') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'لازم تسجل دخول' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'الجلسة انتهت، سجل دخول مجدداً' }); }
}

function adminMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error();
    req.admin = payload; next();
  } catch { res.status(403).json({ error: 'صلاحيات أدمن مطلوبة' }); }
}

function isSubActive(client) {
  if (!client || !client.is_active) return false;
  if (!client.sub_end) return false;
  return Date.now() <= Number(client.sub_end);
}

// WebSocket broadcast
const wsClients = new Map();
function broadcast(clientId, payload) {
  const set = wsClients.get(clientId);
  if (!set) return;
  const msg = JSON.stringify(payload);
  set.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// ═══════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'أدخل اليوزر والباسورد' });
  const client = dbGet('SELECT * FROM clients WHERE username = ?', [username.trim().toLowerCase()]);
  if (!client || !bcrypt.compareSync(password, client.password_hash))
    return res.status(401).json({ error: 'يوزر أو باسورد غلط' });
  if (!client.is_active)
    return res.status(403).json({ error: 'الحساب موقوف، تواصل مع الأدمن' });
  if (!isSubActive(client)) {
    const end = client.sub_end ? new Date(Number(client.sub_end)).toLocaleDateString('ar-EG') : 'غير محدد';
    return res.status(403).json({ error: `الاشتراك انتهى بتاريخ ${end}، تواصل مع الأدمن لتجديده` });
  }
  dbRun('UPDATE clients SET last_login = ? WHERE id = ?', [now(), client.id]);
  dbSave();
  const token = makeToken({ id: client.id, username: client.username, role: 'client' });
  res.json({ token, profile: {
    id: client.id, username: client.username,
    owner_name: client.owner_name, header_color: client.header_color,
    sub_end: client.sub_end, plan: client.plan,
  }});
});

app.post('/api/auth/admin-login', (req, res) => {
  const { username, password } = req.body;
  const admin = dbGet('SELECT * FROM admin WHERE username = ?', [username]);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash))
    return res.status(401).json({ error: 'بيانات الأدمن غلط' });
  const token = makeToken({ id: 0, username: admin.username, role: 'admin' }, '7d');
  res.json({ token });
});

// ═══════════════════════════════════════════════════════════
//  CLIENT DATA
// ═══════════════════════════════════════════════════════════

app.get('/api/data', authMiddleware, (req, res) => {
  const clientId = req.user.id;
  const client = dbGet('SELECT * FROM clients WHERE id = ?', [clientId]);
  if (!client) return res.status(404).json({ error: 'الحساب مش موجود' });
  if (!isSubActive(client)) return res.status(403).json({ error: 'الاشتراك انتهى' });

  const people  = dbAll('SELECT * FROM people WHERE client_id = ? ORDER BY created_at ASC', [clientId]);
  const entries = dbAll('SELECT * FROM entries WHERE client_id = ? ORDER BY created_at ASC', [clientId]);

  const entryMap = {};
  entries.forEach(e => {
    if (!entryMap[e.person_id]) entryMap[e.person_id] = [];
    entryMap[e.person_id].push({ id: e.id, amount: e.amount, occasion: e.occasion, date: e.date });
  });

  const lee = [], alaya = [];
  people.forEach(p => {
    const obj = { id: p.id, name: p.name, country: p.country, entries: entryMap[p.id] || [] };
    if (p.type === 'lee') lee.push(obj); else alaya.push(obj);
  });

  res.json({ lee, alaya, profile: {
    owner_name: client.owner_name, header_color: client.header_color,
    sub_end: client.sub_end, username: client.username,
  }});
});

app.post('/api/data/sync', authMiddleware, (req, res) => {
  const clientId = req.user.id;
  const client = dbGet('SELECT * FROM clients WHERE id = ?', [clientId]);
  if (!client || !isSubActive(client)) return res.status(403).json({ error: 'الاشتراك انتهى' });

  const { lee = [], alaya = [], profile = {} } = req.body;

  try {
    db.run('BEGIN TRANSACTION');
    if (profile.owner_name)   dbRun('UPDATE clients SET owner_name = ? WHERE id = ?',   [profile.owner_name, clientId]);
    if (profile.header_color) dbRun('UPDATE clients SET header_color = ? WHERE id = ?', [profile.header_color, clientId]);
    if (profile.new_password) {
      dbRun('UPDATE clients SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(profile.new_password, 10), clientId]);
    }

    // Delete existing (manual cascade since sql.js doesn't enforce FK easily)
    const existingPeople = dbAll('SELECT id FROM people WHERE client_id = ?', [clientId]);
    existingPeople.forEach(p => dbRun('DELETE FROM entries WHERE person_id = ?', [p.id]));
    dbRun('DELETE FROM people WHERE client_id = ?', [clientId]);

    const allPeople = [
      ...lee.map(p => ({...p, type:'lee'})),
      ...alaya.map(p => ({...p, type:'alaya'}))
    ];

    allPeople.forEach(p => {
      const personId = p.id || uid();
      dbRun(
        'INSERT INTO people (id,client_id,type,name,country,created_at) VALUES (?,?,?,?,?,?)',
        [personId, clientId, p.type, p.name, p.country || '', now()]
      );
      (p.entries || []).forEach(e => {
        dbRun(
          'INSERT INTO entries (id,person_id,client_id,amount,occasion,date,created_at) VALUES (?,?,?,?,?,?,?)',
          [e.id || uid(), personId, clientId, e.amount || 0, e.occasion || '', e.date || '', now()]
        );
      });
    });

    db.run('COMMIT');
    dbSave();
    broadcast(clientId, { type: 'data_changed', ts: now() });
    res.json({ ok: true, synced_at: now() });
  } catch(e) {
    db.run('ROLLBACK');
    console.error('Sync error:', e.message);
    res.status(500).json({ error: 'خطأ في الحفظ: ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  ADMIN API
// ═══════════════════════════════════════════════════════════

app.get('/api/admin/clients', adminMiddleware, (req, res) => {
  const clients = dbAll('SELECT * FROM clients ORDER BY created_at DESC');
  const result = clients.map(c => {
    const total_people = (dbGet('SELECT COUNT(*) as c FROM people WHERE client_id = ?', [c.id]) || {}).c || 0;
    const total_amount = (dbGet('SELECT SUM(amount) as s FROM entries WHERE client_id = ?', [c.id]) || {}).s || 0;
    return {
      id: c.id, username: c.username, owner_name: c.owner_name,
      plan: c.plan, sub_start: c.sub_start, sub_end: c.sub_end,
      is_active: c.is_active, notes: c.notes,
      created_at: c.created_at, last_login: c.last_login,
      total_people, total_amount,
      sub_status: isSubActive(c) ? 'active' : 'expired',
    };
  });
  res.json(result);
});

app.post('/api/admin/clients', adminMiddleware, (req, res) => {
  const { username, password, owner_name, plan, sub_days, notes } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'يوزر وباسورد مطلوبين' });
  const exists = dbGet('SELECT id FROM clients WHERE username = ?', [username.trim().toLowerCase()]);
  if (exists) return res.status(409).json({ error: 'اليوزر ده موجود بالفعل' });
  const id    = uid();
  const hash  = bcrypt.hashSync(password, 10);
  const days  = parseInt(sub_days) || 30;
  const start = now();
  const end   = start + days * 86400000;
  dbRun(
    'INSERT INTO clients (id,username,password_hash,owner_name,plan,sub_start,sub_end,is_active,notes,created_at) VALUES (?,?,?,?,?,?,?,1,?,?)',
    [id, username.trim().toLowerCase(), hash, owner_name || 'صاحب الكشف', plan || 'monthly', start, end, notes || '', now()]
  );
  dbSave();
  res.status(201).json({ ok: true, id, sub_end: end });
});

app.patch('/api/admin/clients/:id', adminMiddleware, (req, res) => {
  const { id } = req.params;
  const client = dbGet('SELECT * FROM clients WHERE id = ?', [id]);
  if (!client) return res.status(404).json({ error: 'العميل مش موجود' });

  const sets = [], params = [];

  if (req.body.add_days !== undefined) {
    const base   = Math.max(now(), Number(client.sub_end) || 0);
    const newEnd = base + parseInt(req.body.add_days) * 86400000;
    sets.push('sub_end = ?', 'sub_start = ?', 'is_active = 1');
    params.push(newEnd, now());
  }
  if (req.body.set_end_date !== undefined) { sets.push('sub_end = ?'); params.push(new Date(req.body.set_end_date).getTime()); }
  if (req.body.is_active    !== undefined) { sets.push('is_active = ?'); params.push(req.body.is_active ? 1 : 0); }
  if (req.body.new_password)               { sets.push('password_hash = ?'); params.push(bcrypt.hashSync(req.body.new_password, 10)); }
  if (req.body.owner_name   !== undefined) { sets.push('owner_name = ?'); params.push(req.body.owner_name); }
  if (req.body.notes        !== undefined) { sets.push('notes = ?'); params.push(req.body.notes); }
  if (req.body.plan         !== undefined) { sets.push('plan = ?'); params.push(req.body.plan); }

  if (!sets.length) return res.status(400).json({ error: 'مفيش تعديلات' });
  dbRun(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  dbSave();
  broadcast(id, { type: 'account_updated' });
  res.json({ ok: true });
});

app.delete('/api/admin/clients/:id', adminMiddleware, (req, res) => {
  const { id } = req.params;
  const people = dbAll('SELECT id FROM people WHERE client_id = ?', [id]);
  people.forEach(p => dbRun('DELETE FROM entries WHERE person_id = ?', [p.id]));
  dbRun('DELETE FROM people WHERE client_id = ?', [id]);
  dbRun('DELETE FROM clients WHERE id = ?', [id]);
  dbSave();
  res.json({ ok: true });
});

// ── GET client data (sheets) for admin view ──────────────────
app.get('/api/admin/clients/:id/data', adminMiddleware, (req, res) => {
  const { id } = req.params;
  const client = dbGet('SELECT * FROM clients WHERE id = ?', [id]);
  if (!client) return res.status(404).json({ error: 'العميل مش موجود' });

  const people  = dbAll('SELECT * FROM people  WHERE client_id = ? ORDER BY created_at ASC', [id]);
  const entries = dbAll('SELECT * FROM entries WHERE client_id = ? ORDER BY created_at ASC', [id]);

  const entryMap = {};
  entries.forEach(e => {
    if (!entryMap[e.person_id]) entryMap[e.person_id] = [];
    entryMap[e.person_id].push({ id: e.id, amount: e.amount, occasion: e.occasion, date: e.date });
  });

  const lee = [], alaya = [];
  people.forEach(p => {
    const obj = { id: p.id, name: p.name, country: p.country, entries: entryMap[p.id] || [] };
    if (p.type === 'lee') lee.push(obj); else alaya.push(obj);
  });

  res.json({ lee, alaya });
});

app.get('/api/admin/stats', adminMiddleware, (req, res) => {
  const totalClients   = (dbGet('SELECT COUNT(*) as c FROM clients') || {}).c || 0;
  const activeClients  = (dbGet('SELECT COUNT(*) as c FROM clients WHERE is_active=1 AND sub_end > ?', [now()]) || {}).c || 0;
  const expiredClients = (dbGet('SELECT COUNT(*) as c FROM clients WHERE sub_end <= ? OR sub_end IS NULL', [now()]) || {}).c || 0;
  const totalPeople    = (dbGet('SELECT COUNT(*) as c FROM people') || {}).c || 0;
  const totalEntries   = (dbGet('SELECT COUNT(*) as c FROM entries') || {}).c || 0;
  res.json({ totalClients, activeClients, expiredClients, totalPeople, totalEntries });
});

app.post('/api/admin/change-password', adminMiddleware, (req, res) => {
  const { old_password, new_password } = req.body;
  const admin = dbGet('SELECT * FROM admin WHERE id = 1');
  if (!bcrypt.compareSync(old_password, admin.password_hash))
    return res.status(401).json({ error: 'الباسورد القديم غلط' });
  dbRun('UPDATE admin SET password_hash = ? WHERE id = 1', [bcrypt.hashSync(new_password, 10)]);
  dbSave();
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════════════════════
wss.on('connection', ws => {
  let clientId = null;
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        const payload = jwt.verify(msg.token, JWT_SECRET);
        if (payload.role === 'client') {
          clientId = payload.id;
          if (!wsClients.has(clientId)) wsClients.set(clientId, new Set());
          wsClients.get(clientId).add(ws);
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        }
      }
    } catch {}
  });
  ws.on('close', () => {
    if (clientId && wsClients.has(clientId)) {
      wsClients.get(clientId).delete(ws);
      if (!wsClients.get(clientId).size) wsClients.delete(clientId);
    }
  });
});

// ── Health & SPA Fallback ─────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now(), version: '1.0.0' }));

app.get('*', (req, res) => {
  if (req.path.startsWith('/admin')) {
    res.sendFile(path.join(__dirname, '../admin/index.html'));
  } else {
    res.sendFile(path.join(__dirname, '../app/index.html'));
  }
});

// ── BOOT ─────────────────────────────────────────────────────
initSqlJs().then(SQL => {
  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('✅ Database loaded from', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('✅ New database created at', DB_PATH);
  }

  initSchema();
  seedAdmin();

  server.listen(PORT, () => {
    console.log(`\n🚀 NOQTA Server running on http://localhost:${PORT}`);
    console.log(`📊 Admin panel:  http://localhost:${PORT}/admin`);
    console.log(`📱 App:          http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('❌ Failed to init database:', err);
  process.exit(1);
});
