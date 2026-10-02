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
| DNS | external-dns → Cloudflare |
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
cluster VLAN to reach it.

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
  apps/              (not yet — business/media apps come next)
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
4. Fill in a real Cloudflare API token and your domain:
   [`kubernetes/core/services/external-dns/cloudflare-api-token.sops.yaml`](kubernetes/core/services/external-dns/cloudflare-api-token.sops.yaml)
   (then `sops -e -i` it) and
   [`kubernetes/core/services/external-dns/values.yaml`](kubernetes/core/services/external-dns/values.yaml)
   (`domainFilters`).
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
