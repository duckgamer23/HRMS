/*
  MAFS HRMS - CommonJS safe server (lowdb)
  Fixed: provide default data to Low to avoid "missing default data" error.
*/
const express = require('express');
const http = require('http');
const path = require('path');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const socketio = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketio(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Wrap initialization in async function
async function main() {
  // DB (lowdb) setup
  const file = path.join(__dirname, 'data.json');
  const adapter = new JSONFile(file);

  // Provide default data object as second parameter to Low
  const defaults = { users: [], employees: [], attendance: [], leaves: [], notifications: [] };
  const db = new Low(adapter, defaults);

  // read file (creates default object if not present)
  await db.read();
  if (!db.data) {
    db.data = defaults;
    await db.write();
  }

  // attach db to app for handlers
  app.locals.db = db;

  // -------- AUTH --------
  app.post('/api/create-super', async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'Missing username/password' });
      if (db.data.users.find(u => u.username === username)) return res.status(400).json({ error: 'Already exists' });
      const hash = await bcrypt.hash(password, 10);
      const user = { id: uuidv4(), username, password: hash, role: 'superadmin', display_name: username };
      db.data.users.push(user);
      await db.write();
      return res.json({ ok: true });
    } catch (e) { console.error(e); return res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      const user = db.data.users.find(u => u.username === username);
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      const ok = await bcrypt.compare(password, user.password);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      return res.json({ id: user.id, username: user.username, role: user.role, display_name: user.display_name });
    } catch (e) { console.error(e); return res.status(500).json({ error: 'Server error' }); }
  });

  // -------- EMPLOYEES --------
  app.get('/api/employees', (req, res) => res.json(db.data.employees || []));

  app.post('/api/employees', async (req, res) => {
    try {
      const e = req.body;
      e.id = e.id || uuidv4();
      const existing = (db.data.employees || []).find(x => x.id === e.id);
      if (existing) Object.assign(existing, e);
      else {
        db.data.employees = db.data.employees || [];
        db.data.employees.push(e);
      }
      await db.write();
      io.emit('employee_update', e);
      return res.json({ ok: true, id: e.id });
    } catch (e) { console.error(e); return res.status(500).json({ error: 'Server error' }); }
  });

  app.delete('/api/employees/:id', async (req, res) => {
    try {
      db.data.employees = (db.data.employees || []).filter(e => e.id !== req.params.id);
      await db.write();
      io.emit('employee_delete', req.params.id);
      return res.json({ ok: true });
    } catch (e) { console.error(e); return res.status(500).json({ error: 'Server error' }); }
  });

  // -------- ATTENDANCE --------
  app.get('/api/attendance', (req, res) => res.json(db.data.attendance || []));

  app.post('/api/attendance', async (req, res) => {
    try {
      const a = req.body;
      a.id = a.id || uuidv4();
      db.data.attendance = db.data.attendance || [];
      const existing = db.data.attendance.find(x => x.employeeId === a.employeeId && x.date === a.date);
      if (existing) Object.assign(existing, a);
      else db.data.attendance.push(a);
      await db.write();
      io.emit('attendance_update', a);
      return res.json({ ok: true, id: a.id });
    } catch (e) { console.error(e); return res.status(500).json({ error: 'Server error' }); }
  });

  // -------- LEAVES --------
  app.get('/api/leaves', (req, res) => res.json(db.data.leaves || []));

  app.post('/api/leaves', async (req, res) => {
    try {
      const l = req.body;
      l.id = l.id || uuidv4();
      db.data.leaves = db.data.leaves || [];
      db.data.leaves.push(l);
      await db.write();
      io.emit('leave_created', l);
      return res.json({ ok: true, id: l.id });
    } catch (e) { console.error(e); return res.status(500).json({ error: 'Server error' }); }
  });

  app.put('/api/leaves/:id', async (req, res) => {
    try {
      const id = req.params.id; const status = req.body.status;
      const item = (db.data.leaves || []).find(x => x.id === id);
      if (item) { item.status = status; await db.write(); io.emit('leave_update', { id, status }); return res.json({ ok:true }); }
      return res.status(404).json({ error: 'Not found' });
    } catch (e) { console.error(e); return res.status(500).json({ error: 'Server error' }); }
  });

  // -------- NOTIFICATIONS --------
  app.get('/api/notifications', (req, res) => res.json(db.data.notifications || []));
  app.post('/api/notifications', async (req, res) => {
    try {
      const n = req.body; n.id = n.id || uuidv4(); db.data.notifications = db.data.notifications || []; db.data.notifications.push(n); await db.write(); io.emit('notification', n); return res.json({ ok:true, id: n.id });
    } catch (e) { console.error(e); return res.status(500).json({ error: 'Server error' }); }
  });

  // -------- REALTIME --------
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
  });

  // Start server
  server.listen(PORT, () => {
    console.log('✅ MAFS HRMS running at http://localhost:' + PORT);
  });
} // end main

// run main()
main().catch(err => { console.error('Fatal error starting server', err); process.exit(1); });
