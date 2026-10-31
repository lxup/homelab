import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { kubeconfigPath } from "../lib/paths.js";
import { retry } from "../lib/retry.js";

/**
 * Doc: used to wait for Talos nodes to report Ready. A tenant has no nodes of
 * its own — it sees the host's, and whether those are healthy is the
 * platform's problem, not something to block this installer on.
 *
 * What does matter is that the vcluster's API server is actually serving,
 * which it is not for the first few seconds after the control-plane pod
 * starts. Everything downstream (`helm install`, `kubectl apply`) fails
 * confusingly if it runs too early.
 */
export const waitReadyStep: ListrTask<InstallCtx> = {
  title: "Wait for the tenant API to serve",
  task: async (_ctx, task) => {
    const env = { KUBECONFIG: kubeconfigPath };

    await retry(
      async () => {
        const { exitCode, stderr } = await execa(
          "kubectl",
          ["get", "--raw", "/readyz"],
          { env, reject: false },
        );
        if (exitCode !== 0) throw new Error(`/readyz not ready yet: ${stderr}`);
        task.output = "API server reports ready";
      },
      { attempts: 30, delayMs: 4000 },
    );

    const { stdout } = await execa(
      "kubectl",
      ["get", "nodes", "--no-headers", "-o", "custom-columns=N:.metadata.name"],
      { env, reject: false },
    );
    const nodes = (stdout ?? "").trim().split("\n").filter(Boolean);
    task.title = `Tenant API serving (sees ${nodes.length} host node${nodes.length === 1 ? "" : "s"})`;
  },
};
