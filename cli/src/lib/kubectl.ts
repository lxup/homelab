import { execa } from "execa";
import { kubeconfigPath } from "./paths.js";

const env = { KUBECONFIG: kubeconfigPath };

async function kubectlJson<T>(args: string[]): Promise<T | null> {
  try {
    const { stdout } = await execa("kubectl", [...args, "-o", "json"], { env });
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

export async function helmReleaseExists(namespace: string, name: string): Promise<boolean> {
  try {
    await execa("helm", ["status", name, "-n", namespace], { env });
    return true;
  } catch {
    return false;
  }
}

export async function getDeploymentReady(namespace: string, name: string) {
  const dep = await kubectlJson<{ status: { replicas?: number; readyReplicas?: number } }>([
    "get",
    "deployment",
    name,
    "-n",
    namespace,
  ]);
  if (!dep) return null;
  return { desired: dep.status.replicas ?? 0, ready: dep.status.readyReplicas ?? 0 };
}

export interface ArgoApplication {
  health: string;
  sync: string;
}

export async function getArgoApplication(name: string): Promise<ArgoApplication | null> {
  const app = await kubectlJson<{
    status?: { health?: { status?: string }; sync?: { status?: string } };
  }>(["get", "application", name, "-n", "argocd"]);
  if (!app) return null;
  return {
    health: app.status?.health?.status ?? "Unknown",
    sync: app.status?.sync?.status ?? "Unknown",
  };
}

export async function refreshArgoApplication(name: string) {
  await execa(
    "kubectl",
    [
      "annotate",
      "application",
      name,
      "-n",
      "argocd",
      "argocd.argoproj.io/refresh=hard",
      "--overwrite",
    ],
    { env },
  );
}
