# homelab CLI

Single CLI for installing and managing the homelab cluster. UI: [Listr2](https://listr2.kischnerd.de/)
for step progress, [`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts) for prompts/menu.

Runs on [Bun](https://bun.sh) — executes the TypeScript directly, no build step.

## Run it

```bash
cd cli
bun install
bun start          # interactive menu
bun start install  # jump straight to install
bun start status   # jump straight to status
```

## Sections

### Install

Same command for the very first node and for adding the 4th one later —
`talos/talconfig.yaml` always lists every node the cluster will ever have;
this just asks which of them are physically booted right now and only
touches those. See `src/commands/install.ts`. Steps run in order from
`src/steps/`, numbered, each a plain `ListrTask<InstallCtx>` — **every step
file has a `Doc:` comment above it explaining what it does and why**, read
those before changing one:

1. Read node topology from `talos/talconfig.yaml`.
2. Check required tools (`talosctl`, `talhelper`, `helm`, `kubectl`, `sops`, `age-keygen`).
3. Generate/reuse Age key, wire it into `.sops.yaml`.
4. Generate + encrypt Talos cluster secrets — **once per cluster, ever**.
5. Render the Cilium manifest Talos installs at first boot.
6. Validate + render per-node Talos configs (for every node in talconfig,
   even ones not targeted this run).
7. **Apply machine config to the targeted node(s) — wipes their disks.**
8. Bootstrap etcd — **skipped automatically** if a kubeconfig already
   exists (i.e. this is a node being added, not the first one).
9. Fetch kubeconfig — skipped if already present.
10. Wait for the targeted node(s) specifically to go `Ready` (not a raw
    count, so this works mid-rollout).
11. Install ArgoCD + the `sops-age` secret (`helm upgrade --install` —
    idempotent, safe every run).
12. Apply `kubernetes/core/root.yaml` — ArgoCD takes over from here
    (idempotent `kubectl apply`).

Safe to re-run except step 4, which refuses to touch an existing
`talsecret.sops.yaml` (regenerating it invalidates a live cluster's certs)
— and step 8, which Talos itself refuses to repeat against a live cluster.

### Status

`src/commands/status.ts` checks the health of every core component and
offers to fix what it can, without fighting GitOps:

- **Talos nodes**, **Cilium** — checked directly via `kubectl` (these aren't ArgoCD-managed).
- **ArgoCD** — checked via its Helm release + Deployment. If missing or
  unhealthy, the fix re-runs the ArgoCD install step.
- **Root app-of-apps** — checked as an ArgoCD `Application` named `root`. If
  missing, the fix re-applies `kubernetes/core/root.yaml`.
- Everything else under `kubernetes/core/applications/` (cert-manager,
  Traefik, Longhorn, nfs-provisioner, Cilium LB config, Intel GPU plugin) —
  checked as ArgoCD `Application` health/sync status. The fix requests a
  hard refresh; actual reconciliation is still ArgoCD's job
  (`automated: { prune: true, selfHeal: true }` on every Application).

### Later

More sections (upgrades, node maintenance, backups, …) go in
`src/commands/`, registered in the `SECTIONS` map in `src/index.ts`.

## Code layout

```
src/
  index.ts        menu + subcommand dispatch
  commands/       one file per section (install, status, …)
  steps/          individual install steps, reused by commands
  lib/
    context.ts    InstallCtx — state threaded through install steps
    paths.ts      repo-relative paths
    exec.ts       execa wrapper that streams into Listr2 task output
    kubectl.ts    read-only + light-touch kubectl/helm/argo helpers for status
    retry.ts      retry-with-backoff for "node is still rebooting" steps
    talconfig.ts  parses talos/talconfig.yaml for the node list
```
