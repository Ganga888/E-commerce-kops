# Realtime Microservices Platform — 10-Module Build & Interview Guide

A production-grade, three-tier microservices application on AWS EKS, built module
by module. Each module explains **what you build**, **the tools**, **the key
decisions and the reasoning behind them** (this is what interviewers probe), and
**likely interview questions with model answers**.

**The big picture in one sentence:** developers write 12 microservices in mixed
languages, push to GitHub, two CI/CD pipelines (Jenkins for app code, GitHub
Actions for Terraform) build and ship them, Terraform provisions AWS infra, the
workloads run on EKS behind an ALB/CloudFront edge, talk to RDS/Redis/MSK, and
everything is observed by Prometheus/Grafana, EFK and Jaeger.

| # | Module | Core tools |
|---|--------|-----------|
| 1 | Infrastructure as Code | Terraform, AWS |
| 2 | Infra CI/CD pipeline | GitHub Actions, OIDC, tfsec |
| 3 | Cluster platform bootstrap | Helm, ArgoCD, External Secrets, cert-manager |
| 4 | Microservices design & containerization | Java/Node/Python, Docker, OpenAPI |
| 5 | Application CI pipeline | Jenkins, SonarQube, Trivy, ECR |
| 6 | CD / GitOps deployment | ArgoCD, Helm charts |
| 7 | Event-driven & realtime layer | Kafka (MSK/Strimzi), Redis, WebSockets |
| 8 | Configuration management | Ansible |
| 9 | Observability & security | Prometheus, Grafana, EFK, Jaeger, OPA |
| 10 | End-to-end testing & teardown | k6, Postman/Newman, chaos, `terraform destroy` |

---

## Module 1 — Infrastructure as Code (Terraform)

### Goal
Provision every AWS resource the platform needs, as code, so it's reproducible,
reviewable, and destroyable in one command.

### What you build
VPC across 3 AZs (public + private subnets, NAT gateway), EKS cluster with a
managed node group, ECR repositories (one per service), RDS PostgreSQL (Multi-AZ),
ElastiCache Redis, Amazon MSK (Kafka), S3 buckets, security groups, and the edge
tier (Route 53, ACM, WAF). Remote state in S3 with DynamoDB locking.

### Tools
Terraform, AWS provider, community modules (`terraform-aws-modules/vpc`,
`.../eks`), AWS CLI, kubectl.

### Key decisions and the reasoning

- **Why IaC at all?** Manual console clicks aren't repeatable or auditable. With
  Terraform the infra is version-controlled, peer-reviewed in PRs, and you can
  rebuild an identical environment in any region. This is the foundation of
  immutable, reproducible infrastructure.
- **Why remote state (S3 + DynamoDB)?** State is Terraform's record of what
  exists. Local state can't be shared by a team and has no locking. S3 stores it
  centrally and encrypted; the DynamoDB table provides a **state lock** so two
  engineers can't `apply` simultaneously and corrupt it.
- **Why modules?** Reusability and a smaller blast radius. The same VPC/EKS
  modules build dev, staging, and prod with different variables — DRY infra.
- **Why EKS over self-managed kops?** EKS is a managed control plane: AWS runs
  and patches the API servers and etcd, and it integrates cleanly with IAM via
  IRSA. kops means you own etcd backups and control-plane upgrades — more
  operational burden for no benefit on AWS.
- **Why database-per-service / separate data stores?** Loose coupling. Each
  microservice owns its data; no service reaches into another's tables. This is
  a core microservices principle that prevents hidden coupling.

### Interview Q&A

**Q: What is Terraform state and why does it matter?**
State is the JSON file mapping your config to real-world resource IDs. Terraform
uses it to compute the diff between desired and actual state on every plan.
Without it Terraform wouldn't know what it already created. It can contain
secrets, so it's stored encrypted in S3, never in Git.

**Q: `terraform plan` vs `apply` vs `destroy`?**
`plan` shows the diff (what will change) without touching anything — your safety
check. `apply` executes it. `destroy` removes everything in state — the clean
teardown.

**Q: How do you manage multiple environments?**
Separate state files (via workspaces or, better, separate root directories/state
keys per env) reusing the same modules with different `.tfvars`. Separate state
per environment avoids a dev change ever touching prod.

**Q: What's a state lock and what happens without one?**
A mutex (DynamoDB) that prevents concurrent applies. Without it, two simultaneous
applies can race and corrupt state, leaving resources orphaned or duplicated.

**Q: How do you handle secrets in Terraform?**
Never hardcode them. Use `manage_master_user_password` (AWS Secrets Manager) for
RDS, reference Secrets Manager/SSM data sources, and keep state encrypted. Mark
sensitive outputs `sensitive = true`.

### Connects to
Module 2 wraps this Terraform in an automated pipeline.

---

## Module 2 — Infrastructure CI/CD pipeline (GitHub Actions)

### Goal
Stop running `terraform apply` from laptops. Automate `init → plan → apply` with
review gates and security scanning, triggered by Git.

### What you build
A GitHub Actions workflow in the `platform-terraform` repo: on a pull request it
runs `fmt`, `validate`, `init`, `plan`, posts the plan as a PR comment, and runs
a security scan; on merge to `main` it runs `apply` behind a manual approval.

### Tools
GitHub Actions, AWS OIDC federation, tfsec/Checkov, `terraform fmt/validate`.

### Key decisions and the reasoning

- **Why GitHub Actions for infra (and Jenkins for app)?** A deliberate split.
  Infra changes are Git-native, low-frequency, and benefit from PR-based review
  with plan-as-comment — Actions does this natively. App builds are
  high-frequency and benefit from Jenkins' mature build ecosystem and shared
  libraries. Using the right tool per job is itself a talking point.
- **Why OIDC instead of AWS access keys?** Long-lived `AWS_ACCESS_KEY_ID`
  secrets are a leak risk. OIDC lets the Actions runner assume an IAM role with
  short-lived temporary credentials — **no static secrets in GitHub at all**.
  This is the modern best practice.
- **Why plan on PR, apply on merge with approval?** `plan` on the PR makes the
  change reviewable before anything happens. Gating `apply` behind a GitHub
  Environment approval gives a human the final say on production infra.
- **Why scan IaC (tfsec/Checkov)?** Catches misconfigurations (public S3, open
  security groups, unencrypted volumes) at PR time — shift-left security.

### Interview Q&A

**Q: Why two separate CI/CD systems?**
Right tool for each job: Actions for Git-native, review-gated infra changes;
Jenkins for high-volume application builds with shared pipeline libraries.

**Q: How does OIDC auth to AWS work?**
GitHub issues a signed OIDC token to the workflow; AWS trusts GitHub as an
identity provider and exchanges that token (scoped to repo/branch) for temporary
STS credentials via an assumed IAM role. No stored keys.

**Q: How do you prevent a bad infra change reaching prod?**
PR review of the plan, IaC security scan, required approvals, branch protection,
and a manual approval gate on the apply job.

**Q: What is "shift-left" in this context?**
Moving checks (security, validation, cost) as early as possible — to PR time —
so problems are caught before merge, not in production.

### Connects to
With infra automated, Module 3 turns the empty cluster into a usable platform.

---

## Module 3 — Cluster platform bootstrap

### Goal
A fresh EKS cluster is empty. Install the shared platform services every
application depends on.

### What you build
Ingress controller (NGINX or AWS Load Balancer Controller) so traffic can reach
pods; **ArgoCD** for GitOps deployments; **External Secrets Operator** to sync
secrets from AWS Secrets Manager into the cluster; **cert-manager** for TLS;
**Metrics Server** + autoscaling (Cluster Autoscaler or Karpenter); namespaces
and RBAC.

### Tools
Helm, ArgoCD, External Secrets Operator, cert-manager, Karpenter, kubectl.

### Key decisions and the reasoning

- **Why an ingress controller?** Kubernetes Services alone don't do host/path
  HTTP routing or TLS termination. The ingress controller (and the ALB it
  provisions) is the single front door routing `/api/orders` to the order
  service, `/api/cart` to cart, etc.
- **Why IRSA (IAM Roles for Service Accounts)?** So a pod gets exactly the AWS
  permissions it needs (e.g. read one Secrets Manager secret, write one S3
  bucket) via its service account — **least privilege**, no node-wide creds, no
  static keys baked into images.
- **Why External Secrets Operator?** Secrets shouldn't live in Git. ESO pulls
  them from Secrets Manager at runtime and projects them as Kubernetes Secrets,
  so the GitOps repo only references secret *names*, never values.
- **Why Helm?** It packages Kubernetes manifests as versioned, parameterized
  charts — templating + release management instead of hand-maintaining hundreds
  of raw YAML files.
- **Why Karpenter over Cluster Autoscaler?** Karpenter provisions right-sized
  nodes in seconds based on pending pods, and consolidates underused nodes —
  faster and cheaper than node-group-based scaling.

### Interview Q&A

**Q: How does external traffic reach a pod?**
Client → Route 53 → (CloudFront/WAF) → ALB → ingress controller → Service →
pod. The ingress rules map hostnames/paths to Services; kube-proxy/Service
load-balances to healthy pods.

**Q: What's IRSA and why not just use node IAM roles?**
IRSA binds an IAM role to a Kubernetes service account via the cluster's OIDC
provider, so each pod assumes only its own role. Node roles would give every pod
on that node the same broad permissions — a least-privilege violation.

**Q: Liveness vs readiness probes?**
Liveness restarts a hung container; readiness controls whether a pod receives
traffic. A pod can be alive but not ready (e.g. still warming a cache) — readiness
keeps traffic away until it's ready.

**Q: What is a Pod Disruption Budget?**
A guarantee of minimum available replicas during voluntary disruptions (node
drains, upgrades), so a rollout or scale-down can't take a service fully offline.

### Connects to
The platform is ready; Module 4 builds the actual services to run on it.

---

## Module 4 — Microservices design & containerization

### Goal
Build the 12 services, in their respective languages, as cleanly containerized,
independently deployable units.

### What you build
The services: API Gateway + Auth + User (Java/Spring Boot), Product/Order/
Inventory/Shipping (Java), Cart + Notification + Review (Node.js), Search +
Payment + Recommendation + Analytics (Python). Each with a Dockerfile, health
endpoints, config via env vars, and an API contract (OpenAPI/protobuf).

### Tools
Spring Boot, Express/NestJS, FastAPI, Docker (multi-stage builds), OpenAPI,
gRPC/protobuf for internal contracts.

### Key decisions and the reasoning

- **Why microservices over a monolith?** Independent deployability, per-service
  scaling, language freedom (use Python for ML, Java for transactional cores),
  and team autonomy. The trade-off is operational complexity — which is exactly
  why the rest of these modules exist.
- **Why an API Gateway?** One entry point for cross-cutting concerns: auth/JWT
  validation, rate limiting, routing, request aggregation — so individual
  services don't each reimplement them.
- **Why the 12-factor principles?** Config from the environment, stateless
  processes, logs to stdout, disposability — these make a service portable and
  horizontally scalable on Kubernetes.
- **Why multi-stage Docker builds?** Build in a fat image (JDK, full toolchain),
  ship only the runtime artifact in a slim final image — smaller images, smaller
  attack surface, faster pulls.
- **Why explicit API contracts?** With 12 services in different languages, a
  shared OpenAPI/protobuf contract is the agreed interface, enabling
  independent development and consumer-driven contract testing.

### Interview Q&A

**Q: How do services communicate?**
Synchronous request/response over REST or gRPC for queries; asynchronous events
over Kafka for state changes. Prefer async to reduce coupling and improve
resilience.

**Q: How do you handle a transaction spanning services (order → payment → inventory)?**
You can't use a distributed ACID transaction. Use the **saga pattern**: a
sequence of local transactions, each emitting an event; if a step fails, run
compensating transactions to undo prior steps. (Detailed in Module 7.)

**Q: Why database-per-service?**
To enforce loose coupling — a service can change its schema without breaking
others. Shared databases create hidden coupling and turn microservices back into
a distributed monolith.

**Q: How do you keep image sizes and vulnerabilities down?**
Multi-stage builds, minimal base images (distroless/alpine), non-root user, and
image scanning in CI (Module 5).

**Q: How does service discovery work here?**
Kubernetes DNS — a service reaches another at `http://order-service.namespace
.svc.cluster.local`. No external discovery system needed inside the cluster.

### Connects to
Module 5 builds and ships these container images automatically.

---

## Module 5 — Application CI pipeline (Jenkins)

### Goal
On every merge, automatically build, test, scan, and publish each service's
container image — with no manual steps.

### What you build
A `Jenkinsfile` per service (or a shared pipeline library): checkout → unit
tests → static analysis (SonarQube) → build → containerize → **scan image
(Trivy)** → push to ECR → update the GitOps config repo with the new image tag.

### Tools
Jenkins, shared pipeline libraries, SonarQube, Trivy, Docker/Kaniko, AWS ECR.

### Key decisions and the reasoning

- **Why does CI stop at "push image + bump tag" and not deploy?** Separation of
  CI and CD. CI's job is to produce a trusted, versioned artifact. Deployment is
  handled by GitOps (Module 6), which gives auditability, drift detection, and
  one-click rollback. Jenkins running `kubectl apply` directly is push-based and
  harder to audit.
- **Why scan images (Trivy) in CI?** To block known-vulnerable images from ever
  reaching the registry — supply-chain security, shift-left.
- **Why SonarQube?** Automated code-quality and security gates (bugs, code
  smells, coverage thresholds) enforced before merge.
- **Why a shared pipeline library?** 12 services shouldn't each maintain a
  bespoke pipeline. A shared library means one place to update the build logic
  for all of them — DRY CI.
- **Why immutable, uniquely-tagged images (git SHA, not `latest`)?** So every
  deploy is traceable to an exact commit and rollbacks are deterministic.
  `latest` is ambiguous and unrepeatable.

### Interview Q&A

**Q: Walk me through your CI pipeline stages.**
Checkout → test → static analysis/quality gate → build → containerize → image
scan → push to ECR → update GitOps repo image tag. Fail fast: a failing test or
quality gate stops the pipeline.

**Q: Why not let Jenkins deploy to the cluster directly?**
Push-based deploys are harder to audit and can drift from Git. Decoupling CI
(build artifact) from CD (GitOps reconcile) gives a single source of truth,
self-healing, and trivial rollback.

**Q: How do you secure the pipeline?**
Least-privilege credentials (IRSA/OIDC, not static keys), image and dependency
scanning, signed images (cosign), and no secrets in logs.

**Q: How do you tag images?**
Immutable tags from the Git commit SHA (plus semver on releases). Never `latest`
for deployments.

### Connects to
Module 6 picks up the new image tag and rolls it out.

---

## Module 6 — CD / GitOps deployment (ArgoCD + Helm)

### Goal
Deploy and keep the cluster's actual state continuously matching a declarative
desired state in Git.

### What you build
A Git "config" repo holding Helm charts / manifests for all services. ArgoCD
watches it and **reconciles** the cluster to match. When Module 5 bumps an image
tag in this repo, ArgoCD deploys it automatically (or after sync approval).

### Tools
ArgoCD, Helm, Kustomize (optionally), Argo Rollouts (canary/blue-green).

### Key decisions and the reasoning

- **Why GitOps (pull) over push?** Git becomes the single source of truth. The
  cluster's state is always traceable to a commit; ArgoCD detects and corrects
  **drift**; rollback is `git revert`. Pull-based agents inside the cluster also
  mean no external CI system needs cluster credentials.
- **Why ArgoCD specifically?** It visualizes app health and sync status, supports
  automated sync, self-heal, and easy rollback, and scales to many services/
  clusters cleanly.
- **Why Helm values per environment?** The same chart deploys to dev/staging/prod
  with different replica counts, resources, and config via values files — one
  chart, many environments.
- **Why Argo Rollouts for releases?** Canary and blue-green strategies shift
  traffic gradually and auto-rollback on bad metrics, instead of a risky
  all-at-once rolling update.

### Interview Q&A

**Q: What is GitOps?**
An operating model where the desired state of the system lives in Git and an
in-cluster agent continuously reconciles actual state to it. Deploys are commits;
rollbacks are reverts.

**Q: Push vs pull deployment — why does it matter?**
Push (CI runs kubectl) puts cluster creds in the CI system and can drift
silently. Pull (ArgoCD) keeps creds in-cluster, detects drift, and self-heals.

**Q: How do you roll back a bad release?**
`git revert` the config commit (ArgoCD re-syncs), or roll back to the previous
synced revision in ArgoCD. With Argo Rollouts, a failing canary auto-aborts.

**Q: Rolling update vs blue-green vs canary?**
Rolling replaces pods gradually (default, simple). Blue-green runs a full second
version then switches traffic (instant cutover/rollback). Canary sends a small %
of traffic to the new version and ramps up if metrics stay healthy.

### Connects to
With deployment automated, Module 7 builds the realtime, event-driven behaviour.

---

## Module 7 — Event-driven & realtime layer

### Goal
Make the system actually "realtime": services react to each other via events, and
the browser gets live updates.

### What you build
Kafka topics (order events, inventory events, notifications) on MSK (or Strimzi
in-cluster); producers/consumers in the services; Redis for caching and pub/sub
fan-out; a WebSocket/SSE Notification service that pushes live updates to clients;
and the **saga pattern** for the order→payment→inventory flow.

### Tools
Kafka (Amazon MSK or Strimzi), Redis (ElastiCache), WebSockets/SSE, schema
registry (Avro/Protobuf).

### Key decisions and the reasoning

- **Why Kafka as the backbone?** Durable, ordered, replayable event log that
  decouples producers from consumers. The order service emits an `OrderPlaced`
  event and doesn't care who consumes it — inventory, notification, and analytics
  all react independently. This is the heart of event-driven architecture.
- **Why async events over synchronous calls for state changes?** Resilience and
  scalability. If the notification service is down, events queue in Kafka and are
  processed when it recovers — no cascading failure, no lost work.
- **Why the saga pattern?** Distributed transactions across services can't be
  ACID. A saga is a series of local transactions with compensating actions: if
  payment fails after the order is created, a compensating event cancels the
  order and releases inventory — eventual consistency done safely.
- **Why Redis pub/sub + WebSockets for realtime?** Kafka moves events between
  services; the Notification service holds the browser's WebSocket and pushes the
  relevant update instantly. Redis pub/sub fans a message out to whichever
  Notification pod holds that user's connection.
- **Why a schema registry?** With many producers/consumers, schemas evolve. A
  registry enforces compatibility so a producer change can't silently break
  consumers.

### Interview Q&A

**Q: What problem does Kafka solve here?**
Decoupling and durability. Services communicate through an append-only event log
instead of direct calls, so they scale and fail independently and events can be
replayed.

**Q: Explain consumer groups and partitions.**
A topic is split into partitions for parallelism; a consumer group divides
partitions among its members so each message is processed once per group. More
partitions = more parallel consumers. Ordering is guaranteed within a partition.

**Q: How do you guarantee a payment is processed exactly once?**
Idempotency: each event carries a unique key; the consumer records processed keys
and skips duplicates. Combined with Kafka's at-least-once delivery, this yields
effectively-once processing.

**Q: How does a browser get a live update?**
The client opens a WebSocket to the Notification service; when an event flows
through Kafka/Redis for that user, the holding pod pushes it down the open
socket — no polling.

**Q: What is eventual consistency and is it acceptable?**
Different services' data converges to a consistent state over time rather than
instantly. For most flows (order status, inventory counts) it's an acceptable and
deliberate trade-off for availability and decoupling.

### Connects to
Module 8 manages the host/OS-level configuration these systems sometimes need.

---

## Module 8 — Configuration management (Ansible)

### Goal
Manage configuration that lives outside Kubernetes — host bootstrap, OS
hardening, and repeatable operational runbooks.

### What you build
Ansible roles and playbooks for: bootstrapping any EC2-based components (bastion,
self-managed runners, monitoring nodes), OS hardening (CIS benchmarks), agent
installation, and one-off operational tasks. Inventories per environment.

### Tools
Ansible (roles, playbooks, dynamic inventory), Ansible Vault.

### Key decisions and the reasoning

- **Where does Ansible fit when you already have Kubernetes?** Inside the cluster,
  configuration is Helm values and ConfigMaps. Ansible owns the **host and
  bootstrap layer** — anything not running as a pod: EC2 hosts, hardening, and
  procedural runbooks. Knowing this boundary is itself an interview point.
- **Why Ansible over chef/puppet?** Agentless (SSH), declarative YAML, low
  learning curve, and huge module ecosystem. No agent to install and maintain on
  every host.
- **Why idempotent playbooks?** Running the same playbook twice must produce the
  same result. Idempotency makes config convergent and safe to re-run.
- **Why dynamic inventory?** Hosts come and go in the cloud; dynamic inventory
  queries AWS tags at runtime instead of maintaining a static host list.
- **Why Ansible Vault?** To encrypt sensitive values (keys, passwords) inside
  playbooks/vars so they can be committed safely.

### Interview Q&A

**Q: Ansible vs Terraform — when do you use which?**
Terraform **provisions** cloud resources (declarative, state-tracked). Ansible
**configures** what's inside/on them (procedural-ish, idempotent). Provision with
Terraform, configure with Ansible.

**Q: What makes a playbook idempotent?**
Modules that check current state and only change what's needed (e.g. `state:
present`), rather than blindly running commands. Re-running causes no further
change.

**Q: Why is Ansible "agentless" an advantage?**
No software to install/upgrade/secure on managed nodes — it connects over SSH,
reducing operational overhead and attack surface.

**Q: In a Kubernetes-heavy stack, is Ansible still relevant?**
Yes, for the host layer and bootstrap that Kubernetes doesn't manage: node
hardening, EC2-based tooling, and runbook automation.

### Connects to
Module 9 makes the whole system observable and secure.

---

## Module 9 — Observability & security

### Goal
See what the system is doing (metrics, logs, traces), get alerted before users
notice, and enforce security across the cluster.

### What you build
**Metrics:** Prometheus scraping cluster + app `/metrics`, Grafana dashboards,
Alertmanager. **Logging:** structured JSON logs → Fluent Bit → Elasticsearch →
Kibana (EFK). **Tracing:** OpenTelemetry SDKs → Jaeger, following one request
across all services. **Security:** NetworkPolicies, Pod Security Standards, RBAC,
OPA/Gatekeeper policies, image signing.

### Tools
Prometheus, Grafana, Alertmanager, Fluent Bit, Elasticsearch, Kibana, Jaeger,
OpenTelemetry, OPA/Gatekeeper.

### Key decisions and the reasoning

- **Why the three pillars (metrics, logs, traces)?** Each answers a different
  question. Metrics: *is something wrong?* (rates, latency, saturation). Logs:
  *what exactly happened?* (the detail). Traces: *where in the 12-service chain
  did it happen?* You need all three to debug distributed systems.
- **Why Prometheus' pull model?** Prometheus scrapes targets it discovers via
  Kubernetes service discovery, so it always knows what's up and can alert on a
  target simply disappearing. Pull also simplifies the app side (just expose
  `/metrics`).
- **Why distributed tracing is essential here?** A single user request can touch
  6+ services. Without a trace ID propagated across them, a latency spike is
  nearly impossible to localize. OpenTelemetry stitches the spans into one trace.
- **Why alert on SLOs / burn rate, not raw thresholds?** Raw CPU alerts are
  noisy. SLO burn-rate alerts fire on user-facing impact ("we're spending our
  error budget too fast"), which is what actually matters.
- **Why NetworkPolicies + RBAC + OPA?** Defense in depth: NetworkPolicies
  restrict pod-to-pod traffic (zero-trust networking), RBAC restricts who/what
  can do what in the cluster, OPA/Gatekeeper enforces guardrails (no privileged
  pods, required labels) at admission time.

### Interview Q&A

**Q: Difference between monitoring and observability?**
Monitoring tells you *whether* known things are broken (predefined dashboards/
alerts). Observability lets you ask *new* questions about unknown problems from
rich telemetry (metrics + logs + traces) — crucial in distributed systems.

**Q: How would you debug a slow request across 12 services?**
Start with the trace (Jaeger) to find which span is slow, drill into that
service's logs (Kibana) for detail, and check its metrics/dashboards (Grafana)
for saturation. The propagated trace ID ties them together.

**Q: Pull vs push metrics?**
Prometheus pulls from discovered targets (knows liveness, simple clients); push
systems (StatsD) suit short-lived jobs. Prometheus uses a Pushgateway for those.

**Q: What's an error budget?**
The allowed amount of unreliability under an SLO (e.g. 0.1% errors for 99.9%).
You alert when you're burning it too fast and can gate risky releases on it.

**Q: How do you secure the cluster?**
RBAC (least privilege), IRSA (per-pod AWS perms), NetworkPolicies (restrict
traffic), Pod Security Standards (no privileged/root), OPA admission policies,
image scanning + signing, and secrets via External Secrets, not Git.

### Connects to
Module 10 validates the entire thing works end to end.

---

## Module 10 — End-to-end testing, validation & teardown

### Goal
Prove the whole platform works as one system — a real user journey across all
tiers — then tear it down cleanly.

### What you build
End-to-end functional tests of a full user flow (register → browse → add to cart
→ order → pay → live notification), API contract tests, a load test, a basic
chaos test, smoke tests post-deploy, and the teardown procedure.

### Tools
Postman/Newman or REST-assured (functional/API), k6 or Locust (load), Litmus/
chaos-mesh (chaos), kubectl, `terraform destroy`.

### Key decisions and the reasoning

- **Why test the journey, not just units?** Unit tests (Module 5) prove a service
  works alone. E2E tests prove the **integration**: gateway → auth → order →
  Kafka → inventory → notification → WebSocket all cooperate. This is where
  distributed bugs surface.
- **What does the realtime flow validation look like?** Place an order via the
  API, assert the `OrderPlaced` event flows through Kafka, inventory decrements,
  and the WebSocket client receives the live notification — end to end across all
  three tiers.
- **Why load testing?** To validate autoscaling (HPA/Karpenter actually add
  pods/nodes under load), find the breaking point, and verify latency SLOs hold
  under realistic traffic.
- **Why chaos testing?** Kill a pod / an AZ and confirm the system self-heals
  (Kubernetes reschedules, Kafka rebalances, traffic reroutes) — proving the
  resilience claims are real, not theoretical.
- **Why smoke tests after every deploy?** A fast post-deploy check (key endpoints
  return 200, can reach DB/Kafka) catches a broken release immediately and can
  trigger auto-rollback.
- **Why is disciplined teardown part of the plan?** For a cost-controlled lab,
  `terraform destroy` plus verifying no orphaned load balancers / EBS / NAT
  remain is what keeps the bill at zero after you're done.

### Interview Q&A

**Q: How do you test a microservices system end to end?**
Layered: unit tests per service, contract tests between services, integration
tests against real dependencies, and full E2E tests of the user journey through
the deployed system, plus load and chaos tests for non-functional guarantees.

**Q: How do you verify the realtime/event-driven part works?**
Trigger an action that emits an event, then assert the downstream effects:
consumer state changed, and the client received the pushed update over its
WebSocket — confirming the whole async chain.

**Q: How do you validate autoscaling?**
Drive load with k6, watch HPA add pod replicas and Karpenter add nodes, confirm
latency stays within SLO, then watch it scale back down when load drops.

**Q: What is chaos engineering and why do it?**
Deliberately injecting failures (kill pods, drop a node/AZ, add latency) in a
controlled way to verify the system degrades gracefully and self-heals — turning
resilience from an assumption into a tested fact.

**Q: How do you ensure a clean, cost-safe teardown?**
Delete Kubernetes LoadBalancer/Ingress resources first (so their ALBs are
released), `terraform destroy`, then verify the console for orphaned ELBs, EIPs,
NAT gateways, and EBS volumes.

---

## How the modules fit together (the 60-second whiteboard story)

1. **Terraform** (M1) provisions AWS, run by a **GitHub Actions** pipeline (M2).
2. The EKS cluster is bootstrapped with **platform services** — ingress, ArgoCD,
   secrets, autoscaling (M3).
3. Developers build **12 containerized microservices** (M4); **Jenkins** builds,
   tests, scans, and publishes each image (M5).
4. **ArgoCD/GitOps** reconciles the cluster to the desired state in Git (M6).
5. Services communicate through **Kafka events + Redis + WebSockets** for
   realtime behaviour, with **sagas** for distributed transactions (M7).
6. **Ansible** manages the host/OS layer outside Kubernetes (M8).
7. **Prometheus/Grafana/EFK/Jaeger** make it observable and **RBAC/NetworkPolicies/
   OPA** make it secure (M9).
8. **End-to-end, load, and chaos tests** prove it works as one system, then a
   clean **teardown** controls cost (M10).

If an interviewer asks "tell me about a project," you can walk this exact path:
problem → architecture → each module's decision and trade-off → how you validated
and operated it.
