/**
 * 单元测试：全链编排（段 3）。
 *
 * 锁住两条踩过的归属规则：非零退出不等于失败；"token 过期"必须有标记才作数。
 * 另外锁住 2026-10-24 那条隐私修法：个人语料派生的关键词表**不得**写回随包脚本，
 * 只能从本地覆盖层（`data/import/*-keywords.txt`）读，缺文件走通用兜底。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARKERS, chainVerdict, classifyStage, completedMarker } from '../lib/pipeline.js'
import { loadKeywordList, loadKeywordRe } from '../tools/pipeline/_keywords.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('completedMarker finds a success marker anywhere in the output', () => {
  assert.equal(completedMarker(['=== 完成 ==='], 'x\n=== 完成 ===\ny'), '=== 完成 ===')
  assert.equal(completedMarker(['没有需要更新的内容'], '没有需要更新的内容 ✔'), '没有需要更新的内容')
  assert.equal(completedMarker(['=== 完成 ==='], 'boom'), null)
})

test('classifyStage: exit 0 is ok', () => {
  const v = classifyStage({ exitCode: 0, output: '' })
  assert.deepEqual(v.code, 'ok')
  assert.equal(v.ok, true)
})

test('classifyStage: non-zero exit WITH the stage marker is a teardown crash, not a failure', () => {
  const v = classifyStage({ exitCode: 3221225477, output: '新增（本地没有）5 条\nAssertion failed: src\\win\\async.c', successMarkers: MARKERS.recon })
  assert.equal(v.code, 'finished-with-crash')
  assert.equal(v.ok, true)
})

test('classifyStage: non-zero exit + auth marker is reported as an expired token', () => {
  const v = classifyStage({ exitCode: 1, output: 'AUTH_UNAUTHORIZED fetch_page 鉴权失败', successMarkers: MARKERS.recon })
  assert.equal(v.code, 'token-expired')
  assert.equal(v.ok, false)
  assert.match(v.message, /Token/)
})

test('classifyStage: a plain failure never claims to be a token problem', () => {
  const v = classifyStage({ exitCode: 1, output: 'fetch failed: ECONNRESET', successMarkers: MARKERS.recon })
  assert.equal(v.code, 'failed')
  assert.doesNotMatch(v.message, /Token/)
})

test('classifyStage: a stage that never started is spawn-failed', () => {
  const v = classifyStage({ exitCode: null, output: '' })
  assert.equal(v.code, 'spawn-failed')
})

test('classifyStage: a success marker wins over the auth marker when both appear', () => {
  // A round can mention AUTH_UNAUTHORIZED for one session and still finish.
  const v = classifyStage({ exitCode: 1, output: 'AUTH_UNAUTHORIZED id=7\n=== 完成 ===', successMarkers: MARKERS.update })
  assert.equal(v.code, 'finished-with-crash')
  assert.equal(v.ok, true)
})

test('chainVerdict: all ok is ok', () => {
  const v = chainVerdict([{ stage: 'token', ok: true }, { stage: 'fetch', ok: true }])
  assert.equal(v.ok, true)
  assert.equal(v.failedStage, null)
})

test('chainVerdict: names the first failing stage and carries its message', () => {
  const v = chainVerdict([
    { stage: 'token', ok: true },
    { stage: 'recon', ok: false, code: 'token-expired', message: '未授权' },
    { stage: 'fetch', ok: false, message: '不应到达' },
  ])
  assert.equal(v.ok, false)
  assert.equal(v.failedStage, 'recon')
  assert.match(v.reason, /recon/)
  assert.match(v.reason, /未授权/)
})

// —— 关键词覆盖层（2026-10-24）——
// 动机：这两张表原本写死在 `prep-*-update.mjs` 里，而 `files` 把 `tools/pipeline` 整目录收进发布包。
// 那条泄漏不是"内容被偷"，是"作者在关心什么"被公布（健康 / 财务 / 生殖健康这类私密主题）。
test('loadKeywordRe：覆盖层有词就拼成一条正则；缺文件或空文件退回兜底', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-keywords-unit-'))
  const file = join(dir, 'keywords.txt')
  const fallback = /健康|体检/

  // ① 缺文件：原样返回兜底（同一个对象，调用方可以靠 === 判断）
  assert.equal(loadKeywordRe(file, fallback), fallback)

  // ② 有词：注释行与空行忽略，其余按 | 拼起来
  writeFileSync(file, '# 一行一个关键词\n\n甲词\n乙词\n', 'utf8')
  assert.equal(loadKeywordRe(file, fallback).source, '甲词|乙词')
  assert.deepEqual(loadKeywordList(file), ['甲词', '乙词'])

  // ③ 只有注释：等于空表 → 退回兜底
  writeFileSync(file, '# 什么都没有\n\n', 'utf8')
  assert.equal(loadKeywordRe(file, fallback), fallback)
  assert.deepEqual(loadKeywordList(file), [])

  rmSync(dir, { recursive: true, force: true })
})

test('prep-health-update：只有覆盖层里的词才能选中会话（证明它读的不是代码里的表）', () => {
  // 反例驱动：先用一个**通用兜底绝对不认识**的词造一个会话 → 不该被选中；
  // 再把同一个词写进覆盖层 → 必须被选中。若不读覆盖层，第二步不会变。
  const probe = '冷门词甲'
  const dir = mkdtempSync(join(tmpdir(), 'kb-keywords-e2e-'))
  const importDir = join(dir, 'import')
  mkdirSync(join(importDir, 'knowledge'), { recursive: true })
  mkdirSync(join(importDir, 'health-digest'), { recursive: true })
  writeFileSync(
    join(importDir, 'knowledge', 'conversations.jsonl'),
    `${JSON.stringify({ id: 'c1', title: `关于${probe}的记录`, updated_at: '2026-10-24T10:00:00Z', messages: [{ role: 'user', text: '随口一提' }] })}\n`,
    'utf8',
  )
  writeFileSync(join(importDir, 'knowledge', 'catalog.json'), JSON.stringify([{ idx: 1, date: '2026-10-24', path: 'knowledge/raw/c1.md' }]), 'utf8')
  writeFileSync(join(importDir, 'update-new-items.json'), JSON.stringify({ added: [{ id: 'c1' }] }), 'utf8')

  const run = () =>
    spawnSync(process.execPath, [join(ROOT, 'tools', 'pipeline', 'prep-health-update.mjs')], {
      env: { ...process.env, DSH_IMPORT_DIR: importDir },
      encoding: 'utf8',
    })

  const before = run()
  assert.equal(before.status, 0, `应当正常退出：${before.stderr}`)
  assert.match(before.stdout, /没有健康相关会话/, `没有覆盖层时不该选中：${before.stdout}`)

  writeFileSync(join(importDir, 'health-keywords.txt'), `# 一行一个关键词\n${probe}\n`, 'utf8')
  const after = run()
  assert.equal(after.status, 0, `应当正常退出：${after.stderr}`)
  assert.match(after.stdout, /选中 1 个会话/, `写了覆盖层后应当选中：${after.stdout}`)

  rmSync(dir, { recursive: true, force: true })
})

test('两个 prep 脚本的关键词表都接线到覆盖层（不接线就会被随手改回内联）', () => {
  const health = readFileSync(join(ROOT, 'tools', 'pipeline', 'prep-health-update.mjs'), 'utf8')
  const finance = readFileSync(join(ROOT, 'tools', 'pipeline', 'prep-finance-update.mjs'), 'utf8')
  assert.match(health, /loadKeywordList\(HEALTH_CONTINUED_TITLES\)/, '健康核心会话标题应来自覆盖层')
  assert.match(health, /loadKeywordRe\(HEALTH_KEYWORDS/, '健康关键词应来自覆盖层')
  assert.match(finance, /loadKeywordRe\(FINANCE_KEYWORDS/, '财务关键词应来自覆盖层')
})

