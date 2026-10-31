import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** homelab/ — the git repo root (this file lives at cli/src/lib/). */
export const repoRoot = path.resolve(here, "..", "..", "..");

/**
 * The kubeconfig for THIS TENANT's cluster — not the platform's.
 *
 * This repo does not know how its cluster is produced and deliberately has
 * no credentials for the machine underneath. It used to run `talhelper` and
 * `talosctl` against bare metal; now the cluster is a vcluster declared in
 * lxup/platform, and the only thing that crosses the boundary is this file.
 *
 * Produce it with `platform tenant` in that repo, which writes
 * tenants/homelab.kubeconfig, and copy it here. Gitignored: it is a live
 * credential to a Kubernetes API server.
 */
export const kubeconfigPath = path.join(repoRoot, "kubeconfig");

export const argocdBootstrapValuesPath = path.join(repoRoot, "bootstrap", "argocd", "values.yaml");
/** SOPS-encrypted values overlay carrying the GitHub webhook shared secret. */
export const argocdBootstrapSecretValuesPath = path.join(
  repoRoot,
  "bootstrap",
  "argocd",
  "values.secret.sops.yaml",
);
/** SOPS-encrypted ArgoCD repository credential, applied imperatively. Absent while the repo is public. */
export const argocdRepoCredentialsPath = path.join(
  repoRoot,
  "bootstrap",
  "argocd",
  "repo-credentials.sops.yaml",
);
export const coreRootAppPath = path.join(repoRoot, "kubernetes", "core", "root.yaml");
export const coreApplicationsDir = path.join(repoRoot, "kubernetes", "core", "applications");
export const sopsYamlPath = path.join(repoRoot, ".sops.yaml");
export const defaultAgeKeyPath = path.join(
  process.env.HOME ?? "",
  ".config",
  "sops",
  "age",
  "keys.txt",
);
