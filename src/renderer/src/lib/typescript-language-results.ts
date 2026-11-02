import type * as Monaco from 'monaco-editor'
import { z } from 'zod'

const position = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative()
})
const range = z.object({ start: position, end: position })
const markup = z.union([
  z.string(),
  z.object({ value: z.string(), kind: z.string().optional(), language: z.string().optional() })
])
const hover = z.object({ contents: z.union([markup, z.array(markup)]), range: range.optional() })
const textEdit = z.object({ range, newText: z.string() })
const completion = z.object({
  label: z.string(),
  kind: z.number().int().optional(),
  detail: z.string().optional(),
  documentation: markup.optional(),
  insertText: z.string().optional(),
  insertTextFormat: z.number().optional(),
  sortText: z.string().optional(),
  filterText: z.string().optional(),
  textEdit: z
    .union([textEdit, z.object({ insert: range, replace: range, newText: z.string() })])
    .optional(),
  additionalTextEdits: z.array(textEdit).optional()
})
const completions = z.union([
  z.array(completion),
  z.object({ items: z.array(completion), isIncomplete: z.boolean().optional() })
])
const signature = z.object({
  signatures: z.array(
    z.object({
      label: z.string(),
      documentation: markup.optional(),
      parameters: z
        .array(
          z.object({
            label: z.union([z.string(), z.tuple([z.number(), z.number()])]),
            documentation: markup.optional()
          })
        )
        .optional(),
      activeParameter: z.number().optional()
    })
  ),
  activeSignature: z.number().optional(),
  activeParameter: z.number().optional()
})
const location = z.union([
  z.object({ uri: z.string(), range }),
  z.object({ targetUri: z.string(), targetRange: range, targetSelectionRange: range.optional() })
])

/**
 * LSP 범위를 Monaco의 1부터 시작하는 좌표로 바꿔요.
 * @param value - LSP의 0부터 시작하는 범위예요.
 */
function toRange(value: z.infer<typeof range>): Monaco.IRange {
  return {
    startLineNumber: value.start.line + 1,
    startColumn: value.start.character + 1,
    endLineNumber: value.end.line + 1,
    endColumn: value.end.character + 1
  }
}

/**
 * 검증된 문서 설명을 Monaco Markdown으로 바꿔요.
 * @param value - 서버가 반환한 설명이에요.
 */
function markdown(value: z.infer<typeof markup>): Monaco.IMarkdownString {
  if (typeof value === 'string') {
    return { value }
  }
  return { value: value.language ? `\`\`\`${value.language}\n${value.value}\n\`\`\`` : value.value }
}

/**
 * 검증된 hover만 표시해요.
 * @param value - 신뢰하지 않은 서버 응답이에요.
 */
export function toTypeScriptHover(value: unknown): Monaco.languages.Hover | undefined {
  const parsed = hover.safeParse(value)
  if (!parsed.success) {
    return undefined
  }
  const contents = Array.isArray(parsed.data.contents)
    ? parsed.data.contents
    : [parsed.data.contents]
  return {
    contents: contents.map(markdown),
    range: parsed.data.range && toRange(parsed.data.range)
  }
}

/**
 * LSP 완성 항목과 편집 범위를 검증해요.
 * @param value - 서버 응답이에요.
 * @param monaco - 현재 편집기의 Monaco API예요.
 * @param fallbackRange - 편집 범위가 없는 항목에 쓸 단어 범위예요.
 */
export function toTypeScriptCompletions(
  value: unknown,
  monaco: typeof Monaco,
  fallbackRange: Monaco.IRange
): Monaco.languages.CompletionList | undefined {
  const parsed = completions.safeParse(value)
  if (!parsed.success) {
    return undefined
  }
  const items = Array.isArray(parsed.data) ? parsed.data : parsed.data.items
  const kinds = [
    monaco.languages.CompletionItemKind.Text,
    monaco.languages.CompletionItemKind.Method,
    monaco.languages.CompletionItemKind.Function,
    monaco.languages.CompletionItemKind.Constructor,
    monaco.languages.CompletionItemKind.Field,
    monaco.languages.CompletionItemKind.Variable,
    monaco.languages.CompletionItemKind.Class,
    monaco.languages.CompletionItemKind.Interface,
    monaco.languages.CompletionItemKind.Module,
    monaco.languages.CompletionItemKind.Property,
    monaco.languages.CompletionItemKind.Unit,
    monaco.languages.CompletionItemKind.Value,
    monaco.languages.CompletionItemKind.Enum,
    monaco.languages.CompletionItemKind.Keyword,
    monaco.languages.CompletionItemKind.Snippet,
    monaco.languages.CompletionItemKind.Color,
    monaco.languages.CompletionItemKind.File,
    monaco.languages.CompletionItemKind.Reference,
    monaco.languages.CompletionItemKind.Folder,
    monaco.languages.CompletionItemKind.EnumMember,
    monaco.languages.CompletionItemKind.Constant,
    monaco.languages.CompletionItemKind.Struct,
    monaco.languages.CompletionItemKind.Event,
    monaco.languages.CompletionItemKind.Operator,
    monaco.languages.CompletionItemKind.TypeParameter
  ]
  return {
    incomplete: !Array.isArray(parsed.data) && parsed.data.isIncomplete,
    suggestions: items.map((item) => ({
      label: item.label,
      kind: kinds[(item.kind ?? 1) - 1] ?? monaco.languages.CompletionItemKind.Text,
      detail: item.detail,
      documentation: item.documentation && markdown(item.documentation),
      insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
      insertTextRules:
        item.insertTextFormat === 2
          ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
          : undefined,
      sortText: item.sortText,
      filterText: item.filterText,
      range: item.textEdit
        ? 'range' in item.textEdit
          ? toRange(item.textEdit.range)
          : { insert: toRange(item.textEdit.insert), replace: toRange(item.textEdit.replace) }
        : fallbackRange,
      additionalTextEdits: item.additionalTextEdits?.map((edit) => ({
        range: toRange(edit.range),
        text: edit.newText
      }))
    }))
  }
}

/**
 * 함수의 매개변수 도움말을 검증해요.
 * @param value - 서버 응답이에요.
 */
export function toTypeScriptSignature(
  value: unknown
): Monaco.languages.SignatureHelpResult | undefined {
  const parsed = signature.safeParse(value)
  if (!parsed.success) {
    return undefined
  }
  return {
    value: {
      activeSignature: parsed.data.activeSignature ?? 0,
      activeParameter: parsed.data.activeParameter ?? 0,
      signatures: parsed.data.signatures.map((item) => ({
        label: item.label,
        documentation: item.documentation && markdown(item.documentation),
        parameters: (item.parameters ?? []).map((parameter) => ({
          label: parameter.label,
          documentation: parameter.documentation && markdown(parameter.documentation)
        }))
      }))
    },
    dispose() {}
  }
}

/**
 * 로컬 파일 정의 위치만 검증해요.
 * @param value - 서버 응답이에요.
 * @param monaco - URI를 생성할 Monaco API예요.
 */
export function toTypeScriptDefinitions(
  value: unknown,
  monaco: typeof Monaco
): Monaco.languages.Location[] | undefined {
  const parsed = z.union([location, z.array(location)]).safeParse(value)
  if (!parsed.success) {
    return undefined
  }
  return (Array.isArray(parsed.data) ? parsed.data : [parsed.data]).flatMap((item) => {
    const uri = monaco.Uri.parse('uri' in item ? item.uri : item.targetUri)
    return uri.scheme === 'file' && !uri.authority
      ? [
          {
            uri,
            range: toRange(
              'range' in item ? item.range : (item.targetSelectionRange ?? item.targetRange)
            )
          }
        ]
      : []
  })
}
