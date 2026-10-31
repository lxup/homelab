import type { ListrTask } from "listr2";
import { commandExists } from "../lib/exec.js";
import type { InstallCtx } from "../lib/context.js";

// No talosctl or talhelper: this repo stopped provisioning its own cluster
// when the platform was split out (lxup/platform). It installs ArgoCD into a
// vcluster that already exists and hands GitOps the rest.
const REQUIRED = [
  { bin: "helm", brew: "helm" },
  { bin: "kubectl", brew: "kubectl" },
  { bin: "sops", brew: "sops" },
  { bin: "age-keygen", brew: "age" },
];

/** Doc: these run on your laptop/workstation. */
export const prerequisitesStep: ListrTask<InstallCtx> = {
  title: "Check required tools",
  task: async (_ctx, task) => {
    const missing: string[] = [];

    for (const { bin, brew } of REQUIRED) {
      const ok = await commandExists(bin);
      task.output = `${ok ? "✓" : "✗"} ${bin}`;
      if (!ok) missing.push(brew);
    }

    if (missing.length > 0) {
      throw new Error(
        `Missing required tools. Install with:\n  brew install ${missing.join(" ")}`,
      );
    }
  },
};
