// 存储迁移冒烟：构造 v0 schema 数据库（sessions.project_id NOT NULL、projects 无 folder_path），
// 用新 Store 打开，验证 user_version 升级、旧数据保留、新能力可用。
// 用法：先 pnpm build:packages，再 node --disable-warning=ExperimentalWarning scripts/smoke-store-migration.mjs
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../apps/runtime/dist/store/index.js'

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

const projects = store.projects.list()
const projectSessions = store.sessions.list('p-old')

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
  store.sessions.list(null).length === 0,
)
check(
  'all-sessions list contains legacy row',
  store.sessions.list().length === 1,
)

store.projects.create({ name: 'demo', folderPath: '/tmp/demo' })
check(
  'findProjectByFolderPath hits new project',
  store.projects.findByFolderPath('/tmp/demo') !== null,
)
const standalone = store.sessions.create(null)
check('standalone session projectId null', standalone.projectId === null)
store.sessions.rename(standalone.id, '改过的标题')
store.sessions.touch(standalone.id)
const standaloneList = store.sessions.list(null)
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
const profiles = storeV1.providers.list()
check(
  'v1 single model migrated to models array',
  profiles.length === 1 &&
    profiles[0].id === 'pp-old' &&
    profiles[0].models.join(',') === 'old-model',
  JSON.stringify(profiles),
)
const upserted = storeV1.providers.upsert({
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
    storeV1.providers.get('pp-old')?.models.join(',') === 'm1,m2',
)
check('deleteProviderProfile removes row', storeV1.providers.delete('pp-old'))
storeV1.close()

// ---------- v3 → v4：messages parts 一次性回填、runs agent 字段、capabilities ----------
const dirV3 = join(tmpdir(), `reflexion-migration-smoke-v3-${process.pid}`)
rmSync(dirV3, { recursive: true, force: true })
mkdirSync(dirV3, { recursive: true })
const dbV3 = new DatabaseSync(join(dirV3, 'reflexion.db'))
dbV3.exec('PRAGMA user_version = 3')
dbV3.exec(`
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, folder_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
  reasoning TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
  created_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL, provider_id TEXT, model TEXT,
  started_at TEXT, completed_at TEXT, error_code TEXT, retry_of_run_id TEXT
);
CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, models TEXT NOT NULL,
  secret_ref TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO projects (id, name, folder_path, created_at, updated_at)
  VALUES ('p-old', '旧项目', '/tmp/old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO sessions (id, project_id, title, status, created_at, updated_at)
  VALUES ('s-old', 'p-old', '旧会话', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO messages (id, session_id, run_id, role, content, reasoning, status, created_at, completed_at)
  VALUES ('m-old', 's-old', NULL, 'user', '旧消息内容', '', 'completed',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO provider_profiles (id, name, base_url, models, secret_ref, enabled, updated_at)
  VALUES ('pp-old', '旧供应商', 'https://example.com/v1', '["old-model"]', 'local:x', 1,
          '2026-01-01T00:00:00.000Z');
`)
dbV3.close()

const storeV3 = new Store(dirV3)
const migratedMessage = storeV3.messages.listBySession('s-old')[0]
check(
  'v3 content backfilled to single text part',
  migratedMessage.content === '旧消息内容' &&
    JSON.stringify(migratedMessage.parts) ===
      JSON.stringify([{ type: 'text', text: '旧消息内容' }]),
  JSON.stringify(migratedMessage),
)
const v3Run = storeV3.runs.create({
  sessionId: 's-old',
  providerId: null,
  model: null,
  agentId: 'agent-1',
})
check(
  'v4 runs accept agent delegation fields',
  storeV3.runs.get(v3Run.id).agentId === 'agent-1',
)
check(
  'v4 tool_calls table usable after migration',
  storeV3.toolCalls.create({
    runId: v3Run.id,
    messageId: null,
    toolName: 'file.list',
    args: { path: '.' },
  }).toolName === 'file.list',
)
check(
  'v4 provider capabilities default to chat',
  JSON.stringify(storeV3.providers.get('pp-old').capabilities) ===
    JSON.stringify(['chat']),
)
storeV3.close()

rmSync(dir, { recursive: true, force: true })
rmSync(dirV1, { recursive: true, force: true })
rmSync(dirV3, { recursive: true, force: true })

if (failures > 0) {
  console.error(`smoke-store-migration: ${failures} failure(s)`)
  process.exit(1)
}
console.log('smoke-store-migration: all checks passed')
