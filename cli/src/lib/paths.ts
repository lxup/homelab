import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** homelab/ — the git repo root (this file lives at cli/src/lib/). */
export const repoRoot = path.resolve(here, "..", "..", "..");

export const talosDir = path.join(repoRoot, "talos");
export const clusterConfigDir = path.join(talosDir, "clusterconfig");
export const talconfigPath = path.join(talosDir, "talconfig.yaml");
export const talsecretPath = path.join(talosDir, "talsecret.sops.yaml");
export const ciliumValuesPath = path.join(talosDir, "manifests", "cilium-values.yaml");
export const ciliumRenderedPath = path.join(talosDir, "manifests", "cilium.generated.yaml");
export const talosconfigPath = path.join(clusterConfigDir, "talosconfig");
export const kubeconfigPath = path.join(repoRoot, "kubeconfig");
export const argocdBootstrapValuesPath = path.join(repoRoot, "bootstrap", "argocd", "values.yaml");
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
