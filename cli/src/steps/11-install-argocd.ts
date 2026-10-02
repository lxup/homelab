import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { argocdBootstrapValuesPath, kubeconfigPath, repoRoot } from "../lib/paths.js";

/**
 * Doc: `helm upgrade --install` is idempotent — safe to run every time
 * (fresh bootstrap or adding a node to an existing cluster), it just
 * confirms ArgoCD is already as described in bootstrap/argocd/values.yaml
 * and does nothing if so. This is also how you upgrade ArgoCD itself
 * later: bump the chart version there and re-run.
 */
export const installArgocdStep: ListrTask<InstallCtx> = {
  title: "Install ArgoCD",
  task: async (_ctx, task) => {
    const env = { KUBECONFIG: kubeconfigPath };

    task.output = "helm repo add/update argo";
    await execa("helm", ["repo", "add", "argo", "https://argoproj.github.io/argo-helm"], {
      cwd: repoRoot,
      env,
      reject: false,
    });
    await execa("helm", ["repo", "update", "argo"], { cwd: repoRoot, env });

    task.output = "helm upgrade --install argocd (this can take a minute)";
    await execa(
      "helm",
      [
        "upgrade",
        "--install",
        "argocd",
        "argo/argo-cd",
        "--namespace",
        "argocd",
        "--create-namespace",
        "--values",
        argocdBootstrapValuesPath,
        "--wait",
      ],
      { cwd: repoRoot, env },
    );

    task.title = "ArgoCD installed";
  },
};
