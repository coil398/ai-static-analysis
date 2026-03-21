// gopls integration — GO_SPEC.md §10
// Uses gopls LSP server for high-performance symbol analysis.
// Falls back to CLI mode if LSP is unavailable.

import { relative, resolve } from "node:path";
import {
  GoplsLspClient,
  type LspDocumentSymbol,
  type LspCallHierarchyItem,
} from "./lsp-client.ts";

// --- Public types (unchanged from CLI version) ---

export interface GoplsSymbol {
  name: string;
  kind: string;
  line: number; // 1-based
  endCol: number;
  startCol: number;
  children: GoplsSymbol[];
  parentName?: string;
}

export interface GoplsCallEdge {
  name: string;
  file: string; // absolute path
  line: number; // 1-based
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
  file: string; // absolute path
  line: number; // 1-based
  col: number;
  endCol: number;
}

// --- LSP Symbol Kind → string mapping ---

const LSP_KIND_MAP: Record<number, string> = {
  2: "Module",
  5: "Struct",
  6: "Method",
  8: "Field",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  22: "Struct",
  23: "Struct",
};

function lspKindToString(kind: number): string {
  return LSP_KIND_MAP[kind] ?? "Unknown";
}

// --- LSP-based implementation ---

function lspSymbolToGoplsSymbol(
  sym: LspDocumentSymbol,
  parentName?: string,
): GoplsSymbol {
  const result: GoplsSymbol = {
    name: sym.name,
    kind: lspKindToString(sym.kind),
    line: sym.selectionRange.start.line + 1, // LSP is 0-based
    startCol: sym.selectionRange.start.character + 1,
    endCol: sym.selectionRange.end.character + 1,
    children: [],
    parentName,
  };

  if (sym.children) {
    for (const child of sym.children) {
      result.children.push(lspSymbolToGoplsSymbol(child, sym.name));
    }
  }

  return result;
}

export async function goplsSymbols(
  filePath: string,
  _cwd: string,
  client: GoplsLspClient,
): Promise<GoplsSymbol[]> {
  const lspSymbols = await client.documentSymbols(filePath);
  return lspSymbols.map((s) => lspSymbolToGoplsSymbol(s));
}

export async function goplsCallHierarchy(
  filePath: string,
  line: number,
  col: number,
  _cwd: string,
  client: GoplsLspClient,
): Promise<GoplsCallHierarchy | null> {
  // LSP is 0-based
  const items = await client.prepareCallHierarchy(filePath, line - 1, col - 1);
  if (items.length === 0) return null;

  const item = items[0]!;
  const result: GoplsCallHierarchy = {
    identifier: {
      name: item.name,
      file: GoplsLspClient.uriToPath(item.uri),
      line: item.selectionRange.start.line + 1,
      col: item.selectionRange.start.character + 1,
    },
    incoming: [],
    outgoing: [],
  };

  // Get outgoing calls
  const outgoing = await client.outgoingCalls(item);
  for (const call of outgoing) {
    const toFile = GoplsLspClient.uriToPath(call.to.uri);
    for (const fromRange of call.fromRanges) {
      result.outgoing.push({
        name: call.to.name,
        file: toFile,
        line: call.to.selectionRange.start.line + 1,
        col: call.to.selectionRange.start.character + 1,
        rangeLine: fromRange.start.line + 1,
        rangeCol: fromRange.start.character + 1,
        rangeEndCol: fromRange.end.character + 1,
      });
    }
  }

  // Get incoming calls
  const incoming = await client.incomingCalls(item);
  for (const call of incoming) {
    result.incoming.push({
      name: call.from.name,
      file: GoplsLspClient.uriToPath(call.from.uri),
      line: call.from.selectionRange.start.line + 1,
      col: call.from.selectionRange.start.character + 1,
      rangeLine: 0,
      rangeCol: 0,
      rangeEndCol: 0,
    });
  }

  return result;
}

export async function goplsReferences(
  filePath: string,
  line: number,
  col: number,
  _cwd: string,
  client: GoplsLspClient,
): Promise<GoplsLocation[]> {
  const locs = await client.references(filePath, line - 1, col - 1);
  return locs.map((loc) => ({
    file: GoplsLspClient.uriToPath(loc.uri),
    line: loc.range.start.line + 1,
    col: loc.range.start.character + 1,
    endCol: loc.range.end.character + 1,
  }));
}

export async function goplsImplementation(
  filePath: string,
  line: number,
  col: number,
  _cwd: string,
  client: GoplsLspClient,
): Promise<GoplsLocation[]> {
  const locs = await client.implementation(filePath, line - 1, col - 1);
  return locs.map((loc) => ({
    file: GoplsLspClient.uriToPath(loc.uri),
    line: loc.range.start.line + 1,
    col: loc.range.start.character + 1,
    endCol: loc.range.end.character + 1,
  }));
}

// --- CLI parser functions (kept for unit tests) ---

export function parseSymbolsOutput(output: string): GoplsSymbol[] {
  const symbols: GoplsSymbol[] = [];
  let currentParent: GoplsSymbol | null = null;

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;

    const isChild = line.startsWith("\t");
    const trimmed = line.trim();

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

export function parseCallHierarchyOutput(output: string): GoplsCallHierarchy {
  const result: GoplsCallHierarchy = {
    identifier: { name: "", file: "", line: 0, col: 0 },
    incoming: [],
    outgoing: [],
  };

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

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

export function parseImplementationOutput(output: string): GoplsLocation[] {
  const locations: GoplsLocation[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
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

export function parseReferencesOutput(output: string): GoplsLocation[] {
  return parseImplementationOutput(output);
}
