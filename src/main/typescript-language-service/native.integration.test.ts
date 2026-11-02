import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { TypeScriptLanguageService } from './server'

const installedProject = process.env.ORCA_TYPESCRIPT_NATIVE_ROOT
it.skipIf(!installedProject)(
  'runs hover, unsaved changes and definition against an installed native compiler',
  async () => {
    if (!installedProject) {
      return
    }
    const rootPath = realpathSync(mkdtempSync(join(tmpdir(), 'orca-native-lsp-')))
    const service = new TypeScriptLanguageService()
    try {
      symlinkSync(
        join(installedProject, 'node_modules'),
        join(rootPath, 'node_modules'),
        'junction'
      )
      writeFileSync(
        join(rootPath, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] })
      )
      const filePath = join(rootPath, 'file.ts')
      const content = 'const target: number = 1;\nconst result = target;\n'
      writeFileSync(filePath, content)
      const query = {
        rootPath,
        filePath,
        content,
        version: 1,
        position: { line: 1, character: 17 }
      }
      const hover = await service.query({ ...query, method: 'hover' })
      expect(hover.available).toBe(true)
      expect(JSON.stringify(hover)).toContain('number')
      const changed = await service.query({
        ...query,
        method: 'hover',
        version: 2,
        content: content.replace('number = 1', 'string = "value"')
      })
      expect(JSON.stringify(changed)).toContain('string')
      const definition = await service.query({
        ...query,
        method: 'definition',
        version: 2,
        content: content.replace('number = 1', 'string = "value"')
      })
      expect(definition).toMatchObject({ available: true, result: expect.anything() })
      expect(JSON.stringify(definition)).toContain('file.ts')
      await service.query({ ...query, method: 'close' })
    } finally {
      service.dispose()
      rmSync(rootPath, { recursive: true, force: true })
    }
  }
)
