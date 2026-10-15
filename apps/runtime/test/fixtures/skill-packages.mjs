import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../dist/store/index.js'
import { SkillPluginService } from '../../dist/skills/service.js'

export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexion-skill-author-'))
  const data = join(root, 'data')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const store = new Store(data)
  const project = store.projects.create({ name: 'Test', folderPath: workspace })
  const service = new SkillPluginService(store, data, () => {})
  t.after(() => {
    service.dispose()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, data, workspace, store, project, service }
}
export const input = (projectId = null) => ({
  requestId: 'save',
  id: 'example-helper',
  description: 'Create a report with a deterministic helper.',
  instructions: 'Use scripts/report.mjs to write report.txt in the workspace.',
  projectId,
  resources: [
    {
      path: 'scripts/report.mjs',
      content:
        "import {writeFileSync} from 'node:fs'; if(process.argv[2] !== 'report.txt') process.exit(2); writeFileSync(process.argv[2], 'actual report\\n'); console.log('done')",
    },
    { path: 'references/input.md', content: 'Input contract' },
  ],
})
