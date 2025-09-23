# E-commerce Microservices — Full code + Step-by-step deploy

This single document contains **all service code, Dockerfiles, Kubernetes manifests, and step-by-step commands** so you can follow and create the resources exactly as you go. Paste these files into a GitHub repo and follow the numbered steps.

---

## Quick overview

- Minimal microservices demo: **user, product, cart, order, frontend**
- Datastores: **Postgres** (user/product/order), **Redis** (cart)
- Deploy to Kubernetes using YAML manifests (StatefulSets for DBs, Deployments for apps)
- Ingress for external access; optional cert-manager for TLS

---

## Repo structure

```
ecommerce/
  frontend/
    index.html
    Dockerfile
  user-service/
    package.json
    server.js
    Dockerfile
  product-service/
    package.json
    server.js
    Dockerfile
  cart-service/
    package.json
    server.js
    Dockerfile
  order-service/
    package.json
    server.js
    Dockerfile
  k8s/
    namespace.yaml
    secrets.yaml
    configmaps-dbinit.yaml
    user-postgres-statefulset.yaml
    product-postgres-statefulset.yaml
    order-postgres-statefulset.yaml
    redis-statefulset.yaml
    deployments/
      user-deployment.yaml
      product-deployment.yaml
      cart-deployment.yaml
      order-deployment.yaml
      frontend-deployment.yaml
    services/
      user-service-svc.yaml
      product-service-svc.yaml
      cart-service-svc.yaml
      order-service-svc.yaml
      frontend-service-svc.yaml
    ingress.yaml
```

---

## 1) Prerequisites (one-time on your machine)

1. Install Docker (or Podman)
2. Install kubectl and configure to use your cluster
3. Install Helm (for ingress and cert-manager)
4. (Optional) jq for parsing JSON in quick tests
5. Have a Docker registry (Docker Hub, GitHub Packages, or AWS ECR)

---

## 2) Per-service code & Dockerfiles

### 2.1 user-service (JWT auth, Postgres)

**user-service/package.json**

```json
{
  "name": "user-service",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "express": "^4.18.2",
    "jsonwebtoken": "^9.0.0",
    "pg": "^8.11.0"
  }
}
```

**user-service/server.js**

```js
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
```

**user-service/Dockerfile**

```
FROM node:18-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node","server.js"]
```

---

### 2.2 product-service (Postgres)

**product-service/package.json**

```json
{
  "name": "product-service",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "express": "^4.18.2",
    "pg": "^8.11.0"
  }
}
```

**product-service/server.js**

```js
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
```

**product-service/Dockerfile**

```
FROM node:18-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node","server.js"]
```

---

### 2.3 cart-service (Redis, JWT)

**cart-service/package.json**

```json
{
  "name": "cart-service",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "express": "^4.18.2",
    "ioredis": "^5.3.2",
    "jsonwebtoken": "^9.0.0"
  }
}
```

**cart-service/server.js**

```js
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
```

**cart-service/Dockerfile**

```
FROM node:18-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node","server.js"]
```

---

### 2.4 order-service (Postgres, calls Cart + Product, JWT)

**order-service/package.json**

```json
{
  "name": "order-service",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "axios": "^1.4.0",
    "express": "^4.18.2",
    "jsonwebtoken": "^9.0.0",
    "pg": "^8.11.0"
  }
}
```

**order-service/server.js**

```js
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
```

**order-service/Dockerfile**

```
FROM node:18-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node","server.js"]
```

---

### 2.5 frontend (static HTML)

**frontend/index.html**

```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Mini Shop</title></head>
<body>
<h1>Mini Shop (Demo)</h1>
<div id="auth">
  <input id="u" placeholder="username"/><input id="p" placeholder="password" type="password"/>
  <button onclick="register()">Register</button>
  <button onclick="login()">Login</button>
</div>
<div id="actions" style="display:none">
  <button onclick="listProducts()">List Products</button>
  <button onclick="viewCart()">View Cart</button>
  <button onclick="addToCart()">Add 1st Product (x2)</button>
  <button onclick="checkout()">Checkout</button>
  <pre id="out"></pre>
</div>
<script>
let token = '';
async function register() {
  const u=document.getElementById('u').value; const p=document.getElementById('p').value;
  const r=await fetch('/api/user/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
  document.getElementById('out').innerText = await r.text();
}
async function login() {
  const u=document.getElementById('u').value; const p=document.getElementById('p').value;
  const r=await fetch('/api/user/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
  const j=await r.json(); token=j.token; if(token){document.getElementById('actions').style.display='block';}
  document.getElementById('out').innerText = JSON.stringify(j,null,2);
}
async function listProducts() {
  const r=await fetch('/api/product/products'); const j=await r.json();
  document.getElementById('out').innerText = JSON.stringify(j,null,2);
}
async function addToCart() {
  const r=await fetch('/api/product/products'); const products=await r.json();
  if(!products.length){document.getElementById('out').innerText='No products';return;}
  const first=products[0];
  const res=await fetch('/api/cart/cart/add',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({productId:first.id,quantity:2})});
  document.getElementById('out').innerText = await res.text();
}
async function viewCart() {
  const r=await fetch('/api/cart/cart',{headers:{Authorization:'Bearer '+token}});
  const j=await r.json(); document.getElementById('out').innerText = JSON.stringify(j,null,2);
}
async function checkout() {
  const r=await fetch('/api/order/orders',{method:'POST',headers:{Authorization:'Bearer '+token}});
  const j=await r.json(); document.getElementById('out').innerText = JSON.stringify(j,null,2);
}
</script>

</body>
</html>
```

**frontend/Dockerfile**

```
FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
EXPOSE 80
CMD ["nginx","-g","daemon off;"]
```

---

## 3) Kubernetes manifests (complete)

Create a `k8s/` folder and add the following files.

### 3.1 namespace.yaml

```yaml
apiVersion: v1
kind: Namespace
metadata: { name: ecommerce }
```

### 3.2 secrets.yaml (EDIT values)

```yaml
apiVersion: v1
kind: Secret
metadata: { name: ecommerce-secrets, namespace: ecommerce }
type: Opaque
stringData:
  JWT_SECRET: "REPLACE_WITH_STRONG_JWT_SECRET"
  USER_DB_PASSWORD: "user_db_pass"
  PRODUCT_DB_PASSWORD: "product_db_pass"
  ORDER_DB_PASSWORD: "order_db_pass"
```

### 3.3 configmaps-dbinit.yaml

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: db-init-sql, namespace: ecommerce }
data:
  user-init.sql: |
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now()
    );
  product-init.sql: |
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price NUMERIC(10,2) NOT NULL,
      created_at TIMESTAMP DEFAULT now()
    );
    INSERT INTO products (name, description, price) VALUES
      ('Sample Product A','Desc A', 19.99),
      ('Sample Product B','Desc B', 29.50)
    ON CONFLICT DO NOTHING;
  order-init.sql: |
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      total NUMERIC(10,2) NOT NULL,
      created_at TIMESTAMP DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      price_at_purchase NUMERIC(10,2) NOT NULL
    );
```
### 3.4.0 storageclass-gp3.yaml (Create gp3 storageClassName)

```yaml
# k8s/user-postgres-service-sts.yaml
---
apiVersion: v1
kind: Service
metadata:
  name: user-postgres
  namespace: ecommerce
  labels:
    app: user-postgres
spec:
  ports:
    - name: postgres
      port: 5432
  clusterIP: None
  selector:
    app: user-postgres
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: user-postgres
  namespace: ecommerce
spec:
  serviceName: "user-postgres"
  replicas: 1
  selector:
    matchLabels:
      app: user-postgres
  template:
    metadata:
      labels:
        app: user-postgres
    spec:
      # ensure group ownership on mounted volumes
      securityContext:
        fsGroup: 999
      # initContainer creates the PGDATA subdir and fixes ownership
      initContainers:
        - name: init-pgdata
          image: busybox:1.36.1
          command:
            - sh
            - -c
            - |
              set -eux
              mkdir -p /var/lib/postgresql/data/pgdata
              chown -R 999:999 /var/lib/postgresql/data
          securityContext:
            runAsUser: 0
          volumeMounts:
            - name: pgdata
              mountPath: /var/lib/postgresql/data
      containers:
        - name: postgres
          image: postgres:15-alpine
          env:
            - name: POSTGRES_DB
              value: userdb
            - name: POSTGRES_USER
              value: user
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: ecommerce-secrets
                  key: USER_DB_PASSWORD
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: pgdata
              mountPath: /var/lib/postgresql/data
            - name: init-sql
              mountPath: /docker-entrypoint-initdb.d/user-init.sql
              subPath: user-init.sql
      volumes:
        - name: init-sql
          configMap:
            name: db-init-sql
            items:
              - key: user-init.sql
                path: user-init.sql
  volumeClaimTemplates:
    - metadata:
        name: pgdata
        labels:
          app: user-postgres
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 5Gi
        storageClassName: gp3

```

### 3.4.1 user-postgres-statefulset.yaml (adjust storageClassName)

```yaml
# k8s/user-postgres-service-sts.yaml
---
apiVersion: v1
kind: Service
metadata:
  name: user-postgres
  namespace: ecommerce
  labels:
    app: user-postgres
spec:
  ports:
    - name: postgres
      port: 5432
  clusterIP: None
  selector:
    app: user-postgres
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: user-postgres
  namespace: ecommerce
spec:
  serviceName: "user-postgres"
  replicas: 1
  selector:
    matchLabels:
      app: user-postgres
  template:
    metadata:
      labels:
        app: user-postgres
    spec:
      # ensure group ownership on mounted volumes
      securityContext:
        fsGroup: 999
      # initContainer creates the PGDATA subdir and fixes ownership
      initContainers:
        - name: init-pgdata
          image: busybox:1.36.1
          command:
            - sh
            - -c
            - |
              set -eux
              mkdir -p /var/lib/postgresql/data/pgdata
              chown -R 999:999 /var/lib/postgresql/data
          securityContext:
            runAsUser: 0
          volumeMounts:
            - name: pgdata
              mountPath: /var/lib/postgresql/data
      containers:
        - name: postgres
          image: postgres:15-alpine
          env:
            - name: POSTGRES_DB
              value: userdb
            - name: POSTGRES_USER
              value: user
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: ecommerce-secrets
                  key: USER_DB_PASSWORD
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: pgdata
              mountPath: /var/lib/postgresql/data
            - name: init-sql
              mountPath: /docker-entrypoint-initdb.d/user-init.sql
              subPath: user-init.sql
      volumes:
        - name: init-sql
          configMap:
            name: db-init-sql
            items:
              - key: user-init.sql
                path: user-init.sql
  volumeClaimTemplates:
    - metadata:
        name: pgdata
        labels:
          app: user-postgres
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 5Gi
        storageClassName: gp3

```
### 3.4.2 order-postgres-statefulset.yaml (adjust storageClassName)

```yaml
# k8s/order-postgres-service-sts.yaml
---
apiVersion: v1
kind: Service
metadata:
  name: order-postgres
  namespace: ecommerce
  labels:
    app: order-postgres
spec:
  ports:
    - name: postgres
      port: 5432
  clusterIP: None
  selector:
    app: order-postgres
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: order-postgres
  namespace: ecommerce
spec:
  serviceName: "order-postgres"
  replicas: 1
  selector:
    matchLabels:
      app: order-postgres
  template:
    metadata:
      labels:
        app: order-postgres
    spec:
      # ensure group ownership on mounted volumes
      securityContext:
        fsGroup: 999
      # initContainer creates PGDATA subdir and fixes ownership
      initContainers:
        - name: init-pgdata
          image: busybox:1.36.1
          command:
            - sh
            - -c
            - |
              set -eux
              mkdir -p /var/lib/postgresql/data/pgdata
              chown -R 999:999 /var/lib/postgresql/data
          securityContext:
            runAsUser: 0
          volumeMounts:
            - name: pgdata
              mountPath: /var/lib/postgresql/data
      containers:
        - name: postgres
          image: postgres:15-alpine
          env:
            - name: POSTGRES_DB
              value: orderdb
            - name: POSTGRES_USER
              value: order
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: ecommerce-secrets
                  key: ORDER_DB_PASSWORD
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: pgdata
              mountPath: /var/lib/postgresql/data
            - name: init-sql
              mountPath: /docker-entrypoint-initdb.d/order-init.sql
              subPath: order-init.sql
      volumes:
        - name: init-sql
          configMap:
            name: db-init-sql
            items:
              - key: order-init.sql
                path: order-init.sql
  volumeClaimTemplates:
    - metadata:
        name: pgdata
        labels:
          app: order-postgres
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 5Gi
        storageClassName: gp3

```
### 3.4.3 product-postgres-statefulset.yaml (adjust storageClassName)

```yaml
# k8s/product-postgres-service-sts.yaml
---
apiVersion: v1
kind: Service
metadata:
  name: product-postgres
  namespace: ecommerce
  labels:
    app: product-postgres
spec:
  ports:
    - name: postgres
      port: 5432
  clusterIP: None
  selector:
    app: product-postgres
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: product-postgres
  namespace: ecommerce
spec:
  serviceName: "product-postgres"
  replicas: 1
  selector:
    matchLabels:
      app: product-postgres
  template:
    metadata:
      labels:
        app: product-postgres
    spec:
      # ensure group ownership on mounted volumes
      securityContext:
        fsGroup: 999
      # initContainer creates PGDATA subdir and fixes ownership (safe)
      initContainers:
        - name: init-pgdata
          image: busybox:1.36.1
          command:
            - sh
            - -c
            - |
              set -eux
              mkdir -p /var/lib/postgresql/data/pgdata
              chown -R 999:999 /var/lib/postgresql/data
          securityContext:
            runAsUser: 0
          volumeMounts:
            - name: pgdata
              mountPath: /var/lib/postgresql/data
      containers:
        - name: postgres
          image: postgres:15-alpine
          env:
            - name: POSTGRES_DB
              value: productdb
            - name: POSTGRES_USER
              value: product
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: ecommerce-secrets
                  key: PRODUCT_DB_PASSWORD
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: pgdata
              mountPath: /var/lib/postgresql/data
            - name: init-sql
              mountPath: /docker-entrypoint-initdb.d/product-init.sql
              subPath: product-init.sql
      volumes:
        - name: init-sql
          configMap:
            name: db-init-sql
            items:
              - key: product-init.sql
                path: product-init.sql
  volumeClaimTemplates:
    - metadata:
        name: pgdata
        labels:
          app: product-postgres
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 5Gi
        storageClassName: gp3

```
> Copy the same pattern for `product-postgres-statefulset.yaml` and `order-postgres-statefulset.yaml`, changing DB names, users and secret keys. Also the `redis-statefulset.yaml` is included below.

### 3.4.4 redis-statefulset.yaml

```yaml
# k8s/cart-redis-service-sts.yaml
---
apiVersion: v1
kind: Service
metadata:
  name: cart-redis
  namespace: ecommerce
  labels:
    app: cart-redis
spec:
  ports:
    - name: redis
      port: 6379
  clusterIP: None
  selector:
    app: cart-redis
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cart-redis
  namespace: ecommerce
spec:
  serviceName: "cart-redis"
  replicas: 1
  selector:
    matchLabels:
      app: cart-redis
  template:
    metadata:
      labels:
        app: cart-redis
    spec:
      # make mounted volumes group-writable
      securityContext:
        fsGroup: 100
      # initContainer creates /data and fixes ownership (safe)
      initContainers:
        - name: init-redisdata
          image: busybox:1.36.1
          command:
            - sh
            - -c
            - |
              set -eux
              mkdir -p /data
              chown -R 100:100 /data
          securityContext:
            runAsUser: 0
          volumeMounts:
            - name: redisdata
              mountPath: /data
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          volumeMounts:
            - name: redisdata
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: redisdata
        labels:
          app: cart-redis
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 2Gi
        storageClassName: gp3
```

### 3.6 Deployments (user/product/cart/order/frontend)

Place these in `k8s/deployments/`.

**user-deployment.yaml**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: user-service, namespace: ecommerce, labels: { app: user-service } }
spec:
  replicas: 3
  selector: { matchLabels: { app: user-service } }
  template:
    metadata: { labels: { app: user-service } }
    spec:
      containers:
        - name: user
          image: <your-registry>/user-service:latest
          ports: [{ containerPort: 3000 }]
          env:
            - { name: DB_HOST, value: user-postgres.ecommerce.svc.cluster.local }
            - { name: DB_PORT, value: "5432" }
            - { name: DB_USER, value: "user" }
            - name: DB_PASSWORD
              valueFrom: { secretKeyRef: { name: ecommerce-secrets, key: USER_DB_PASSWORD } }
            - { name: DB_NAME, value: "userdb" }
            - name: JWT_SECRET
              valueFrom: { secretKeyRef: { name: ecommerce-secrets, key: JWT_SECRET } }
          readinessProbe: { httpGet: { path: /healthz, port: 3000 }, initialDelaySeconds: 5, periodSeconds: 10 }
          livenessProbe:  { httpGet: { path: /healthz, port: 3000 }, initialDelaySeconds: 15, periodSeconds: 20 }
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector: { matchExpressions: [ { key: app, operator: In, values: [ user-service ] } ] }
              topologyKey: kubernetes.io/hostname
```

> Repeat the pattern for product-service, cart-service, order-service and frontend, changing the image, env and ports accordingly. Use `<your-registry>/...` images.

### 3.7 Services (ClusterIP)

Place in `k8s/services/`:

**user-service-svc.yaml**

```yaml
apiVersion: v1
kind: Service
metadata: { name: user-service, namespace: ecommerce }
spec:
  selector: { app: user-service }
  ports: [{ port: 80, targetPort: 3000 }]
  type: ClusterIP
```

> Add similar services for product-service, cart-service, order-service, and frontend-service (frontend targetPort 80).

### 3.8 ingress.yaml

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ecommerce-ingress
  namespace: ecommerce
  annotations:
    kubernetes.io/ingress.class: nginx
spec:
  rules:
    - host: ganga888.online
      http:
        paths:
          - path: /api/user
            pathType: Prefix
            backend: { service: { name: user-service, port: { number: 80 } } }
          - path: /api/product
            pathType: Prefix
            backend: { service: { name: product-service, port: { number: 80 } } }
          - path: /api/cart
            pathType: Prefix
            backend: { service: { name: cart-service, port: { number: 80 } } }
          - path: /api/order
            pathType: Prefix
            backend: { service: { name: order-service, port: { number: 80 } } }
          - path: /
            pathType: Prefix
            backend: { service: { name: frontend-service, port: { number: 80 } } }
```

> To enable TLS with cert-manager, add the cert-manager annotations and `spec.tls` block (see later).

---

## 4) Build, tag & push images (step-by-step)

### Option A — Docker Hub (simple)

1. Create a Docker Hub repo (e.g., `yourname/user-service`).
2. Login: `docker login`
3. From repo root run (replace `<your-registry>` with `yourdockerhubusername`):

```bash
cd user-service
docker build -t <your-registry>/user-service:latest .
docker push <your-registry>/user-service:latest

cd ../product-service
docker build -t <your-registry>/product-service:latest .
docker push <your-registry>/product-service:latest

cd ../cart-service
docker build -t <your-registry>/cart-service:latest .
docker push <your-registry>/cart-service:latest

cd ../order-service
docker build -t <your-registry>/order-service:latest .
docker push <your-registry>/order-service:latest

cd ../frontend
docker build -t <your-registry>/ecommerce-frontend:latest .
docker push <your-registry>/ecommerce-frontend:latest
```

### Option B — AWS ECR (if you use AWS)

Follow ECR login and tagging (example):

```bash
aws ecr create-repository --repository-name user-service --region us-east-1
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker build -t user-service:latest ./user-service
docker tag user-service:latest <account>.dkr.ecr.us-east-1.amazonaws.com/user-service:latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/user-service:latest
# Repeat for each service
```

---

## 5) Deploy to Kubernetes (step-by-step)

1. Create namespace and secrets (edit `k8s/secrets.yaml` first):

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secrets.yaml
kubectl apply -f k8s/configmaps-dbinit.yaml
```

2. Deploy DB StatefulSets and Redis (wait until pods show `Running`):

```bash
kubectl apply -f k8s/user-postgres-statefulset.yaml
kubectl apply -f k8s/product-postgres-statefulset.yaml
kubectl apply -f k8s/order-postgres-statefulset.yaml
kubectl apply -f k8s/redis-statefulset.yaml
kubectl -n ecommerce get pods -w
```

3. Deploy app deployments & services:

```bash
kubectl apply -f k8s/deployments/
kubectl apply -f k8s/services/
```

4. Install NGINX ingress controller with Helm and create the Ingress resource:

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace
kubectl apply -f k8s/ingress.yaml
```

5. Get the external address for the ingress controller and create your DNS A/ALIAS record pointing to it (in your DNS provider).

```bash
kubectl -n ingress-nginx get svc ingress-nginx-controller -o wide
```

---

## 6) Optional — HTTPS with cert-manager (Let’s Encrypt)

1. Install cert-manager:

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace --set crds.enabled=true
```

2. Create `k8s/clusterissuer-letsencrypt.yaml` with the `ClusterIssuer` for Let’s Encrypt (HTTP-01 solver). Example:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@example.com
    privateKeySecretRef: { name: letsencrypt-account-key }
    solvers:
    - http01:
        ingress:
          class: nginx
```

3. Patch `k8s/ingress.yaml` to add:

```yaml
metadata:
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt
spec:
  tls:
    - hosts: [ ganga888.online ]
      secretName: ganga888-online-tls
```

4. Apply ClusterIssuer and patched ingress:

```bash
kubectl apply -f k8s/clusterissuer-letsencrypt.yaml
kubectl apply -f k8s/ingress.yaml
kubectl -n ecommerce get certificate
```

---

## 7) Quick tests & curl examples

```bash
# Register
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"pw"}' http://ganga888.online/api/user/register

# Login
TOKEN=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"pw"}' http://ganga888.online/api/user/login | jq -r .token)

# List products
curl http://ganga888.online/api/product/products

# Add to cart
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"productId":1,"quantity":2}' http://ganga888.online/api/cart/cart/add

# Place order
curl -X POST -H "Authorization: Bearer $TOKEN" http://ganga888.online/api/order/orders
```

---

## 8) Git & GitHub (create repo + push)

```bash
# create repo locally
git init
git add .
git commit -m "initial commit: ecommerce microservices"
# create remote repo on GitHub (via UI) then:
git remote add origin git@github.com:yourname/ecommerce.git
git branch -M main
git push -u origin main
```

**.gitignore** suggestion (create at repo root):

```
node_modules/
.env
.DS_Store
```

---

## 9) Troubleshooting & common issues

- `CrashLoopBackOff` DB pods: check PVCs `kubectl -n ecommerce get pvc` and secrets used for passwords.
- Ingress returns 404: check the `host` field in ingress and DNS records.
- App fails to connect to DB: check env var DB_HOST and service names; `kubectl -n ecommerce exec -it <pod> -- ping user-postgres`.
- Missing images: if pods show `ErrImagePull`, confirm image names and registry authentication.

---

## 10) Cleanup

```bash
kubectl delete namespace ecommerce
helm uninstall ingress-nginx -n ingress-nginx
helm uninstall cert-manager -n cert-manager
```

---

## 11) Next steps / improvements (production)

- Use managed DBs (RDS) instead of in-cluster Postgres
- Use ExternalSecrets or AWS Secrets Manager for secrets
- Add Prometheus/Grafana and Fluent Bit for metrics & logs
- Add Horizontal Pod Autoscalers (HPA)

---


## That's it

All files and step-by-step commands are in this document. Follow sections 2 → 5 in order.

If you'd like, I can now:

- create a zip of the repo and provide a download link,
- or create per-service `README.md` files inside each folder (with endpoint docs and example requests),
- or generate Kubernetes manifests adjusted to a specific cloud provider (EKS/GKE/AKS) — tell me which.

Happy to continue — say which option you want next.

