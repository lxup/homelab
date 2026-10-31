# `homelab` CLI

Everything that cannot be GitOps, because it has to exist before GitOps does.

```bash
cd cli && bun install
bun run src/index.ts          # interactive menu
bun run src/index.ts install  # install ArgoCD into the vcluster, hand it GitOps
bun run src/index.ts status   # health check, offers to fix what's missing
```

## This no longer creates a cluster

It used to: `talhelper gensecret`, `talosctl apply-config`, `talosctl
bootstrap`, the whole Talos dance against three EliteDesks. That machine now
belongs to [lxup/platform](https://github.com/lxup/platform), which hands
this tenant a vcluster.

The only thing that crosses the boundary is a kubeconfig. Produce it there:

```bash
# in lxup/platform
bun run src/index.ts tenant        # writes tenants/homelab.kubeconfig
cp tenants/homelab.kubeconfig ../homelab/kubeconfig
```

This repo holds no credentials for the platform cluster and does not know
how its own cluster is built — which is the whole point of the split.

## `install`

| # | Step | Idempotent? |
|---|---|---|
| 00 | detect whether ArgoCD is already there | yes |
| 01 | check `helm`/`kubectl`/`sops`/`age` on PATH | yes |
| 02 | generate the Age key if absent | yes |
| 03 | verify `./kubeconfig` — reachable, and **not** the host cluster | yes |
| 04 | wait for the tenant API to serve `/readyz` | yes |
| 05 | create the `sops-age` Secret | yes |
| 06 | `helm upgrade --install` ArgoCD from `bootstrap/argocd/values.yaml` | yes |
| 07 | apply the ArgoCD repo credential for github.com/lxup | yes, skipped if absent |
| 08 | `kubectl apply` `kubernetes/core/root.yaml` | yes |

Two orderings are load-bearing:

- **05 before 06** — ArgoCD's repo-server mounts `sops-age` as a volume, and
  a missing Secret leaves the pod pending forever while `helm --wait` times
  out.
- **07 before 08** — step 07 is what lets ArgoCD clone the repo that step 08
  points it at. Putting that credential under `kubernetes/` instead would be
  circular: ArgoCD would need to clone the repo to find the credential that
  lets it clone the repo. It runs unconditionally, so flipping this repo to
  private is a visibility toggle on GitHub and nothing else.

Step 03 refuses to continue if the kubeconfig points at the host cluster —
the tell is a `longhorn-system` namespace, which a vcluster never sees. Running
this against the platform's kubeconfig would install a second ArgoCD into the
real cluster next to the one managing it.

After step 08, nothing here is needed again: ArgoCD watches
`kubernetes/core/applications/` and picks up every file added there.

## `status`

Checks only what this tenant owns — its ArgoCD, its root app, its
Applications. Nodes, Cilium, Longhorn, the GPU plugin and Prometheus belong
to the platform; check those with its own `status` command against its own
kubeconfig.
