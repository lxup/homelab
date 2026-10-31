import * as p from "@clack/prompts";
import pc from "picocolors";
import { Listr } from "listr2";
import type { InstallCtx } from "../lib/context.js";

import { loadContextStep } from "../steps/00-load-context.js";
import { prerequisitesStep } from "../steps/01-prerequisites.js";
import { ageKeyStep } from "../steps/02-age-key.js";
import { kubeconfigStep } from "../steps/03-kubeconfig.js";
import { waitReadyStep } from "../steps/04-wait-ready.js";
import { sopsSecretStep } from "../steps/05-sops-secret.js";
import { installArgocdStep } from "../steps/06-install-argocd.js";
import { argocdRepoCredentialsStep } from "../steps/07-argocd-repo-credentials.js";
import { applyRootAppStep } from "../steps/08-apply-root-app.js";

/**
 * The bootstrap layer for this tenant: everything that cannot be GitOps
 * because it has to exist before GitOps does.
 *
 * Shorter than it used to be. This repo no longer provisions a cluster —
 * no talhelper, no talosctl, no etcd bootstrap. The machine belongs to
 * lxup/platform, which hands out a vcluster; the only thing crossing that
 * boundary is ./kubeconfig. Everything from step 05 on is unchanged from
 * when this installed onto bare metal, which is the point: swapping the
 * provisioner did not touch the GitOps bootstrap.
 */
const STEPS = [
  loadContextStep,
  prerequisitesStep,
  ageKeyStep,
  kubeconfigStep,
  waitReadyStep,
  // sops-age must exist BEFORE ArgoCD installs — its repo-server mounts it
  // as a volume, and a missing Secret leaves the pod pending forever while
  // helm --wait times out.
  sopsSecretStep,
  installArgocdStep,
  // Before the root app, not after: this is what lets ArgoCD clone the repo
  // the root app points it at, if this repo ever goes private.
  argocdRepoCredentialsStep,
  applyRootAppStep,
];

/** First run, or reconciling an ArgoCD that is already there — same command either way. */
export async function runInstall() {
  p.intro(pc.bgCyan(pc.black(" install ")));

  p.log.message(
    [
      "This installs ArgoCD into this tenant's vcluster and hands it GitOps.",
      "",
      "It does NOT create a cluster. ./kubeconfig must already point at the",
      "homelab vcluster — produce it with `bun run src/index.ts tenant` in",
      "lxup/platform and copy it here.",
    ].join("\n"),
  );

  const proceed = await p.confirm({ message: "Continue?", initialValue: true });
  if (p.isCancel(proceed) || !proceed) {
    p.cancel("Aborted — nothing was touched.");
    return;
  }

  const tasks = new Listr<InstallCtx>(STEPS, {
    concurrent: false,
    exitOnError: true,
    rendererOptions: { collapseSubtasks: false },
  });

  try {
    await tasks.run({} as InstallCtx);
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro(pc.red("Install failed — re-run once you've fixed the issue above."));
    return;
  }

  p.note(
    [
      "export KUBECONFIG=./kubeconfig",
      "kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d",
      "https://argocd.nvlab.fr  (once its Ingress is synced to the host Traefik)",
    ].join("\n"),
    "Next steps",
  );

  p.outro(pc.green("ArgoCD now owns kubernetes/core/ in this repo."));
}

/** Re-install just ArgoCD — used by the status command when it's missing or unhealthy. */
export async function runInstallArgocdOnly() {
  const tasks = new Listr<InstallCtx>(
    [loadContextStep, ageKeyStep, sopsSecretStep, installArgocdStep],
    { concurrent: false, exitOnError: true },
  );
  await tasks.run({} as InstallCtx);
}

/** Re-apply the app-of-apps — used by the status command when it's missing. */
export async function runApplyRootApp() {
  const tasks = new Listr<InstallCtx>([applyRootAppStep], { concurrent: false, exitOnError: true });
  await tasks.run({} as InstallCtx);
}
