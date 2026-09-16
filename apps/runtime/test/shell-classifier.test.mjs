import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyShellCommand,
  resolvePrefixCandidate,
} from '../dist/agent/permissions/index.js'

const posix = (command) => classifyShellCommand(command, 'posix-sh')
const cmd = (command) => classifyShellCommand(command, 'windows-cmd')

test('简单命令 token 化并给出两 token 默认前缀', () => {
  const git = posix('git status --short')
  assert.equal(git.reusable, true)
  assert.deepEqual(git.defaultCandidate, ['git', 'status'])
  const pnpmTest = posix('pnpm test --filter runtime')
  assert.deepEqual(pnpmTest.defaultCandidate, ['pnpm', 'test'])
  const cargo = posix('cargo test --manifest-path crates/Cargo.toml')
  assert.deepEqual(cargo.defaultCandidate, ['cargo', 'test'])
})

test('普通引号与带空格参数可解析为单命令', () => {
  const commit = posix('git commit -m "fix: keep history"')
  assert.equal(commit.reusable, true)
  assert.deepEqual(commit.tokens.slice(0, 2), ['git', 'commit'])
  assert.equal(commit.tokens[3], 'fix: keep history')
})

test('多命令/控制符/重定向/换行/后台一律不可复用', () => {
  for (const command of [
    'git status && rm -rf tmp',
    'git status; echo done',
    'cat a.txt | grep x',
    'echo hi > out.txt',
    'echo hi >> out.txt',
    'git status || true',
    'sleep 10 &',
    'make test\nmake lint',
    'sort < input.txt',
  ]) {
    const result = posix(command)
    assert.equal(result.reusable, false, command)
    assert.equal(result.defaultCandidate, null, command)
    assert.equal(posix(command).tokens.length, 0, command)
  }
})

test('命令替换/反引号/环境变量前缀不可复用', () => {
  for (const command of [
    'echo $(whoami)',
    'echo `date`',
    'FOO=1 pnpm test',
    'LC_ALL=C git status',
  ]) {
    assert.equal(posix(command).reusable, false, command)
  }
})

test('解释器 -c / cmd /C / 包装器与脚本运行器不可复用', () => {
  assert.equal(posix('bash -c "git status"').reusable, false)
  assert.equal(posix('sh -c "git status"').reusable, false)
  assert.equal(posix('eval git status').reusable, false)
  assert.equal(posix('env git status').reusable, false)
  assert.equal(posix('xargs git status').reusable, false)
  assert.equal(cmd('cmd /C git status').reusable, false)
  assert.equal(cmd('cmd /c git status').reusable, false)
  assert.equal(cmd('powershell git status').reusable, false)
})

test('破坏/特权命令只允许一次（即使形态简单）', () => {
  for (const command of [
    'rm -rf build',
    'sudo make install',
    'kill -9 1234',
    'chmod 777 script.sh',
  ]) {
    assert.equal(posix(command).reusable, false, command)
  }
  assert.equal(posix('git push --force').reusable, false)
  assert.equal(posix('git push -f origin main').reusable, false)
  assert.equal(posix('git reset --hard HEAD~1').reusable, false)
  assert.equal(posix('git clean -fdx').reusable, false)
  assert.equal(cmd('del /q build').reusable, false)
  assert.equal(cmd('rd /s /q build').reusable, false)
})

test('正常 git 子命令不被 destructive 表误伤', () => {
  assert.equal(posix('git push origin feature').reusable, true)
  assert.equal(posix('git reset --soft HEAD~1').reusable, true)
  assert.equal(posix('git status').reusable, true)
})

test('prefix 太短 / 无稳定子命令 / flag 开头的第二 token 不可复用', () => {
  assert.equal(posix('ls').reusable, false)
  assert.equal(posix('git -C /tmp status').reusable, false)
  assert.equal(posix('cargo --offline build').reusable, false)
})

test('resolvePrefixCandidate：模型候选必须逐 token 命中实际命令', () => {
  const classification = posix('pnpm test --filter runtime')
  // 合法候选（更长前缀允许）。
  assert.deepEqual(resolvePrefixCandidate(classification, ['pnpm', 'test']), [
    'pnpm',
    'test',
  ])
  assert.deepEqual(
    resolvePrefixCandidate(classification, ['pnpm', 'test', '--filter']),
    ['pnpm', 'test', '--filter'],
  )
  // 与实际 token 不匹配 → 拒绝候选（只允许一次，不创建 session rule）。
  assert.equal(resolvePrefixCandidate(classification, ['pnpm', 'lint']), null)
  // 只给可执行名 → 拒绝。
  assert.equal(resolvePrefixCandidate(classification, ['pnpm']), null)
  // 超出实际 token 长度 → 拒绝。
  assert.equal(
    resolvePrefixCandidate(classification, [
      'pnpm',
      'test',
      '--filter',
      'runtime',
      'extra',
    ]),
    null,
  )
  // 不可复用命令无候选。
  assert.equal(resolvePrefixCandidate(posix('rm -rf x'), ['rm', 'x']), null)
})

test('Windows cmd 保守 tokenizer：展开与控制符拒绝、正常子命令放行', () => {
  assert.equal(cmd('git status --short').reusable, true)
  assert.deepEqual(cmd('git status --short').defaultCandidate, [
    'git',
    'status',
  ])
  assert.equal(cmd('git status & echo done').reusable, false)
  assert.equal(cmd('echo %PATH%').reusable, false)
  assert.equal(cmd('echo !delayed!').reusable, false)
  assert.equal(cmd('findstr x > out.txt').reusable, false)
  assert.equal(cmd('pnpm test "a b"').reusable, true)
  assert.equal(cmd('git commit -m "unbalanced').reusable, false)
})

test('无法闭合的引号/奇异字符一律不可复用', () => {
  assert.equal(posix('git commit -m "oops').reusable, false)
  assert.equal(posix("git commit -m 'oops").reusable, false)
  assert.equal(posix('git\\ status').reusable, false)
  assert.equal(posix('./deploy.sh').reusable, false) // 路径式可执行名
  assert.equal(posix('/usr/bin/git status').reusable, false)
})
