// gopls CLI wrapper — GO_SPEC.md §10 (future → now)
// Parses gopls subcommand output into structured data.

import { relative, resolve } from "node:path";
import { exec } from "./utils.ts";

// --- Types ---

export interface GoplsSymbol {
  name: string;
  kind: string; // "Function", "Struct", "Interface", "Method", "Field", "Variable", "Constant"
  line: number;
  endCol: number;
  startCol: number;
  children: GoplsSymbol[];
  parentName?: string; // for methods: receiver type name
}

export interface GoplsCallEdge {
  name: string;
  file: string;
  line: number;
  col: number;
  rangeLine: number;
  rangeCol: number;
  rangeEndCol: number;
}

export interface GoplsCallHierarchy {
  identifier: { name: string; file: string; line: number; col: number };
  incoming: GoplsCallEdge[];
  outgoing: GoplsCallEdge[];
}

export interface GoplsLocation {
  file: string;
  line: number;
  col: number;
  endCol: number;
}

// --- Execution ---

async function runGopls(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const result = await exec(["gopls", ...args], { cwd });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    ok: result.exitCode === 0,
  };
}

// --- Parsers ---

/**
 * Parse `gopls symbols <file>` output.
 *
 * Format:
 *   <name> <Kind> <line>:<col>-<endLine>:<endCol>
 *     <childName> <Kind> <line>:<col>-<endLine>:<endCol>
 */
export function parseSymbolsOutput(output: string): GoplsSymbol[] {
  const symbols: GoplsSymbol[] = [];
  let currentParent: GoplsSymbol | null = null;

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;

    const isChild = line.startsWith("\t");
    const trimmed = line.trim();

    // pattern: Name Kind line:col-endLine:endCol
    const match = /^(\S+)\s+(\S+)\s+(\d+):(\d+)-(\d+):(\d+)$/.exec(trimmed);
    if (!match) continue;

    const [, name, kind, lineStr, colStr, , endColStr] = match;
    const sym: GoplsSymbol = {
      name: name!,
      kind: kind!,
      line: parseInt(lineStr!, 10),
      startCol: parseInt(colStr!, 10),
      endCol: parseInt(endColStr!, 10),
      children: [],
    };

    if (isChild && currentParent) {
      sym.parentName = currentParent.name;
      currentParent.children.push(sym);
    } else {
      currentParent = sym;
      symbols.push(sym);
    }
  }

  return symbols;
}

/**
 * Run `gopls symbols` for a file.
 */
export async function goplsSymbols(
  filePath: string,
  cwd: string,
): Promise<GoplsSymbol[]> {
  const result = await runGopls(["symbols", filePath], cwd);
  if (!result.ok) return [];
  return parseSymbolsOutput(result.stdout);
}

/**
 * Parse `gopls call_hierarchy <position>` output.
 *
 * Format:
 *   incoming[N]: function <name> in <file>:<line>:<col>-<endCol>
 *   identifier: function <name> in <file>:<line>:<col>-<endCol>
 *   callee[N]: ranges <line>:<col>-<endCol> in <file> from/to function <name> in <file>:<line>:<col>-<endCol>
 */
export function parseCallHierarchyOutput(output: string): GoplsCallHierarchy {
  const result: GoplsCallHierarchy = {
    identifier: { name: "", file: "", line: 0, col: 0 },
    incoming: [],
    outgoing: [],
  };

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // identifier: function <name> in <file>:<line>:<col>-<endCol>
    const idMatch =
      /^identifier:\s+function\s+(\S+)\s+in\s+(.+):(\d+):(\d+)-(\d+)$/.exec(
        trimmed,
      );
    if (idMatch) {
      result.identifier = {
        name: idMatch[1]!,
        file: idMatch[2]!,
        line: parseInt(idMatch[3]!, 10),
        col: parseInt(idMatch[4]!, 10),
      };
      continue;
    }

    // callee[N]: ranges <line>:<col>-<endCol> in <file> from/to function <name> in <file>:<line>:<col>-<endCol>
    const calleeMatch =
      /^callee\[\d+\]:\s+ranges\s+(\d+):(\d+)-(\d+)\s+in\s+(.+?)\s+from\/to\s+function\s+(\S+)\s+in\s+(.+):(\d+):(\d+)-(\d+)$/.exec(
        trimmed,
      );
    if (calleeMatch) {
      result.outgoing.push({
        name: calleeMatch[5]!,
        file: calleeMatch[6]!,
        line: parseInt(calleeMatch[7]!, 10),
        col: parseInt(calleeMatch[8]!, 10),
        rangeLine: parseInt(calleeMatch[1]!, 10),
        rangeCol: parseInt(calleeMatch[2]!, 10),
        rangeEndCol: parseInt(calleeMatch[3]!, 10),
      });
      continue;
    }

    // incoming[N]: function <name> in <file>:<line>:<col>-<endCol>
    const incomingMatch =
      /^incoming\[\d+\]:\s+function\s+(\S+)\s+in\s+(.+):(\d+):(\d+)-(\d+)$/.exec(
        trimmed,
      );
    if (incomingMatch) {
      result.incoming.push({
        name: incomingMatch[1]!,
        file: incomingMatch[2]!,
        line: parseInt(incomingMatch[3]!, 10),
        col: parseInt(incomingMatch[4]!, 10),
        rangeLine: 0,
        rangeCol: 0,
        rangeEndCol: 0,
      });
    }
  }

  return result;
}

/**
 * Run `gopls call_hierarchy` for a position.
 */
export async function goplsCallHierarchy(
  filePath: string,
  line: number,
  col: number,
  cwd: string,
): Promise<GoplsCallHierarchy | null> {
  const result = await runGopls(
    ["call_hierarchy", `${filePath}:${line}:${col}`],
    cwd,
  );
  if (!result.ok) return null;
  return parseCallHierarchyOutput(result.stdout);
}

/**
 * Parse `gopls implementation <position>` output.
 *
 * Format:
 *   /path/to/file.go:<line>:<col>-<endCol>
 */
export function parseImplementationOutput(output: string): GoplsLocation[] {
  const locations: GoplsLocation[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // /path/to/file.go:line:col-endCol
    const match = /^(.+):(\d+):(\d+)-(\d+)$/.exec(trimmed);
    if (!match) continue;
    locations.push({
      file: match[1]!,
      line: parseInt(match[2]!, 10),
      col: parseInt(match[3]!, 10),
      endCol: parseInt(match[4]!, 10),
    });
  }
  return locations;
}

/**
 * Run `gopls implementation` for a position.
 */
export async function goplsImplementation(
  filePath: string,
  line: number,
  col: number,
  cwd: string,
): Promise<GoplsLocation[]> {
  const result = await runGopls(
    ["implementation", `${filePath}:${line}:${col}`],
    cwd,
  );
  if (!result.ok) return [];
  return parseImplementationOutput(result.stdout);
}

/**
 * Parse `gopls references -d <position>` output.
 *
 * Format:
 *   /path/to/file.go:<line>:<col>-<endCol>
 */
export function parseReferencesOutput(output: string): GoplsLocation[] {
  return parseImplementationOutput(output); // same format
}

/**
 * Run `gopls references -d` for a position.
 */
export async function goplsReferences(
  filePath: string,
  line: number,
  col: number,
  cwd: string,
): Promise<GoplsLocation[]> {
  const result = await runGopls(
    ["references", "-d", `${filePath}:${line}:${col}`],
    cwd,
  );
  if (!result.ok) return [];
  return parseReferencesOutput(result.stdout);
}
