const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host: process.env.DB_HOST || 'user-postgres.ecommerce.svc.cluster.local',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'userdb'
});

const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';
const app = express();
app.use(express.json());

app.get('/healthz', (req, res) => res.send('ok'));

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({error: 'username+password required'});
  const hash = bcrypt.hashSync(password, 8);
  try {
    const r = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1,$2) RETURNING id, username',
      [username, hash]
    );
    res.json({ user: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'username exists' });
    console.error(e); res.status(500).json({ error: 'db error' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const r = await pool.query('SELECT id, username, password_hash FROM users WHERE username=$1', [username]);
  const user = r.rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '2h' });
  res.json({ token });
});

function authenticate(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'missing auth' });
  try { req.user = jwt.verify(h.split(' ')[1], JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'invalid token' }); }
}

app.get('/me', authenticate, async (req, res) => {
  const r = await pool.query('SELECT id, username, created_at FROM users WHERE id=$1', [req.user.userId]);
  res.json({ user: r.rows[0] });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('user-service listening', port));
