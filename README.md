# E-commerce Microservices — README

**What this file contains**
- Full project overview and purpose
- Architecture diagrams (Mermaid + ASCII)
- Exactly how each microservice functions (endpoints, DB, auth)
- How services connect to one another (detailed explanation + examples)
- End-to-end flows (requests, headers, example payloads)
- Full debugging playbook and step-by-step commands
- Troubleshooting matrix with common problems and fixes

---

## Quick summary
This is a small microservices e-commerce demo built to show how multiple small services work together on Kubernetes.
- Services: **user**, **product**, **cart**, **order**, **frontend**
- Data: **Postgres** per service (user/product/order), **Redis** for cart
- Entry: **Ingress (nginx)** that routes `/api/*` to internal services and `/` to frontend
- Auth: **JWT** created by `user-service` and validated by other services

---

## Table of contents
1. Architecture (diagram)
2. Repo layout
3. Service details & endpoints
4. How services connect (DNS, headers, JWT pass-through)
5. End-to-end request flows (examples)
6. Local / cluster tests (port-forward)
7. Debugging playbook (step-by-step)
8. Troubleshooting matrix
9. Advanced notes: resilience, logging, and monitoring

---

# 1. Architecture

## Mermaid diagram (paste to GitHub README — supported)

```
flowchart LR
  subgraph Cluster [Kubernetes: namespace = ecommerce]
    direction TB
    Ingress["Ingress (ganga888.online)"]
    FrontendSvc["frontend-service (ClusterIP)"]
    UserSvc["user-service (Deployment x3)"]
    ProductSvc["product-service (Deployment x3)"]
    CartSvc["cart-service (Deployment x3)"]
    OrderSvc["order-service (Deployment x3)"]
    UserDB["user-postgres (StatefulSet)"]
    ProductDB["product-postgres (StatefulSet)"]
    OrderDB["order-postgres (StatefulSet)"]
    Redis["cart-redis (StatefulSet)"]
  end

  Ingress -->|"/"| FrontendSvc
  Ingress -->|"/api/user"| UserSvc
  Ingress -->|"/api/product"| ProductSvc
  Ingress -->|"/api/cart"| CartSvc
  Ingress -->|"/api/order"| OrderSvc

  UserSvc -->|connects| UserDB
  ProductSvc -->|connects| ProductDB
  OrderSvc -->|connects| OrderDB
  CartSvc -->|connects| Redis

  OrderSvc -->|HTTP| CartSvc
  OrderSvc -->|HTTP| ProductSvc
  CartSvc -->|JWT validation (shared secret)| UserSvc
```

## ASCII overview
```
Internet -> Ingress (nginx)
  / -> frontend-service
  /api/user -> user-service
  /api/product -> product-service
  /api/cart -> cart-service
  /api/order -> order-service

Internal calls:
- order-service -> cart-service (get cart)
- order-service -> product-service (get product price)
- cart-service + order-service + product-service -> rely on JWT_SECRET for auth validation
```

---

# 2. Repo layout

```
ecommerce/
  frontend/
  user-service/
  product-service/
  cart-service/
  order-service/
  k8s/
    namespace.yaml
    secrets.yaml
    configmaps-dbinit.yaml
    user-postgres-statefulset.yaml
    product-postgres-statefulset.yaml
    order-postgres-statefulset.yaml
    redis-statefulset.yaml
    deployments/
    services/
    ingress.yaml
```

Each service folder contains `package.json`, `server.js` and `Dockerfile`.

---

# 3. Service details & endpoints (how functionaries work)

This section explains what each service does, endpoints it exposes, and how it stores data.

## 3.1 User Service — Authentication
- Purpose: register/login users, issue JWT tokens, `GET /me` to retrieve user info
- DB: Postgres (`userdb`) with table `users(id, username, password_hash, created_at)`
- Main endpoints:
  - `POST /register` — body `{ "username": "alice", "password": "pw" }` → creates user
    - Response: `{ "user": { "id": 1, "username": "alice" }}`
  - `POST /login` — body `{ "username": "alice", "password": "pw" }` → returns `{ "token": "<jwt>" }`
  - `GET /me` — requires `Authorization: Bearer <jwt>` → returns user info
- How it runs: Node.js Express; connects to Postgres using env vars `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
- Important env: `JWT_SECRET` (must match other services in the cluster).

## 3.2 Product Service — Catalog
- Purpose: provide product list and product details
- DB: Postgres (`productdb`) with `products(id,name,description,price)`
- Endpoints:
  - `GET /products` — returns array of products
  - `GET /products/:id` — returns product detail
  - `POST /products` — (optional admin) insert product
- No JWT required for reading products in demo (but can be added).

## 3.3 Cart Service — Per-user cart in Redis
- Purpose: store per-user cart keyed by `cart:<userId>` in Redis
- Redis keys: `cart:<userId>` -> JSON array `[ { productId, quantity }, ... ]`
- Endpoints (all require `Authorization: Bearer <jwt>`):
  - `POST /cart/add` — body `{ "productId": 1, "quantity": 2 }` → add or increment
  - `GET /cart` — returns `{ cart: [...] }`
  - `POST /cart/remove` — body `{ "productId": 1 }` → remove
  - `POST /cart/clear` — clears cart
- JWT validation: uses the same `JWT_SECRET` env var.

## 3.4 Order Service — Place orders
- Purpose: read user cart, fetch product prices, write `orders` and `order_items` in Postgres
- DB: Postgres (`orderdb`) with `orders(id,user_id,total,created_at)` and `order_items`
- Endpoint (requires JWT):
  - `POST /orders` — reads cart from `cart-service`, fetches product details from `product-service`, calculates total, writes the order and order_items to its DB, and clears the cart.
- Inter-service calls:
  - `GET http://cart-service.ecommerce.svc.cluster.local/cart` with `Authorization` header forwarded from the incoming request
  - `GET http://product-service.ecommerce.svc.cluster.local/products/:id` for each cart item
  - `POST http://cart-service.ecommerce.svc.cluster.local/cart/clear` to clear cart after order placed
- Transaction: uses Postgres transaction `BEGIN`/`COMMIT` to create order and order_items; on failure `ROLLBACK`.

## 3.5 Frontend — static UI
- Purpose: basic demo UI that calls `/api/...` endpoints via the Ingress (same origin)
- Files: `index.html` with simple JS functions that call the backend via fetch (e.g., `/api/user/login`, `/api/product/products`, `/api/cart/cart/add`, `/api/order/orders`).

---

# 4. How services connect (detailed explanation)

This is the key section you asked for: **how to connect one API to another API** and exactly how it works in this Kubernetes setup.

## 4.1 Kubernetes internal DNS and service discovery
- Every `Service` in Kubernetes becomes resolvable by DNS at `<service-name>.<namespace>.svc.cluster.local`. In our cluster (namespace `ecommerce`), short names also resolve: `cart-service`, `product-service`, etc.
- Example internal URL used by `order-service` to talk to `cart-service`:
  - `http://cart-service.ecommerce.svc.cluster.local/cart`
  - Because `cart-service` `Service` maps port 80 to the pods' 3000, `http://cart-service/cart` (inside cluster) resolves and routes to app containers.

## 4.2 Header propagation & auth (JWT pass-through)
- The frontend authenticates with `user-service` and receives a JWT: `Bearer <token>`.
- When frontend calls `/api/cart/cart/add`, the Ingress forwards to the `cart-service` and the header `Authorization: Bearer <token>` travels to the `cart-service`.
- **Order service must call cart & product services on behalf of the user.** Implementation detail in `order-service` code:

```js
// order-service extracts the Authorization header from the incoming request:
const authHeader = req.headers.authorization;
// pass it along when calling cart-service:
axios.get('http://cart-service.ecommerce.svc.cluster.local/cart', { headers: { Authorization: authHeader }});
```

- **Important:** All services that validate the JWT must use the same `JWT_SECRET` so token verification passes (this is set via `ecommerce-secrets` in k8s).

## 4.3 Ports and services mapping
- Each app listens on container port `3000` (except frontend container which listens on 80). The Kubernetes `Service` maps `port:80` to `targetPort:3000` for the backend services. Thus inside cluster a call to `http://user-service:80/healthz` will route to the containers' port 3000.

## 4.4 Example: Order flow connection details (what actually happens)
1. Client logs in and obtains `Authorization: Bearer <jwt>`.
2. Client requests `POST /api/order/orders` on the Ingress → routed to `order-service`.
3. `order-service` executes:
   - `axios.get('http://cart-service.ecommerce.svc.cluster.local/cart', { headers: { Authorization: <jwt> }})` to get the cart.
   - For each item in cart: `axios.get('http://product-service.ecommerce.svc.cluster.local/products/:id')` to fetch price and details.
   - Computes `total`, begins Postgres transaction, writes `orders` and `order_items`.
   - Calls `POST http://cart-service.ecommerce.svc.cluster.local/cart/clear` to clear cart (pass auth header too).
   - Returns `{ orderId, total }` to client.

## 4.5 Error handling & timeouts
- Network calls can fail: use timeouts on axios calls and handle errors gracefully.
  - Example axios config: `axios.get(url, { headers, timeout: 5000 })` → catches timeouts.
- If product lookup fails for one item, `order-service` should `ROLLBACK` the transaction and return `500`.
- Consider retries with exponential backoff for transient network errors and implement idempotency (order creation should be idempotent if retried).

## 4.6 Auth & trust boundaries
- All services trust tokens signed with the `JWT_SECRET` stored in K8s secret `ecommerce-secrets`.
- For production, rotate secrets carefully, or use a central identity provider and short-lived tokens.

---

# 5. End-to-end request flows (examples)

### 5.1 Register → Login → Add to cart → Checkout (curl examples)

```bash
# Register
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"pw"}' http://ganga888.online/api/user/register

# Login
TOKEN=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"pw"}' http://ganga888.online/api/user/login | jq -r .token)

# List products
curl -s http://ganga888.online/api/product/products | jq .

# Add first product to cart
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"productId":1,"quantity":2}' http://ganga888.online/api/cart/cart/add

# Checkout
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://ganga888.online/api/order/orders | jq .
```

### 5.2 What headers are required when services call each other?
- `Authorization: Bearer <token>` — required for cart and order operations
- `Content-Type: application/json` — for POST payloads

### 5.3 Internal service internal calls (direct example)
From inside `order-service` code:
```js
const cartRes = await axios.get('http://cart-service.ecommerce.svc.cluster.local/cart', { headers: { Authorization: authHeader } });
const products = await axios.get(`http://product-service.ecommerce.svc.cluster.local/products/${id}`);
```

---

# 6. Local / cluster tests and port-forwarding (how to test)

Quick port-forward commands:
```bash
kubectl -n ecommerce port-forward svc/user-service 30001:80 &
kubectl -n ecommerce port-forward svc/product-service 30002:80 &
kubectl -n ecommerce port-forward svc/cart-service 30003:80 &
kubectl -n ecommerce port-forward svc/order-service 30004:80 &
```
Then test locally using `http://localhost:30001/api/user/login` etc. If port-forward maps to 80 on service that maps to targetPort 3000, use 80.

Test DB connectivity inside pods:
```bash
kubectl -n ecommerce exec -it <user-postgres-pod> -- psql -U user -d userdb -c "SELECT * FROM users;"
```

Test Redis inside pod:
```bash
kubectl -n ecommerce exec -it <cart-redis-pod> -- redis-cli ping
kubectl -n ecommerce exec -it <cart-redis-pod> -- redis-cli keys '*'  # show keys
```

---

# 7. Debugging playbook (step-by-step)

Follow this checklist in order when something is broken. Each step has commands and what to expect.

## 7.1  Validate cluster context
```bash
kubectl config current-context
kubectl version --client
helm version
```
Expect your local kubeconfig points to the intended cluster.

## 7.2 Namespace & pod status
```bash
kubectl get ns
kubectl -n ecommerce get all
kubectl -n ecommerce get pods -o wide
```
Expect: pods `Running`.

## 7.3 If pods are `Pending` or not scheduled
```bash
kubectl -n ecommerce describe pod <pod>
kubectl get nodes -o wide
kubectl describe node <node>
```
Look for `FailedScheduling` reasons: insufficient resources, taints, or unsatisfiable node selectors.

## 7.4 If pod is `CrashLoopBackOff` or `Error`
```bash
kubectl -n ecommerce logs <pod> --previous
kubectl -n ecommerce describe pod <pod>
```
Common causes: missing env vars, DB connection failure, unhandled exception in Node app.

## 7.5 Check logs for the failing service
```bash
kubectl -n ecommerce logs deployment/user-service --tail=200
# or specific pod
kubectl -n ecommerce logs <pod-name> -c <container-name> --tail=500
```
Look for stack traces referencing missing ENV or database errors like `ECONNREFUSED`.

## 7.6 Database checks
- Get Postgres pod name:
```bash
kubectl -n ecommerce get pods -l app=user-postgres
```
- Connect and list tables:
```bash
kubectl -n ecommerce exec -it <user-postgres-pod> -- psql -U user -d userdb -c "\dt"
```
If the init SQL didn't run (missing tables), check whether the PVC already existed. If PVC existed, the init scripts don't run again.

## 7.7 Redis checks
```bash
kubectl -n ecommerce get pods -l app=cart-redis
kubectl -n ecommerce exec -it <cart-redis-pod> -- redis-cli ping
kubectl -n ecommerce exec -it <cart-redis-pod> -- redis-cli keys '*'
```

## 7.8 Ingress & DNS checks
```bash
kubectl -n ingress-nginx get svc ingress-nginx-controller -o wide
kubectl -n ecommerce describe ingress ecommerce-ingress
dig +short ganga888.online
```
Expect the domain to resolve to ingress `EXTERNAL-IP`.

## 7.9 Cross-service network and DNS checks
- Run a debug pod and test DNS/service reachability:
```bash
kubectl -n ecommerce run -it --rm debug --image=radial/busyboxplus:curl -- sh
# inside debug pod
nslookup cart-service
curl -sS http://cart-service:80/healthz
```

## 7.10 JWT / Authorization failures (401)
- Inspect secret:
```bash
kubectl -n ecommerce get secret ecommerce-secrets -o yaml
# decode JWT_SECRET
kubectl -n ecommerce get secret ecommerce-secrets -o jsonpath='{.data.JWT_SECRET}' | base64 -d
```
- Ensure each service has `JWT_SECRET` env var from the same secret
- Confirm token has expected payload:
```bash
# print token payload (base64 decode middle part)
echo <token> | cut -d '.' -f2 | base64 -d | jq .
```

## 7.11 Image pull errors
```bash
kubectl -n ecommerce describe pod <pod>  # look for ErrImagePull
```
- Confirm image exists in the registry and tag is correct
- For private registry, ensure `imagePullSecrets` is configured in deployment spec and matching secret exists

## 7.12 Reproduce & fix the error locally
- Port-forward service and reproduce exact failing request from your workstation
- Example example: port-forward order-service and run the `POST /orders` request with the same Authorization header

---

# 8. Troubleshooting matrix (quick)

| Symptom | Likely cause | Quick check | Fix |
|---|---|---|---|
| App 502 or 504 via Ingress | Upstream pod crash or readiness failing | `kubectl -n ecommerce get pods` | fix pod or adjust probes |
| 401 Unauthorized | JWT secret mismatch | `kubectl -n ecommerce get secret ecommerce-secrets -o yaml` | ensure same `JWT_SECRET` in env |
| 500 error on checkout | product call failed or DB transaction failed | check `order-service` logs | inspect product and cart service logs; check DB connectivity |
| Empty cart after checkout not cleared | cart/clear endpoint failed | check cart-service logs after order | ensure `order-service` calls cart clear and passes auth header |
| Init SQL not applied | PVC pre-existed preventing container init scripts | `kubectl -n ecommerce get pvc` | drop PVC (dev) or run manual SQL injection into DB |
| DNS (service) not resolving | wrong namespace or service name | nslookup from debug pod | correct service name or change deployment references |

---

# 9. Advanced: production considerations & improvements

- Use managed DBs (RDS) instead of in-cluster Postgres
- Use External Secrets (AWS Secrets Manager) and rotate secrets
- Add circuit-breaker (e.g., `opossum` or client-side logic) for inter-service calls
- Add tracing (OpenTelemetry) and correlation IDs for distributed traces
- Add retries with backoff for transient errors and idempotency keys for operations
- Centralize logs (Fluent Bit -> Elasticsearch / Loki) and metrics (Prometheus + Grafana)

---

# 10. Quick reference: commands (cheat sheet)

- Check pods: `kubectl -n ecommerce get pods -o wide`
- Pod logs: `kubectl -n ecommerce logs <pod>`
- Exec into pod: `kubectl -n ecommerce exec -it <pod> -- sh`
- Port forward: `kubectl -n ecommerce port-forward svc/user-service 30001:80`
- Restart deployment: `kubectl -n ecommerce rollout restart deployment/<name>`
- Describe ingress: `kubectl -n ecommerce describe ingress ecommerce-ingress`

---

If you want any of the following next, tell me which and I will add it to the repository:
- Add per-service `README.md` files with endpoint examples and sample responses.
- Create a PNG/SVG of the architecture diagram and add it to the repo.
- Generate a `README.md` tailored for a specific cloud (EKS/GKE/AKS) with provider-specific notes.

Happy to continue — what should I create next?

---

## 🌍 Test Application

### Using Browser
Open: [https://ganga888.online](https://ganga888.online)

### Using curl
```bash
# Register
curl -X POST https://ganga888.online/api/user/register   -H "Content-Type: application/json"   -d '{"username":"alice","password":"pw"}'

# Login
TOKEN=$(curl -s -X POST https://ganga888.online/api/user/login   -H "Content-Type: application/json"   -d '{"username":"alice","password":"pw"}' | jq -r .token)

# List products
curl https://ganga888.online/api/product/products

# Add to cart
curl -X POST https://ganga888.online/api/cart/cart/add   -H "Authorization: Bearer $TOKEN"   -H "Content-Type: application/json"   -d '{"productId":1,"quantity":2}'

# Checkout
curl -X POST https://ganga888.online/api/order/orders   -H "Authorization: Bearer $TOKEN"
```

---

## 🧹 Cleanup
```bash
kubectl delete namespace ecommerce
helm uninstall ingress-nginx -n ingress-nginx
helm uninstall cert-manager -n cert-manager
```

---

## 📌 Notes

- StatefulSets use `storageClassName: gp3` for AWS EBS volumes.  
- Each microservice has its own database for loose coupling.  
- TLS is automatically provisioned via Let’s Encrypt (cert-manager).
