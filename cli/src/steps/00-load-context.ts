import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { kubeconfigPath } from "../lib/paths.js";

/**
 * Doc: there is no topology to read any more. This repo used to own
 * talos/talconfig.yaml and every node the cluster would ever have; the
 * machine is now lxup/platform's business and this tenant runs in a
 * vcluster declared there.
 *
 * So the only context worth establishing is whether ArgoCD is already in
 * place, which decides whether this run is a bootstrap or a reconcile.
 */
export const loadContextStep: ListrTask<InstallCtx> = {
  title: "Check whether ArgoCD is already installed",
  task: async (ctx, task) => {
    const { stdout } = await execa(
      "kubectl",
      ["-n", "argocd", "get", "deploy", "argocd-server", "--ignore-not-found", "-o", "name"],
      { env: { KUBECONFIG: kubeconfigPath }, reject: false },
    );

    ctx.alreadyInstalled = (stdout ?? "").trim().length > 0;
    task.title = ctx.alreadyInstalled
      ? "ArgoCD already installed — this run reconciles it"
      : "No ArgoCD yet — this run bootstraps it";
  },
};
