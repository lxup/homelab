import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ListrTask } from "listr2";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { argocdRepoCredentialsPath, kubeconfigPath } from "../lib/paths.js";

/**
 * Doc: gives this tenant's ArgoCD a Git credential for github.com/lxup, and
 * runs unconditionally — a credential ArgoCD does not need is simply unused.
 * The point is that flipping this repo to private becomes a visibility toggle
 * on GitHub and nothing else.
 *
 * It lives in bootstrap/ and is applied imperatively rather than committed
 * under kubernetes/, because the GitOps version is circular: ArgoCD would
 * have to clone this repo to find the credential that lets it clone this
 * repo. That is the trap the pre-split arrangement was in, where the
 * credential sat in kubernetes/core/services/argocd/ and only worked because
 * the repo happened to be public.
 *
 * Each tenant needs its own: the platform's credential lives on the host and
 * is not visible from inside a vcluster.
 */
export const argocdRepoCredentialsStep: ListrTask<InstallCtx> = {
  title: "Create ArgoCD repository credentials",
  skip: () =>
    existsSync(argocdRepoCredentialsPath)
      ? false
      : "bootstrap/argocd/repo-credentials.sops.yaml absent — ArgoCD will clone anonymously (public repos only)",
  task: async (ctx, task) => {
    task.output = "Decrypting bootstrap/argocd/repo-credentials.sops.yaml";
    const { stdout } = await execa("sops", ["-d", argocdRepoCredentialsPath], {
      env: { SOPS_AGE_KEY_FILE: ctx.ageKeyPath },
    });

    if (stdout.includes("REPLACE_WITH_A_READ_ONLY_PAT")) {
      throw new Error(
        "repo-credentials.sops.yaml still holds the template placeholder — put a real read-only PAT in it (see repo-credentials.example.yaml).",
      );
    }

    // Never written into the repo tree, and removed even on failure: this is
    // a cleartext Git credential.
    const scratch = await mkdtemp(path.join(tmpdir(), "homelab-repocreds-"));
    try {
      const file = path.join(scratch, "repo-credentials.yaml");
      await writeFile(file, stdout + "\n", { mode: 0o600 });
      await execa("kubectl", ["apply", "-f", file], { env: { KUBECONFIG: kubeconfigPath } });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    task.title = "ArgoCD can read github.com/lxup (works whether the repos are public or private)";
  },
};
