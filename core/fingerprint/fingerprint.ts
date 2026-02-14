import { rm } from "node:fs/promises";
import type { Fingerprint } from "../schema/index.ts";

const SCHEMA_VERSION = 1;

async function execCapture(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    return text.trim();
  } catch {
    return null;
  }
}

interface GenerateOptions {
  /** Extra key-value pairs for build_profile */
  profile?: Record<string, string>;
  /** Tool commands to probe. Defaults to common runtimes. */
  tools?: Record<string, string[]>;
}

const DEFAULT_TOOLS: Record<string, string[]> = {
  bun: ["bun", "--version"],
  go: ["go", "version"],
  node: ["node", "--version"],
};

export async function generateFingerprint(
  repoRoot: string,
  options?: GenerateOptions,
): Promise<Fingerprint> {
  const toolSpecs = options?.tools ?? DEFAULT_TOOLS;

  // Probe tools in parallel
  const toolEntries = await Promise.all(
    Object.entries(toolSpecs).map(async ([name, cmd]) => {
      const version = await execCapture(cmd);
      return version ? ([name, version] as const) : null;
    }),
  );
  const tools: Record<string, string> = {};
  for (const entry of toolEntries) {
    if (entry) tools[entry[0]] = entry[1];
  }

  // Git commit hash
  const commit =
    (await execCapture(["git", "-C", repoRoot, "rev-parse", "HEAD"])) ??
    "unknown";

  const buildProfile: Record<string, string> = {
    os: process.platform,
    arch: process.arch,
    ...(options?.profile ?? {}),
  };

  return {
    schema_version: SCHEMA_VERSION,
    tools,
    build_profile: buildProfile,
    repo_state: { commit },
    created_at: new Date().toISOString(),
  };
}

export interface CompareResult {
  match: boolean;
  diffs: string[];
}

export function compareFingerprint(
  current: Fingerprint,
  cached: Fingerprint,
): CompareResult {
  const diffs: string[] = [];

  if (current.schema_version !== cached.schema_version) {
    diffs.push(
      `schema_version: ${cached.schema_version} → ${current.schema_version}`,
    );
  }

  // Compare tools
  const allToolKeys = new Set([
    ...Object.keys(current.tools),
    ...Object.keys(cached.tools),
  ]);
  for (const key of allToolKeys) {
    const cur = current.tools[key];
    const cac = cached.tools[key];
    if (cur !== cac) {
      diffs.push(`tools.${key}: ${cac ?? "(missing)"} → ${cur ?? "(missing)"}`);
    }
  }

  // Compare build_profile
  const allProfileKeys = new Set([
    ...Object.keys(current.build_profile),
    ...Object.keys(cached.build_profile),
  ]);
  for (const key of allProfileKeys) {
    const cur = current.build_profile[key];
    const cac = cached.build_profile[key];
    if (cur !== cac) {
      diffs.push(
        `build_profile.${key}: ${cac ?? "(missing)"} → ${cur ?? "(missing)"}`,
      );
    }
  }

  return { match: diffs.length === 0, diffs };
}

export async function wipeCache(cacheDir: string): Promise<void> {
  await rm(cacheDir, { recursive: true, force: true });
}
