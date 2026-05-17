// LSP client for gopls — re-exports shared LspClient as GoplsLspClient for backward compatibility.
// The generic implementation lives in adapters/shared/lsp-client.ts.

export type {
  LspPosition,
  LspRange,
  LspLocation,
  LspDocumentSymbol,
  LspCallHierarchyItem,
  LspCallHierarchyOutgoingCall,
  LspCallHierarchyIncomingCall,
  LspDiagnostic,
  LspDocumentDiagnosticReport,
} from "../shared/lsp-client.ts";

export { LspClient } from "../shared/lsp-client.ts";

import { LspClient } from "../shared/lsp-client.ts";

/** Thin wrapper around LspClient pre-configured for gopls. */
export class GoplsLspClient extends LspClient {
  constructor(repoRoot: string) {
    super(["gopls", "serve"], repoRoot);
  }
}
