# homelab

My own applications — Immich, Jellyfin, Nextcloud, Paperless, Vaultwarden,
Syncthing, and two websites — running on hardware at home.

> ### This repo is now one tenant among three
>
> The cluster half lives in **[lxup/platform](https://github.com/lxup/platform)**:
> Talos, Cilium, Longhorn, the GPU device plugin, metrics-server, Prometheus,
> and the definitions of the virtual clusters each environment runs in. That
> repo's README is the authority on how the machine works and why the split
> exists.
>
> These applications run in the `homelab` vcluster, synced by **this repo's
> own ArgoCD**, which lives inside it and answers on `argocd.nvlab.fr`.
> Alongside [paveproject/infra](https://github.com/paveproject/infra) and
> [recomendapp/infra](https://github.com/recomendapp/infra), each with its
> own ArgoCD, its own cert-manager and its own ingress.
>
> **What changed in here.** `talos/` is gone. `cli/` installs ArgoCD into a
> vcluster instead of provisioning bare metal — it needs a `./kubeconfig`,
> produced by `platform tenant` in the other repo. `kubernetes/core/` holds
> this tenant's own ArgoCD config, cert-manager, Traefik and both
> external-dns instances; `kubernetes/apps/` holds the application
> manifests.
>
> **What did not change.** Everything below about the apps, the DNS
> split-horizon, the public exposure, the secrets model and the per-app
> gotchas is still accurate. The NAS mounts are identical — the migration
> never touched a byte on `10.10.10.101`. Sections about the node hardware,
> Cilium and Longhorn describe the platform's business now, not this repo's.
## Where it runs

In the `homelab` vcluster on [lxup/platform](https://github.com/lxup/platform)'s
Talos cluster — 3 HP EliteDesks with Intel Quick Sync iGPUs, Longhorn for
block storage, and an Unraid NAS over NFS for the bulk data. That repo's
README is the authority on the hardware, Talos, Cilium, Longhorn and the GPU
device plugin; none of it is this repo's business any more.

## Stack

| Concern | Tool |
|---|---|
| Ingress | Traefik, holding `10.10.100.200` behind the UDM Pro's 80/443 forward |
| TLS | cert-manager, DNS-01 through Cloudflare |
| DNS | Split-horizon: Cloudflare DDNS updater (public hostnames → home WAN IP) + external-dns → UniFi local DNS (everything, LAN/VPN-only) |
| Public exposure | Direct through the UDM Pro's port-forward, no tunnel — Jellyfin, Immich and Nextcloud need real throughput and exceed Cloudflare's 100 MB proxied cap |
| Block storage | Longhorn (the platform's), `storageClassName: longhorn` |
| Bulk data | NFS from the NAS, mounted straight in the pod specs |
| GPU | `gpu.intel.com/i915` requests, resolved host-side by the platform's device plugin |
| Uptime monitoring | Gatus → Telegram (infra alerts come from the platform's Alertmanager, same bot) |
| Continuous delivery | its own ArgoCD, inside the vcluster, app-of-apps on this repo |
| Secrets | [SOPS](https://github.com/getsops/sops) + [Age](https://github.com/FiloSottile/age) — encrypted in git, no external secret store |
| App builds | GitHub Actions → GHCR, ArgoCD Image Updater bumps tags |

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
`kubernetes/apps/services/external-dns-internal/` → the UDM Pro's own
management API (`10.10.10.1:443`) needs to be reachable from the cluster
VLAN too.

### NFS stability (stale file handles)

Every NFS-backed app (Nextcloud, Immich, Jellyfin, Paperless) has hit
`ESTALE` ("Stale file handle") on its NFS mount at least once — the pod
stays `Running`/`Ready` (nothing crashes) but every request touching the
mount fails, silently, until something notices. Likely cause: Unraid's
mover relocating files between cache and array invalidates the file
handle a long-lived NFS client is still holding.

Acted on 2026-10-16, still unconfirmed: `naegativ` and `nextcloud` both
have Primary storage set straight to `Array` (no cache, no mover). Note
that the *transition itself* invalidated handles — changing a share's
settings re-exports it, and that staled the mounts of **other** shares
too. After touching any share, check every NFS-backed pod, not just the
one changed. Whether Array actually prevents recurrence will only be
clear after a few quiet days.

**A `livenessProbe` does not heal this.** The previous claim here that it
did was wrong. A probe failure restarts the *container*, but an NFS volume
belongs to the *pod*: the kubelet mounts it before any container starts,
so the new container reuses the same stale mount. It is worse than a
no-op — the kubelet must `stat` the volume directory to build the next
container's OCI spec, that `stat` fails with `ESTALE`, and the pod wedges
in `CreateContainerError`/`BackOff` indefinitely.

Keep the probes anyway: they turn a silent failure into a loud one. But
recovery is **manual** — `kubectl delete pod` is the only thing that
forces a fresh mount (needed three times in one evening on 2026-10-16). A
watchdog that deletes the pod on a sustained 503 would be the real fix;
not built yet.

## DNS (split-horizon) and public exposure

The UDM Pro port-forwards 80/443 directly to Traefik's LB IP
(`10.10.100.200`) — no Cloudflare Tunnel. That means the public Cloudflare
A record for an exposed hostname has to equal the home's WAN IP, not any
in-cluster address, which rules out the usual "external-dns watches
Ingresses and points records at the LB IP" pattern (that LB IP is a
private, unroutable address from the internet's point of view). So the two
halves of the split-horizon use genuinely different mechanisms:

- **Public** — [`external-dns/`](kubernetes/apps/services/external-dns/)
  (repurposed; still the name/namespace/secret, see the comment in
  `ddns-deployment.yaml`) runs **two** Cloudflare DDNS updater instances
  ([favonia/cloudflare-ddns](https://github.com/favonia/cloudflare-ddns)).
  Every public hostname gets its own independent, direct A record (no
  CNAMEs) — grouped into one of two instances because Cloudflare's proxy
  (orange cloud) is an all-or-nothing setting per instance, and we want it
  to differ per host:
  - `cloudflare-ddns-proxied` (`PROXIED=true`) — `nvlab.fr` (the zone
    apex), `argocd.nvlab.fr`, `bitwarden.nvlab.fr`. Low-bandwidth hosts, so
    Cloudflare's WAF/DDoS protection and hidden origin IP are worth it.
  - `cloudflare-ddns` (`PROXIED=false`) — `cloud.nvlab.fr` (Nextcloud),
    `jellyfin.nvlab.fr`, `media.nvlab.fr` (Plex). Cloudflare's proxy caps
    uploads at 100MB on these plans (would break Nextcloud uploads), and
    separately, sustained video streaming through the proxy runs against
    Cloudflare's ToS on free/Pro plans — not worth the trade-off here.
  Nothing is public unless its hostname is in one of these two `DOMAINS`
  lists — adding one is a one-line git change.
- **Internal** — [`external-dns-internal/`](kubernetes/apps/services/external-dns-internal/)
  → UniFi's own local DNS, via the
  [UniFi webhook provider](https://github.com/home-operations/external-dns-unifi-webhook).
  No filter — every Ingress gets a record here (including the public
  ones), resolvable only on the LAN or over the UniFi VPN, pointed at
  Traefik's private LB IP directly. No hairpin NAT for LAN/VPN clients.

Needs a UniFi API key (Settings → Control Plane → Integrations → Create
API Key — Super Admin only to create it, can downgrade after) in
[`external-dns-internal/unifi-api-key.sops.yaml`](kubernetes/apps/services/external-dns-internal/unifi-api-key.sops.yaml).

### Services still hosted on the NAS

[`kubernetes/apps/services/nas-passthrough/`](kubernetes/apps/services/nas-passthrough/)
is a thin Traefik passthrough (an `ExternalName` Service pointing at the
NAS IP, plus an Ingress — not a selector-less Service with a manually
committed `Endpoints`, which ArgoCD silently never applies: `Endpoints`/
`EndpointSlice` are excluded from management by its default
`resource.exclusions`) for public hostnames whose backend hasn't been
migrated into the cluster yet: `media.nvlab.fr` / Plex (:32400). Traefik
still terminates TLS for these; only the backend is off-cluster. Adding a
new one means a new file there plus adding the hostname to the DDNS
updater's `DOMAINS`.

### Immich

[`kubernetes/apps/services/immich/`](kubernetes/apps/services/immich/) —
photo/video backup from phones, fully in-cluster (no NAS passthrough).
Own Postgres (the `ghcr.io/immich-app/postgres` image — bundles the
VectorChord extension Immich needs for face/CLIP similarity search, a
plain `postgres` image won't work) and own Valkey, same one-per-app
isolation as Nextcloud/Vaultwarden. The photo/video library itself lives
on NFS (`/mnt/user/immich` — **create this share on the Unraid NAS
before deploying**, same reasoning as Nextcloud: bulk media doesn't
belong on replicated block storage). Machine learning
(`immich-machine-learning`, `-openvino` image variant) requests the Intel
iGPU (`gpu.intel.com/i915`, via `intel-gpu-plugin`) for face/object
detection — confirmed actually using it (OpenVINOExecutionProvider, not
just CPU fallback) by checking its logs and `/dev/dri` after deploy.
Public at `immich.nvlab.fr`, unproxied (original-quality mobile uploads
can exceed Cloudflare's 100MB proxied-request cap, same as Nextcloud).

### Jellyfin

[`kubernetes/apps/services/jellyfin/`](kubernetes/apps/services/jellyfin/) —
migrated in from the Unraid NAS (config copied over once via a one-off
Job, not shared live with the old instance — same reasoning as every
other migration here: SQLite over a live NFS share accessed by two
instances risks corruption). Media library stays on NFS
(`/mnt/user/media`), read-only. Requests the same Intel iGPU as Immich's
ML service for hardware transcoding (Quick Sync). Verified on a temporary
`jellyfin-new.nvlab.fr` hostname first (migrated library/users intact, GPU
transcoding), now cut over to the real `jellyfin.nvlab.fr` — the NAS
passthrough entry for it is gone, **remember to stop the old Jellyfin
container on Unraid**.

### Paperless-ngx

[`kubernetes/apps/services/paperless/`](kubernetes/apps/services/paperless/) —
document management (invoices, health records, admin paperwork), scanned
or uploaded as PDF/images, OCR'd and full-text searchable. Own Postgres +
Valkey, same per-app isolation as the other apps. Documents/thumbnails on
NFS (`/mnt/user/paperless`); the search index and classification model
stay on Longhorn (small, rebuildable from the documents if ever lost). No
watched "consume" folder yet — upload via the web UI covers the stated
use case; add one later (a second NFS mount + `PAPERLESS_CONSUMPTION_DIR`)
if a physical scanner ever needs a drop folder.

Public at `paperless.nvlab.fr`, unproxied (large scan uploads can exceed
Cloudflare's 100MB proxied-request cap, same as Nextcloud/Immich) — a
deliberate choice despite the sensitive content, same exposure model as
Nextcloud.

### Syncthing

[`kubernetes/apps/services/syncthing/`](kubernetes/apps/services/syncthing/) —
not a server, a 3rd always-on peer. The MacBook Pro and gaming PC each run
their own normal Syncthing install and sync directly with each other
peer-to-peer; this instance just stays online so changes still propagate
when the two are never awake at the same time (e.g. RME TotalMix presets,
OBS scenes). Longhorn, not NFS — small config files syncing constantly,
no reason to put NAS latency in the loop. R2-backed (device pairing +
the synced files themselves, both irreplaceable).

Two Services, not one: `syncthing-gui` (port 8384, public at
`syncthing.nvlab.fr`, proxied group — remote GUI access was wanted, and
it's low-bandwidth so Cloudflare's WAF/hidden-origin-IP is a clear win)
and `syncthing-sync` (its own LoadBalancer IP from the same Cilium pool
Traefik uses, port 22000 tcp+udp — sync traffic isn't HTTP, Traefik can't
route it, so it never goes through the public hostname at all). Works on
the LAN as-is for sync; forward 22000 tcp+udp on the UDM Pro too if direct
sync while away from home ever matters (otherwise Syncthing's public relay
servers handle NAT traversal automatically, just slower).

**GUI authentication is mandatory, not optional**, precisely because the
GUI is now internet-reachable: Syncthing has no env-var-based way to set
it, so a `set-gui-credentials` init container runs
`syncthing generate --gui-user=... --gui-password=...` (credentials from
[`gui-credentials.sops.yaml`](kubernetes/apps/services/syncthing/gui-credentials.sops.yaml))
on every pod start — safe to re-run idempotently, it only touches the
GUI user/password fields and leaves the device cert/ID alone.

Device pairing (adding the MacBook/gaming PC as remote devices, creating
the shared folder) is a one-time manual step via the GUI — device IDs
don't exist until each machine's own Syncthing is installed, nothing to
template in git for that part.
## Repo layout

```
bootstrap/
  argocd/values.yaml   One-shot helm values for this tenant's ArgoCD install
kubernetes/
  core/                This tenant's own infra, synced by its ArgoCD
    root.yaml            App-of-apps entrypoint
    applications/        One Application per service — infra and apps alike
    services/argocd/     Its ArgoCD Ingress (argocd.nvlab.fr + webhook)
  apps/
    services/            The manifests every Application points at
cli/                   Installs ArgoCD into the vcluster — see below
```

Note the asymmetry: `core/applications/` holds every Application, including
the ones whose manifests live under `apps/services/`. The split is
historical — Application files migrated out of `apps/applications/` one at a
time while the manifests stayed put — and consolidating it is a pure rename
nobody has needed yet.

There is no `talos/`: the cluster belongs to
[lxup/platform](https://github.com/lxup/platform).
## The CLI

```bash
cd cli
bun install
bun start           # interactive menu
```

- **Install** — installs ArgoCD into this tenant's vcluster and hands it
  `kubernetes/core/`. It does **not** create a cluster: `./kubeconfig` must
  already point at the `homelab` vcluster. Step 03 refuses to run against
  the host cluster — the tell is a `longhorn-system` namespace, which a
  vcluster never sees.
- **Status** — checks this tenant's ArgoCD, its root app and its
  Applications, and offers to fix what is missing. Nodes, Cilium, Longhorn
  and Prometheus belong to the platform; check those with its own `status`.

Full step-by-step breakdown in [`cli/README.md`](cli/README.md).

### Before your first run

1. Get the kubeconfig. In [lxup/platform](https://github.com/lxup/platform):
   ```bash
   bun run src/index.ts tenant        # writes tenants/homelab.kubeconfig
   cp tenants/homelab.kubeconfig ../homelab/kubeconfig
   ```
2. Fill in a real Cloudflare API token in
   [`kubernetes/apps/services/external-dns/cloudflare-api-token.sops.yaml`](kubernetes/apps/services/external-dns/cloudflare-api-token.sops.yaml)
   (then `sops -e -i` it) and your domains in the `DOMAINS` env vars of
   [`ddns-deployment.yaml`](kubernetes/apps/services/external-dns/ddns-deployment.yaml).
3. The repo URL baked into every `Application` and into `root.yaml` is
   `https://github.com/lxup/homelab.git` on `main` — change it if you fork.
4. Optionally create `bootstrap/argocd/repo-credentials.sops.yaml` from the
   `.example.yaml` beside it. Not needed while the repo is public; having it
   means flipping it private is a visibility toggle and nothing else.

## Secrets model

One Age key pair, generated once by the installer into
`~/.config/sops/age/keys.txt` (back this up somewhere outside the repo — if
you lose it, every encrypted file in this repo becomes unrecoverable).
`.sops.yaml` at the repo root holds the *public* half and routes:

- `talos/talsecret.sops.yaml` — Talos cluster secrets
- any `kubernetes/**/*.sops.yaml` — Kubernetes secrets, decrypted in-cluster
  by ArgoCD's repo-server via [ksops](https://github.com/viaduct-ai/kustomize-sops)
  (wired up in `bootstrap/argocd/values.yaml`)
- any `bootstrap/**/*.sops.yaml` — Helm values needed *before* GitOps exists,
  decrypted locally by the CLI and piped straight into `helm upgrade`
  (today: the GitHub webhook secret, see below)

Everything in git stays encrypted; only the cluster can decrypt it.

## GitHub webhook

Without it ArgoCD polls the repo every 3 minutes, so a push takes up to that
long to land. The webhook makes it instant. Two halves:

1. **Cluster side** — a shared secret in `argocd-secret` under
   `webhook.github.secret`. That Secret belongs to ArgoCD's own Helm release
   (it also holds the admin password and the server signing key), so it is
   deliberately *not* GitOps-managed and ksops can't reach it. Instead the
   value lives in `bootstrap/argocd/values.secret.sops.yaml` as the chart's
   `configs.secret.githubSecret`, which `cli/src/steps/11-install-argocd.ts`
   decrypts into a short-lived 0600 temp file and passes to helm as a second
   `--values`. To create or rotate it:

   ```sh
   TOKEN=$(openssl rand -hex 32)
   cat > bootstrap/argocd/values.secret.sops.yaml <<YAML
   configs:
     secret:
       githubSecret: $TOKEN
   YAML
   sops -e -i bootstrap/argocd/values.secret.sops.yaml
   echo "$TOKEN"   # paste this into GitHub, then forget it
   ```

   Then re-run the installer to push it into the cluster — it already sets
   both env vars below for you. To do just the helm step by hand:

   ```sh
   export KUBECONFIG=$PWD/kubeconfig
   export SOPS_AGE_KEY_FILE=$HOME/.config/sops/age/keys.txt
   helm upgrade --install argocd argo/argo-cd -n argocd \
     -f bootstrap/argocd/values.yaml \
     -f <(sops -d bootstrap/argocd/values.secret.sops.yaml) \
     --wait
   ```

   `SOPS_AGE_KEY_FILE` is not optional on macOS: sops looks for the key in
   `os.UserConfigDir()`, i.e. `~/Library/Application Support/sops/age/`, not
   in `~/.config/sops/age/` where the installer puts it — so an unqualified
   `sops -d` fails with "Did not find keys in locations …". Encryption still
   works without it (it only needs the public key from `.sops.yaml`), which
   is why this only bites on decrypt. Every `sops` call in `cli/` passes the
   path explicitly for this reason.

   The encrypted file is optional — if it's absent ArgoCD installs fine and
   simply keeps polling.

2. **GitHub side** — repo *Settings → Webhooks → Add webhook*:
   payload URL `https://argocd.nvlab.fr/api/webhook`, content type
   `application/json`, secret = the token above, event = *Just the push
   event*. ArgoCD refreshes every Application whose `repoURL` matches the
   pushed repo, so one webhook covers the whole app-of-apps tree.

This is why `argocd.nvlab.fr` is publicly reachable at all — see the comment
at the top of [`kubernetes/core/services/argocd/ingress.yaml`](kubernetes/core/services/argocd/ingress.yaml).
## UIs

| What | URL | Login |
|---|---|---|
| ArgoCD | `argocd.nvlab.fr` | `admin` / `kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' \| base64 -d` |
| Gatus | `status.nvlab.fr` (LAN-only, not public) | none — read-only status page |

Everything else moved to the platform with the cluster, and lives behind
`kubectl port-forward` against **its** kubeconfig, not this one:

| What | How |
|---|---|
| Prometheus | `kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090` |
| Hubble UI | `kubectl -n kube-system port-forward svc/hubble-ui 8080:80` |
| Longhorn UI | `kubectl -n longhorn-system port-forward svc/longhorn-frontend 8081:80` |

There is no Grafana any more. It was removed along with the dashboards that
fed it: the stack cost 1.4 GB to serve pages nobody opened while
Alertmanager discarded every alert it produced. The platform now routes
alerts Gatus cannot see — a node down, a Longhorn volume degraded, a crash
loop, a disk filling — into the same Telegram bot this repo's Gatus uses, so
both arrive in one conversation. See lxup/platform's README.

`kubectl top nodes` / `kubectl top pods` work against either kubeconfig
(metrics-server runs on the platform and a vcluster sees it).

### Gatus (synthetic / blackbox monitoring)

[`kubernetes/apps/services/gatus/`](kubernetes/apps/services/gatus/) —
deliberately separate from Grafana/Prometheus: those watch pod-level
health (is the container Running/Ready), which misses failures *outside*
the pod entirely — a stale NFS mount or a bad DNS record can leave a pod
perfectly "Ready" while the app is actually down for every real user.
Gatus instead checks the real public hostname end-to-end (DNS → internet →
Traefik → app), the same path an actual visitor takes.

Fully GitOps, unlike most uptime-monitoring tools (Uptime Kuma included) —
[`config.yaml`](kubernetes/apps/services/gatus/config.yaml) declares every
monitored endpoint *and* the Telegram alerting config as plain YAML, no
UI setup at all. Add a service by adding an entry to `endpoints:` and
committing. Its own Postgres (R2-backed) persists history across
restarts, same per-app isolation as Nextcloud/Immich.

The only manual, one-time step — creating the Telegram bot itself, since
that's an action on Telegram's side, not Gatus's:
1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the
   bot token.
2. Message your new bot once (anything), then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read your
   `chat.id` from the JSON.
3. Put both in
   [`telegram-secret.sops.yaml`](kubernetes/apps/services/gatus/telegram-secret.sops.yaml)
   (`sops -e -i` it) — `config.yaml` references them via
   `${TELEGRAM_BOT_TOKEN}` / `${TELEGRAM_CHAT_ID}`.

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
