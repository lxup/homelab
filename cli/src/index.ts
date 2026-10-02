#!/usr/bin/env node
import * as p from "@clack/prompts";
import pc from "picocolors";
import { runInstall } from "./commands/install.js";
import { runStatus } from "./commands/status.js";

type Section = "install" | "status";

const SECTIONS: Record<Section, () => Promise<void>> = {
  install: runInstall,
  status: runStatus,
};

async function menu() {
  console.clear();
  p.intro(pc.bgCyan(pc.black(" homelab ")));

  const section = await p.select({
    message: "What do you want to do?",
    options: [
      { value: "install", label: "Install", hint: "bring up Talos + Kubernetes + ArgoCD from scratch" },
      { value: "status", label: "Status", hint: "check cluster health, fix what's missing" },
    ],
  });

  if (p.isCancel(section)) {
    p.cancel("Bye.");
    return;
  }

  await SECTIONS[section as Section]();
}

async function main() {
  const [, , arg] = process.argv;

  if (arg && arg in SECTIONS) {
    console.clear();
    await SECTIONS[arg as Section]();
    return;
  }

  if (arg) {
    console.error(`Unknown command "${arg}". Available: ${Object.keys(SECTIONS).join(", ")}`);
    process.exit(1);
  }

  await menu();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
