// Skills 模块集成冒烟：内置技能清单 + 激活链路 + 存储迁移。
// 覆盖：skill.list 返回内置清单 → message.send 非法 skillId 被拒 →
//       斜杠命令 /code-review 激活并落库 run.skillId → 未知斜杠按普通消息处理 →
//       旧库（v5，无 skill_id 列）打开后自动迁移到 v6。
// 用法：先 pnpm build:packages，再 node scripts/smoke-skills.mjs
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TS_ENTRY = join(ROOT, 'apps/runtime/dist/index.js')

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`)
  } else {
    failures++
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function startRuntime(dataDir) {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', TS_ENTRY],
    {
      env: {
        ...process.env,
        REFLEXION_DATA_DIR: dataDir,
        // 不指向真实二进制：system degraded 不影响 skill 链路。
        REFLEXION_SYSTEM_RUNTIME_BIN: '/nonexistent/reflexion-system-runtime',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const pending = new Map()
  let seq = 0
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[runtime] ${chunk}`)
  })
  return {
    child,
    request(method, params) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`timeout: ${method}`))
        }, 15_000)
        pending.set(id, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
        )
      })
    },
    async shutdown() {
      await this.request('runtime.shutdown', {})
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill()
          resolve()
        }, 3_000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}

async function main() {
  // ---- 场景 1：新库，全链路 ----
  const dataDir = mkdtempSync(join(tmpdir(), 'reflexion-skills-'))
  const runtime = startRuntime(dataDir)
  try {
    const listed = await runtime.request('skill.list', {
      requestId: randomUUID(),
    })
    check(
      'skill.list 成功',
      listed.result !== undefined && Array.isArray(listed.result.skills),
      JSON.stringify(listed.error ?? listed.result).slice(0, 200),
    )
    const skills = listed.result?.skills ?? []
    check(
      '内置技能为 5 个',
      skills.length === 5,
      `got ${skills.length}: ${skills.map((s) => s.id).join(',')}`,
    )
    const byId = new Map(skills.map((skill) => [skill.id, skill]))
    for (const field of [
      'id',
      'name',
      'version',
      'description',
      'tools',
      'argumentHint',
    ]) {
      check(
        `manifest 字段齐全（${field}）`,
        skills.every((skill) => skill[field] !== undefined),
      )
    }
    check(
      'id 全部符合命名约束',
      skills.every((skill) => /^[a-z0-9][a-z0-9-]*$/.test(skill.id)),
    )

    // 非法 skillId：必须在 provider 解析之前被拒（无需配置 provider）。
    const created = await runtime.request('session.create', {
      requestId: randomUUID(),
    })
    const sessionId = created.result?.session?.id
    check('session.create 成功', typeof sessionId === 'string')
    const rejected = await runtime.request('message.send', {
      requestId: randomUUID(),
      sessionId,
      content: '检查非法技能',
      skillId: 'no-such-skill',
    })
    check(
      '非法 skillId 被拒（invalid_request）',
      rejected.error?.data?.code === 'invalid_request',
      JSON.stringify(rejected.error ?? rejected.result).slice(0, 200),
    )

    // 假 provider：run 创建是同步的，后台模型调用失败不影响落库断言。
    const configured = await runtime.request('provider.configure', {
      requestId: randomUUID(),
      name: 'smoke-fake',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: ['fake-model'],
      secret: 'sk-smoke',
    })
    check('provider.configure 成功', configured.result?.profile !== undefined)

    // 场景 A：斜杠激活（独立 session，避免上一条 run 进行中的互斥）。
    const sessionA = (
      await runtime.request('session.create', { requestId: randomUUID() })
    ).result.session.id
    const sentA = await runtime.request('message.send', {
      requestId: randomUUID(),
      sessionId: sessionA,
      content: '/code-review 请审查 src 目录',
    })
    check(
      '斜杠消息发送成功',
      sentA.result?.runId !== undefined,
      JSON.stringify(sentA.error ?? sentA.result).slice(0, 200),
    )
    const detailA = await runtime.request('session.get', {
      requestId: randomUUID(),
      sessionId: sessionA,
    })
    const runA = (detailA.result?.runs ?? []).find(
      (run) => run.id === sentA.result?.runId,
    )
    check(
      'run.skillId 落库为 code-review',
      runA?.skillId === 'code-review',
      JSON.stringify(runA ?? null).slice(0, 200),
    )

    // 场景 B：未知斜杠 = 普通消息（不报错、不激活）。
    const sessionB = (
      await runtime.request('session.create', { requestId: randomUUID() })
    ).result.session.id
    const sentB = await runtime.request('message.send', {
      requestId: randomUUID(),
      sessionId: sessionB,
      content: '/unknown-skill 这只是普通文本',
    })
    check(
      '未知斜杠按普通消息发送',
      sentB.result?.runId !== undefined,
      JSON.stringify(sentB.error ?? sentB.result).slice(0, 200),
    )
    const detailB = await runtime.request('session.get', {
      requestId: randomUUID(),
      sessionId: sessionB,
    })
    const runB = (detailB.result?.runs ?? []).find(
      (run) => run.id === sentB.result?.runId,
    )
    check('未知斜杠不激活技能（skillId=null）', runB?.skillId === null)

    // 显式 skillId + 斜杠并存：显式优先。
    const sessionC = (
      await runtime.request('session.create', { requestId: randomUUID() })
    ).result.session.id
    const sentC = await runtime.request('message.send', {
      requestId: randomUUID(),
      sessionId: sessionC,
      content: '/code-review 显式指定了别的技能',
      skillId: 'web-research',
    })
    const detailC = await runtime.request('session.get', {
      requestId: randomUUID(),
      sessionId: sessionC,
    })
    const runC = (detailC.result?.runs ?? []).find(
      (run) => run.id === sentC.result?.runId,
    )
    check('显式 skillId 优先于斜杠', runC?.skillId === 'web-research')
  } finally {
    await runtime.shutdown()
  }

  // ---- 场景 2：v5 旧库自动迁移 ----
  const legacyDir = mkdtempSync(join(tmpdir(), 'reflexion-skills-v5-'))
  try {
    const db = new DatabaseSync(join(legacyDir, 'reflexion.db'))
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_id TEXT,
        model TEXT,
        started_at TEXT,
        completed_at TEXT,
        error_code TEXT,
        retry_of_run_id TEXT,
        agent_id TEXT,
        parent_run_id TEXT,
        delegation_id TEXT
      );
      PRAGMA user_version = 5;
    `)
    db.close()
    const legacy = startRuntime(legacyDir)
    const listed = await legacy.request('skill.list', {
      requestId: randomUUID(),
    })
    check('旧库（v5）启动后命令正常', listed.result?.skills?.length === 5)
    await legacy.shutdown()
    const after = new DatabaseSync(join(legacyDir, 'reflexion.db'))
    const version = after.prepare('PRAGMA user_version').get().user_version
    const columns = after
      .prepare('PRAGMA table_info(runs)')
      .all()
      .map((column) => column.name)
    after.close()
    check('user_version 推进到 8', Number(version) === 8, `got ${version}`)
    check(
      'runs 表新增 skill_id 列',
      columns.includes('skill_id'),
      columns.join(','),
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(legacyDir, { recursive: true, force: true })
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
