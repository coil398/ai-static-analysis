// go list -json parser — GO_SPEC.md §4

import { exec } from "./utils.ts";

export interface GoPackage {
  Dir: string;
  ImportPath: string;
  Name: string;
  GoFiles: string[];
  Imports?: string[];
  Module?: { Path: string; Dir: string };
  Standard?: boolean;
}

/**
 * Run `go list -json ./...` and parse the concatenated JSON output.
 * go list outputs multiple JSON objects concatenated (not valid JSON array),
 * so we parse them one-by-one using brace counting.
 */
export async function goList(
  repoRoot: string,
  profile: Record<string, string>,
): Promise<GoPackage[]> {
  const env: Record<string, string> = {};
  if (profile["GOOS"]) env["GOOS"] = profile["GOOS"];
  if (profile["GOARCH"]) env["GOARCH"] = profile["GOARCH"];
  if (profile["GOTAGS"]) env["GOFLAGS"] = `-tags=${profile["GOTAGS"]}`;

  const result = await exec(["go", "list", "-json", "./..."], {
    cwd: repoRoot,
  });

  if (result.exitCode !== 0) {
    throw new Error(`go list failed: ${result.stderr}`);
  }

  return parseNDJSON(result.stdout);
}

/**
 * Parse concatenated JSON objects (NDJSON-like output from go list -json).
 * Each object is a complete JSON value delimited by matching braces.
 */
export function parseNDJSON(input: string): GoPackage[] {
  const packages: GoPackage[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const chunk = input.slice(start, i + 1);
        packages.push(JSON.parse(chunk) as GoPackage);
        start = -1;
      }
    }
  }

  return packages;
}
