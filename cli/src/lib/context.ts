/** Shared state threaded through every install step. */
export interface InstallCtx {
  /** Absolute path to the Age private key used by sops/ksops. */
  ageKeyPath: string;
  agePublicKey?: string;
  /** True when ArgoCD is already installed — this run is reconciling, not bootstrapping. */
  alreadyInstalled: boolean;
}
