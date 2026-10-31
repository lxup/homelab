import { existsSync } from "node:fs";
import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { kubeconfigPath } from "../lib/paths.js";

/**
 * Doc: this repo does not produce its own cluster any more and holds no
 * credentials for the machine underneath. The cluster is a vcluster declared
 * in lxup/platform; the only thing that crosses the boundary is a kubeconfig,
 * which `platform tenant` writes to tenants/homelab.kubeconfig there.
 *
 * So this step fetches nothing. It checks that the file is present, that the
 * API answers, and — the part that earns its place — that it is pointing at
 * the TENANT and not at the host cluster. Running this installer against the
 * platform's kubeconfig would install a second ArgoCD into the real cluster
 * alongside the one that manages it, which is a genuinely bad afternoon.
 *
 * The tell is longhorn-system: Longhorn runs on the real cluster, and a
 * vcluster sees its StorageClasses (sync.fromHost.storageClasses) but not
 * its namespace.
 */
export const kubeconfigStep: ListrTask<InstallCtx> = {
  title: "Verify the tenant kubeconfig",
  task: async (_ctx, task) => {
    if (!existsSync(kubeconfigPath)) {
      throw new Error(
        [
          "No ./kubeconfig. This repo no longer creates its own cluster.",
          "",
          "In lxup/platform:",
          "  bun run src/index.ts tenant      # writes tenants/homelab.kubeconfig",
          "",
          "then copy that file here as ./kubeconfig.",
        ].join("\n"),
      );
    }

    const env = { KUBECONFIG: kubeconfigPath };

    const version = await execa("kubectl", ["version", "-o", "json"], { env, reject: false });
    if (version.exitCode !== 0) {
      throw new Error(`kubeconfig present but the API is unreachable:\n${version.stderr}`);
    }

    const host = await execa(
      "kubectl",
      ["get", "namespace", "longhorn-system", "--ignore-not-found", "-o", "name"],
      { env, reject: false },
    );

    if ((host.stdout ?? "").trim().length > 0) {
      throw new Error(
        [
          "This kubeconfig points at the HOST cluster, not at this tenant's vcluster.",
          "(longhorn-system exists — a vcluster sees Longhorn's StorageClasses, never its namespace.)",
          "",
          "Running the installer here would put a second ArgoCD into the real",
          "cluster next to the one that manages it. Refusing.",
          "",
          "Get the right file with `platform tenant` in lxup/platform.",
        ].join("\n"),
      );
    }

    const { stdout: server } = await execa(
      "kubectl",
      ["config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"],
      { env, reject: false },
    );

    task.title = `Tenant cluster reachable at ${server || "(unknown)"}`;
  },
};
