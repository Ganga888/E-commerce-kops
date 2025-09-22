# E-Commerce Microservices on Kubernetes (kOps) — `ganga888.online`

This repo contains a minimal, production-shaped e-commerce app modeled after Flipkart/Amazon with **four microservices** and a tiny frontend. It’s built to run on a **kOps** Kubernetes cluster (1 control-plane, 3 workers) and exposes the app at **https://ganga888.online**.

> ✅ You asked for **one database per microservice** and **JWT auth** — implemented below.  
> ✅ All workloads run with **3 replicas** and **pod anti-affinity** to spread across the 3 worker nodes.

---

## 0) Architecture at a glance

**Services**
- `user-service` — signup/login, issues JWT. DB: **Postgres (userdb)**
- `product-service` — product catalog (list/details). DB: **Postgres (productdb)**
- `cart-service` — per-user cart stored in **Redis**
- `order-service` — checkout + order history. DB: **Postgres (orderdb)**
- `frontend` — static HTML/JS calling the APIs

**Kubernetes components & why we use them**
- **Namespace** (`ecommerce`) — logical isolation
- **Secret** — JWT secret + DB passwords (sensitive)
- **ConfigMap** — DB init SQL files (non-sensitive)
- **StatefulSet + PVC** — Postgres & Redis persistent storage and stable identity
- **Deployment** — stateless app pods (3 replicas each)
- **Service (ClusterIP)** — stable in-cluster virtual IP per service
- **Ingress** — single external entry (`ganga888.online`) routing to services
- **Probes** — liveness/readiness to keep only healthy pods in rotation
- **podAntiAffinity** — spread replicas across worker nodes for resilience

---

## 1) Prerequisites

- A working **kOps** cluster on AWS (or similar) with `kubectl` access.
- **Helm** installed locally.
- A container registry (Docker Hub or AWS ECR).
- Control of the DNS zone for **ganga888.online** (Route 53, Cloudflare, etc.).

> If your cluster already exists, you can skip any kOps setup and continue.

---

## 2) Repo layout (create these folders/files)




---

## 3) Application code & Dockerfiles

> Replace **`<your-registry>`** everywhere with your registry (e.g., `docker.io/yourname` or your ECR URI).

### 3.1 `user-service` (JWT auth, Postgres)
**`user-service/package.json`**
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
---
## 🚀 Build & Push Images

From each service folder:

```bash
docker build -t <your-registry>/user-service:latest ./user-service
docker push <your-registry>/user-service:latest

docker build -t <your-registry>/product-service:latest ./product-service
docker push <your-registry>/product-service:latest

docker build -t <your-registry>/cart-service:latest ./cart-service
docker push <your-registry>/cart-service:latest

docker build -t <your-registry>/order-service:latest ./order-service
docker push <your-registry>/order-service:latest

docker build -t <your-registry>/ecommerce-frontend:latest ./frontend
docker push <your-registry>/ecommerce-frontend:latest
```

---

---

## ☸️ Kubernetes Deployment

1. **Namespace, Secrets, ConfigMaps**
   ```bash
   kubectl apply -f k8s/namespace.yaml
   kubectl apply -f k8s/secrets.yaml
   kubectl apply -f k8s/configmaps-dbinit.yaml
   ```

2. **Databases (gp3 storage)**
   ```bash
   kubectl apply -f k8s/user-postgres-statefulset.yaml
   kubectl apply -f k8s/product-postgres-statefulset.yaml
   kubectl apply -f k8s/order-postgres-statefulset.yaml
   kubectl apply -f k8s/redis-statefulset.yaml
   ```

3. **Deploy microservices**
   ```bash
   kubectl apply -f k8s/deployments/
   kubectl apply -f k8s/services/
   ```

4. **Ingress Controller (NGINX)**
   ```bash
   helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
   helm repo update
   helm install ingress-nginx ingress-nginx/ingress-nginx      --namespace ingress-nginx --create-namespace
   ```

5. **Ingress Resource (TLS with cert-manager)**
   - Make sure `ganga888.online` points to Ingress LoadBalancer.  
   - Install cert-manager:
     ```bash
     helm repo add jetstack https://charts.jetstack.io
     helm repo update
     helm install cert-manager jetstack/cert-manager        --namespace cert-manager --create-namespace        --set installCRDs=true
     ```
   - Apply ClusterIssuer and Ingress:
     ```bash
     kubectl apply -f k8s/clusterissuer-letsencrypt.yaml
     kubectl apply -f k8s/ingress.yaml
     ```

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
