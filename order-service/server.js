const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST || 'order-postgres.ecommerce.svc.cluster.local',
  user: process.env.DB_USER || 'order',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'orderdb',
  port: process.env.DB_PORT || 5432
});

const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';
function authenticate(req,res,next){
  const h = req.headers.authorization; if(!h) return res.status(401).json({error:'missing auth'});
  try { req.user = jwt.verify(h.split(' ')[1], JWT_SECRET); next(); } catch { return res.status(401).json({error:'invalid token'}) }
}

app.get('/healthz', (req,res)=>res.send('ok'));

app.post('/orders', authenticate, async (req, res) => {
  const authHeader = req.headers.authorization;
  const cartRes = await axios.get('http://cart-service.ecommerce.svc.cluster.local/cart', { headers: { Authorization: authHeader }});
  const cart = cartRes.data.cart || [];
  if (cart.length === 0) return res.status(400).json({ error: 'cart empty' });

  const items = [];
  for (const it of cart) {
    const p = await axios.get(`http://product-service.ecommerce.svc.cluster.local/products/${it.productId}`);
    items.push({ productId: it.productId, quantity: it.quantity, price: parseFloat(p.data.price) });
  }
  const total = items.reduce((s,i)=> s + i.price * i.quantity, 0);

  try {
    await pool.query('BEGIN');
    const r = await pool.query('INSERT INTO orders (user_id, total) VALUES ($1,$2) RETURNING id', [req.user.userId, total]);
    const orderId = r.rows[0].id;
    for (const it of items) {
      await pool.query('INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES ($1,$2,$3,$4)',
        [orderId, it.productId, it.quantity, it.price]);
    }
    await pool.query('COMMIT');
    await axios.post('http://cart-service.ecommerce.svc.cluster.local/cart/clear', {}, { headers: { Authorization: authHeader }});
    res.json({ orderId, total });
  } catch (e) {
    await pool.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'order failed' });
  }
});

app.get('/orders', authenticate, async (req, res) => {
  const r = await pool.query('SELECT id, total, created_at FROM orders WHERE user_id=$1 ORDER BY created_at DESC', [req.user.userId]);
  res.json({ orders: r.rows });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('order-service listening', port));
