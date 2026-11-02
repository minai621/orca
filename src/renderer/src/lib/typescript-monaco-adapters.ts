declare module 'monaco-editor/esm/vs/language/typescript/languageFeatures.js' {
  import type * as Monaco from 'monaco-editor'
  type WorkerAccessor = (...uris: Monaco.Uri[]) => Promise<Monaco.typescript.TypeScriptWorker>
  export class QuickInfoAdapter {
    constructor(worker: WorkerAccessor)
    provideHover: Monaco.languages.HoverProvider['provideHover']
  }
  export class SuggestAdapter {
    constructor(worker: WorkerAccessor)
    provideCompletionItems: Monaco.languages.CompletionItemProvider['provideCompletionItems']
    resolveCompletionItem: NonNullable<
      Monaco.languages.CompletionItemProvider['resolveCompletionItem']
    >
  }
  export class SignatureHelpAdapter {
    constructor(worker: WorkerAccessor)
    provideSignatureHelp: Monaco.languages.SignatureHelpProvider['provideSignatureHelp']
  }
  export class LibFiles {
    constructor(worker: WorkerAccessor)
  }
  export class DefinitionAdapter {
    constructor(libFiles: LibFiles, worker: WorkerAccessor)
    provideDefinition: Monaco.languages.DefinitionProvider['provideDefinition']
  }
}
