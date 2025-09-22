const express = require('express');
const { Pool } = require('pg');
const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST || 'product-postgres.ecommerce.svc.cluster.local',
  user: process.env.DB_USER || 'product',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'productdb',
  port: process.env.DB_PORT || 5432
});

app.get('/healthz', (req, res) => res.send('ok'));
app.get('/products', async (req, res) => {
  const r = await pool.query('SELECT id, name, description, price FROM products ORDER BY id');
  res.json(r.rows);
});
app.get('/products/:id', async (req, res) => {
  const r = await pool.query('SELECT id, name, description, price FROM products WHERE id=$1', [req.params.id]);
  if (r.rowCount===0) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});
app.post('/products', async (req, res) => {
  const { name, description, price } = req.body;
  const r = await pool.query('INSERT INTO products (name, description, price) VALUES ($1,$2,$3) RETURNING id', [name, description, price]);
  res.json({ id: r.rows[0].id });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('product-service listening', port));
