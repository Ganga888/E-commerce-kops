const express = require('express');
const Redis = require('ioredis');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

const redis = new Redis({
  host: process.env.REDIS_HOST || 'cart-redis.ecommerce.svc.cluster.local',
  port: process.env.REDIS_PORT || 6379
});

const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';

function authenticate(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'missing auth' });
  try { req.user = jwt.verify(h.split(' ')[1], JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'invalid token' }); }
}

const keyFor = userId => `cart:${userId}`;

app.post('/cart/add', authenticate, async (req, res) => {
  const { productId, quantity } = req.body;
  if (!productId || !quantity) return res.status(400).json({ error: 'productId+quantity required' });
  const key = keyFor(req.user.userId);
  const raw = await redis.get(key);
  const cart = raw ? JSON.parse(raw) : [];
  const i = cart.findIndex(it => it.productId == productId);
  if (i >= 0) cart[i].quantity += quantity; else cart.push({ productId, quantity });
  await redis.set(key, JSON.stringify(cart));
  res.json({ status: 'ok', cart });
});

app.get('/cart', authenticate, async (req, res) => {
  const raw = await redis.get(keyFor(req.user.userId));
  res.json({ cart: raw ? JSON.parse(raw) : [] });
});

app.post('/cart/remove', authenticate, async (req, res) => {
  const key = keyFor(req.user.userId);
  const raw = await redis.get(key);
  let cart = raw ? JSON.parse(raw) : [];
  cart = cart.filter(c => c.productId != req.body.productId);
  await redis.set(key, JSON.stringify(cart));
  res.json({ cart });
});

app.post('/cart/clear', authenticate, async (req, res) => {
  await redis.del(keyFor(req.user.userId));
  res.json({ status: 'cleared' });
});

app.get('/healthz', (req, res) => res.send('ok'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('cart-service listening', port));
