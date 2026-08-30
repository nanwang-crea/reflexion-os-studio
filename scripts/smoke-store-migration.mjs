// 存储迁移冒烟：构造 v0 schema 数据库（sessions.project_id NOT NULL、projects 无 folder_path），
// 用新 Store 打开，验证 user_version 升级、旧数据保留、新能力可用。
// 用法：先 pnpm build:packages，再 node scripts/smoke-store-migration.mjs
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../apps/runtime/dist/store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(tmpdir(), `reflexion-migration-smoke-${process.pid}`)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const dbPath = join(dir, 'reflexion.db')
const old = new DatabaseSync(dbPath)
old.exec('PRAGMA journal_mode = WAL')
old.exec(`
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO projects (id, name, created_at, updated_at)
  VALUES ('p-old', '旧项目', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO sessions (id, project_id, title, status, created_at, updated_at)
  VALUES ('s-old', 'p-old', '旧会话', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
`)
old.close()

const store = new Store(dir)

const projects = store.listProjects()
const projectSessions = store.listSessions('p-old')

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`)
  } else {
    failures++
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

check(
  'old project preserved with empty folderPath',
  projects.length === 1 &&
    projects[0].id === 'p-old' &&
    projects[0].folderPath === '',
  JSON.stringify(projects),
)
check(
  'old project session preserved',
  projectSessions.length === 1 &&
    projectSessions[0].projectId === 'p-old' &&
    projectSessions[0].title === '旧会话',
  JSON.stringify(projectSessions),
)
check(
  'standalone list empty after migration',
  store.listSessions(null).length === 0,
)
check(
  'all-sessions list contains legacy row',
  store.listSessions().length === 1,
)

store.createProject({ name: 'demo', folderPath: '/tmp/demo' })
check(
  'findProjectByFolderPath hits new project',
  store.findProjectByFolderPath('/tmp/demo') !== null,
)
const standalone = store.createSession(null)
check('standalone session projectId null', standalone.projectId === null)
store.updateSessionTitle(standalone.id, '改过的标题')
store.touchSession(standalone.id)
const standaloneList = store.listSessions(null)
check(
  'standalone title update + recency sort',
  standaloneList[0]?.id === standalone.id &&
    standaloneList[0]?.title === '改过的标题',
  JSON.stringify(standaloneList),
)

store.close()

// ---------- v1 → v2：provider_profiles 单 model 列 → models JSON 数组 ----------
const dirV1 = join(tmpdir(), `reflexion-migration-smoke-v1-${process.pid}`)
rmSync(dirV1, { recursive: true, force: true })
mkdirSync(dirV1, { recursive: true })
const dbV1 = new DatabaseSync(join(dirV1, 'reflexion.db'))
dbV1.exec('PRAGMA user_version = 1')
dbV1.exec(`
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO provider_profiles (id, name, base_url, model, secret_ref, enabled, updated_at)
  VALUES ('pp-old', '旧供应商', 'https://example.com/v1', 'old-model', 'local:x', 1,
          '2026-01-01T00:00:00.000Z');
`)
dbV1.close()

const storeV1 = new Store(dirV1)
const profiles = storeV1.listProviderProfiles()
check(
  'v1 single model migrated to models array',
  profiles.length === 1 &&
    profiles[0].id === 'pp-old' &&
    profiles[0].models.join(',') === 'old-model',
  JSON.stringify(profiles),
)
const upserted = storeV1.upsertProviderProfile({
  id: 'pp-old',
  name: '旧供应商',
  baseUrl: 'https://example.com/v1',
  models: ['m1', 'm2'],
  secretRef: 'local:x',
  enabled: true,
})
check(
  'multi-model upsert persists',
  upserted.models.join(',') === 'm1,m2' &&
    storeV1.getProviderProfile('pp-old')?.models.join(',') === 'm1,m2',
)
check(
  'deleteProviderProfile removes row',
  storeV1.deleteProviderProfile('pp-old'),
)
storeV1.close()

rmSync(dir, { recursive: true, force: true })
rmSync(dirV1, { recursive: true, force: true })

if (failures > 0) {
  console.error(`smoke-store-migration: ${failures} failure(s)`)
  process.exit(1)
}
console.log('smoke-store-migration: all checks passed')
