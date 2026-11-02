import { z } from 'zod'

export const typeScriptQuerySchema = z.object({
  rootPath: z.string().min(1),
  filePath: z.string().min(1),
  content: z.string().max(8 * 1024 * 1024),
  version: z.number().int().nonnegative(),
  method: z.enum(['hover', 'completion', 'signatureHelp', 'definition', 'sync', 'close']),
  position: z.object({
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative()
  })
})

export type TypeScriptQuery = z.infer<typeof typeScriptQuerySchema>

export type TypeScriptQueryResult =
  | { available: false }
  | { available: true; result: unknown; version: string }
