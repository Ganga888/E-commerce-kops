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

