# homelab

Pure GitOps homelab running on 3 bare-metal nodes, provisioned with
[Talos Linux](https://www.talos.dev/) and managed end-to-end by
[ArgoCD](https://argo-cd.readthedocs.io/) from this repo.

## Hardware

| | |
|---|---|
| Compute | 3x HP EliteDesk (i5, Intel iGPU / Quick Sync), each a combined control-plane + worker node |
| OS | [Talos Linux](https://www.talos.dev/) — immutable, API-managed, no SSH |
| Storage | NVMe/SSD on each node (local, distributed) + an existing Unraid NAS over NFS |

## Stack

| Concern | Tool |
|---|---|
| OS / node config | Talos Linux, declared in [`talos/`](talos/) via [talhelper](https://budimanjojo.github.io/talhelper/) |
| CNI / LB / kube-proxy replacement | [Cilium](https://cilium.io/) (installed by Talos at bootstrap, see [`talos/manifests`](talos/manifests/)) |
| Ingress | Traefik |
| TLS | cert-manager |
| Block storage | Longhorn (local NVMe, replicated across all 3 nodes) |
| File storage | `nfs-subdir-external-provisioner` → Unraid NAS |
| GPU passthrough | Intel Device Plugin (`gpu.intel.com/i915`), for Plex/Jellyfin Quick Sync transcoding |
| DNS | Split-horizon: Cloudflare DDNS updater (public hostnames → home WAN IP) + external-dns → UniFi local DNS (everything, LAN/VPN-only) |
| Public exposure | UDM Pro port-forwards 80/443 straight to Traefik's LB IP — no Cloudflare Tunnel |
| Dashboard / metrics | Prometheus + Grafana (`kube-prometheus-stack`), node-exporter + kube-state-metrics, `metrics-server` for `kubectl top` |
| Network flow visibility | Hubble UI (ships with Cilium) |
| Continuous delivery | ArgoCD, app-of-apps, watching this repo |
| Secrets | [SOPS](https://github.com/getsops/sops) + [Age](https://github.com/FiloSottile/age) — encrypted in git, no external secret store |
| App builds | GitHub Actions → GHCR, ArgoCD Image Updater bumps tags |

No cloud secret manager, no Coolify, nothing imperative outside this repo
and the one-time install.

## Network

The cluster lives on its own UDM Pro VLAN, isolated from the main LAN
(`10.10.10.0/24`):

| Range | Purpose |
|---|---|
| `10.10.100.1` | Gateway (UDM Pro) |
| `10.10.100.2` | Control-plane VIP (`endpoint` in `talconfig.yaml`) |
| `10.10.100.11`-`.13` | The 3 nodes, static |
| `10.10.100.50`-`.150` | UniFi DHCP pool (unused by Talos — everything cluster-side is static) |
| `10.10.100.200`-`.250` | Cilium LoadBalancer pool |

Add a static DHCP reservation per node MAC -> its final IP in the UniFi
controller before first boot (see the comment at the top of
`talos/talconfig.yaml` for why). The Unraid NAS stays on the main LAN, so
NFS traffic crosses VLANs — add a UDM Pro firewall rule allowing the
cluster VLAN to reach it. Same requirement for
`kubernetes/core/services/external-dns-internal/` → the UDM Pro's own
management API (`10.10.10.1:443`) needs to be reachable from the cluster
VLAN too.

## DNS (split-horizon) and public exposure

The UDM Pro port-forwards 80/443 directly to Traefik's LB IP
(`10.10.100.200`) — no Cloudflare Tunnel. That means the public Cloudflare
A record for an exposed hostname has to equal the home's WAN IP, not any
in-cluster address, which rules out the usual "external-dns watches
Ingresses and points records at the LB IP" pattern (that LB IP is a
private, unroutable address from the internet's point of view). So the two
halves of the split-horizon use genuinely different mechanisms:

- **Public** — [`external-dns/`](kubernetes/core/services/external-dns/)
  (repurposed; still the name/namespace/secret, see the comment in
  `ddns-deployment.yaml`) runs **two** Cloudflare DDNS updater instances
  ([favonia/cloudflare-ddns](https://github.com/favonia/cloudflare-ddns)),
  because Cloudflare's proxy (orange cloud) is an all-or-nothing setting
  per instance but needs to differ per host:
  - `cloudflare-ddns` — `argocd.nvlab.fr`, `cloud.nvlab.fr`,
    `jellyfin.nvlab.fr`, `media.nvlab.fr`, each its own direct A record,
    unproxied (grey cloud, `PROXIED=false`). Cloudflare's proxy caps
    uploads at 100MB on these plans, which would break Nextcloud and hurt
    Jellyfin/Plex streaming.
  - `cloudflare-ddns-proxied` — just the zone apex (`nvlab.fr`), proxied
    (orange cloud, `PROXIED=true`). `bitwarden.nvlab.fr` and
    `wiki.nvlab.fr` are CNAMEs to the apex (pre-existing, low-bandwidth —
    worth keeping Cloudflare's WAF in front) and ride along for free; this
    instance just keeps the apex itself fresh, independent of whatever
    used to do that on the old NAS.
  Nothing is public unless its hostname is in one of these two `DOMAINS`
  lists (or CNAMEs to the apex) — adding one is a one-line git change.
- **Internal** — [`external-dns-internal/`](kubernetes/core/services/external-dns-internal/)
  → UniFi's own local DNS, via the
  [UniFi webhook provider](https://github.com/home-operations/external-dns-unifi-webhook).
  No filter — every Ingress gets a record here (including the public
  ones), resolvable only on the LAN or over the UniFi VPN, pointed at
  Traefik's private LB IP directly. No hairpin NAT for LAN/VPN clients.

Needs a UniFi API key (Settings → Control Plane → Integrations → Create
API Key — Super Admin only to create it, can downgrade after) in
[`external-dns-internal/unifi-api-key.sops.yaml`](kubernetes/core/services/external-dns-internal/unifi-api-key.sops.yaml).

### Services still hosted on the NAS

[`kubernetes/apps/services/nas-passthrough/`](kubernetes/apps/services/nas-passthrough/)
is a thin Traefik passthrough (Service+Endpoints pointing at the NAS IP,
plus an Ingress) for public hostnames whose backend hasn't been migrated
into the cluster yet: `wiki.nvlab.fr` (:3000), `jellyfin.nvlab.fr`
(:8096), `media.nvlab.fr` / Plex (:32400). Traefik still terminates TLS
for these; only the backend is off-cluster. Adding a new one means a new
file there plus adding the hostname to the DDNS updater's `DOMAINS`.

## Repo layout

```
talos/              Talos cluster definition (talhelper) + the Cilium
                     manifest installed inline at bootstrap
bootstrap/
  argocd/values.yaml  One-shot helm values for ArgoCD's initial install
kubernetes/
  core/              Cluster-wide infra, managed by ArgoCD from day one
    root.yaml          App-of-apps entrypoint
    applications/      One Application manifest per core service
    services/          The actual Helm values / manifests each one deploys
  apps/              Business apps (Vaultwarden, Nextcloud, NAS passthrough)
    applications/      One Application manifest per app
    services/          The actual manifests each one deploys
cli/                 Install AND manage the cluster — one CLI, see below
```

## The CLI

One CLI, two sections today (see [`cli/README.md`](cli/README.md) for the
full breakdown):

```bash
cd cli
bun install
bun start           # interactive menu
```

- **Install** — first-time bring-up: generate/encrypt secrets, wipe and
  install Talos on all 3 nodes, bootstrap Kubernetes, install ArgoCD, hand
  off `kubernetes/core/` to GitOps. Live step-by-step progress.
- **Status** — checks every core component (Talos nodes, Cilium, ArgoCD,
  and every ArgoCD-managed Application) and offers to fix what's missing —
  e.g. reinstalls ArgoCD if it's gone, re-applies the root app-of-apps if
  it's missing.

More sections (upgrades, node maintenance, …) land here over time.

### Before your first run

1. Set up the UDM Pro VLAN + DHCP reservations as described in
   [Network](#network) above.
2. Check [`talos/talconfig.yaml`](talos/talconfig.yaml) matches your real
   node MACs/hostnames (IPs already match the Network section).
3. Edit [`kubernetes/core/services/nfs-provisioner/values.yaml`](kubernetes/core/services/nfs-provisioner/values.yaml)
   with your Unraid NAS's real IP and export path.
4. Fill in a real Cloudflare API token:
   [`kubernetes/core/services/external-dns/cloudflare-api-token.sops.yaml`](kubernetes/core/services/external-dns/cloudflare-api-token.sops.yaml)
   (then `sops -e -i` it) and your domain(s) in the `DOMAINS` env var of
   [`kubernetes/core/services/external-dns/ddns-deployment.yaml`](kubernetes/core/services/external-dns/ddns-deployment.yaml).
5. The repo URL baked into every `Application`/`root.yaml` is
   `https://github.com/lxup/homelab.git` on `main` — update it if you fork
   or rename.

The installer generates your Age key and Talos secrets on first run; there's
nothing to prepare for SOPS beyond having `sops`/`age` installed.

## Secrets model

One Age key pair, generated once by the installer into
`~/.config/sops/age/keys.txt` (back this up somewhere outside the repo — if
you lose it, every encrypted file in this repo becomes unrecoverable).
`.sops.yaml` at the repo root holds the *public* half and routes:

- `talos/talsecret.sops.yaml` — Talos cluster secrets
- any `kubernetes/**/*.sops.yaml` — Kubernetes secrets, decrypted in-cluster
  by ArgoCD's repo-server via [ksops](https://github.com/viaduct-ai/kustomize-sops)
  (wired up in `bootstrap/argocd/values.yaml`)

Everything in git stays encrypted; only the cluster can decrypt it.

## Dashboards

| What | URL | Login |
|---|---|---|
| ArgoCD | `argocd.nvlab.fr` | `admin` / `kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' \| base64 -d` |
| Grafana | `grafana.nvlab.fr` | credentials in `kubernetes/core/services/monitoring/grafana-admin.sops.yaml` (sops-encrypted) |
| Hubble UI | `hubble.nvlab.fr` | none — read-only network flow map |
| Longhorn UI | not exposed via Ingress yet — `kubectl -n longhorn-system port-forward svc/longhorn-frontend 8080:80` | none |

Grafana ships with the default kube-prometheus-stack dashboards (node
resource usage, pod resource usage, cluster capacity) already imported —
nothing to configure after first login. `kubectl top nodes` / `kubectl top
pods` work immediately too (metrics-server).

## What's deliberately not GitOps-managed

- **ArgoCD's own Helm release** — only its Ingress is under GitOps. Letting
  ArgoCD sync its own control plane risks a bad sync taking down the thing
  that would fix it. Upgrade it by re-running the installer or
  `helm upgrade --install` with `bootstrap/argocd/values.yaml`.
- **Cilium** — Talos installs it once at bootstrap as an inline manifest
  (which Talos never updates after creation). Upgrades are a normal
  `helm upgrade` against the live cluster using
  `talos/manifests/cilium-values.yaml`. Only its `CiliumLoadBalancerIPPool`
  / `CiliumL2AnnouncementPolicy` config is GitOps-managed.
- **The `sops-age` secret** in the `argocd` namespace — it's the key that
  decrypts everything else, so it's created imperatively by the installer
  from your local Age key, never committed.
