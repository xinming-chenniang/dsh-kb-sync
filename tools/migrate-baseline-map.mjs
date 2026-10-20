#!/usr/bin/env node
/**
 * 一次性迁移（2026-10-20）：把旧版 `tools/pipeline/map-specialties.mjs` 里**硬编码**的
 * 基线「专题映射」落成本地覆盖层 `<IMPORT_DIR>/specialties-map.json`。
 *
 * 为什么要搬：那 44 条是从个人语料派生的标签，而 `files` 白名单把 `tools/pipeline`
 * 整目录收进发布包 —— 它们会跟着包发给每个装它的人（发布门禁只查路径，查不到正文）。
 * 现在代码里是空表，数据只在本机 `data/import/`（不入库、不随包）。
 *
 * 用法：
 *   node tools/migrate-baseline-map.mjs                # 自动往回找最近一个「还带 MAP」的提交
 *   node tools/migrate-baseline-map.mjs --ref <commit> # 指定提交（自动查找失败时用）
 *   node tools/migrate-baseline-map.mjs --dry-run      # 只打印将写入的 JSON，不落盘
 *
 * 为什么默认是"往回找"：迁移通常在**拉取修好的代码之后**跑，那时 HEAD 里已经没有 MAP 了；
 * 而又不能假定 HEAD^ 就是删表那次提交（本地可能压了别的提交）。
 *
 * 判据：
 *   · 首次运行应打印 `新增 44 条`，且目标文件里 `entries` 有 44 条；
 *   · 再跑一次应打印 `新增 0 条`（幂等，按 idx 去重）；
 *   · 之后 `node tools/pipeline/map-specialties.mjs` 会打印
 *     `覆盖层生效：新增 N 条来自 headless 的专题建议`（N = 库里尚未并入的 idx 数）。
 *
 * 本脚本**不随包发布**（在 `tools/` 根，不在 `files` 白名单里），可以留着当迁移记录。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 数据目录复用管线自己的解析（pipeline.json / DSH_IMPORT_DIR / 默认 data/import），
// 但**不** import `_paths.mjs` —— 那个模块 import 时会把 cwd 钉到 tools/pipeline/，
// 并且要求 pipeline.json 存在才能解析某些路径。这里只重现 importDir 这一条的优先级。
function importDir() {
  const fromEnv = process.env.DSH_IMPORT_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'tools', 'pipeline', 'pipeline.json'), 'utf8'))
    if (typeof cfg.importDir === 'string' && cfg.importDir.trim() !== '') return resolve(cfg.importDir.trim())
  } catch {
    /* 没有 pipeline.json：走默认 */
  }
  return join(ROOT, 'data', 'import')
}

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const refIndex = argv.indexOf('--ref')
const explicitRef = refIndex >= 0 ? argv[refIndex + 1] : null
if (refIndex >= 0 && !explicitRef) {
  console.error('用法：node tools/migrate-baseline-map.mjs [--ref <commit>] [--dry-run]')
  process.exit(64)
}

const MAP_FILE = join(importDir(), 'specialties-map.json')

/** 读某个提交里的旧文件；读不到返回 null。 */
function readAt(ref) {
  try {
    return execFileSync('git', ['show', `${ref}:tools/pipeline/map-specialties.mjs`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return null
  }
}

const blockOf = (text) => (text === null ? null : text.match(/const MAP = \{\n([\s\S]*?)\n\};/))

/** 显式 --ref 就只认它；否则从 HEAD 往回最多找 30 个提交，取第一个「还有 MAP」的。 */
function locate() {
  if (explicitRef !== null) {
    const text = readAt(explicitRef)
    const block = blockOf(text)
    if (block === null) {
      console.error(`${explicitRef} 里找不到 \`const MAP = { … };\` —— 换个提交试试。`)
      process.exit(1)
    }
    return { ref: explicitRef, block }
  }
  let commits
  try {
    commits = execFileSync('git', ['rev-list', '--max-count=30', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((s) => s !== '')
  } catch (error) {
    console.error(`git rev-list 失败：${String(error.message).split('\n')[0]}`)
    process.exit(1)
  }
  for (const c of commits) {
    const block = blockOf(readAt(c))
    if (block !== null) return { ref: c, block }
  }
  console.error('最近 30 个提交里都没有 `const MAP = { … };` —— 可能已经迁移过了，或历史被压缩过。')
  process.exit(1)
}

const { ref, block } = locate()
const baseline = [...block[1].matchAll(/^\s*(\d+):\s*'([^']+)'/gm)].map((m) => ({
  idx: Number(m[1]),
  specialty: m[2],
}))
if (baseline.length === 0) {
  console.error('解析出 0 条 —— 格式变了？先人工看一眼旧文件。')
  process.exit(1)
}

let existing = { entries: [] }
if (existsSync(MAP_FILE)) {
  try {
    existing = JSON.parse(readFileSync(MAP_FILE, 'utf8'))
  } catch (error) {
    console.error(`${MAP_FILE} 存在但不是合法 JSON，先修它：${String(error.message).slice(0, 120)}`)
    process.exit(1)
  }
}
const current = Array.isArray(existing.entries) ? existing.entries : []
const seen = new Set(current.map((e) => Number(e.idx)))
const added = baseline.filter((e) => !seen.has(e.idx))
const merged = { ...existing, entries: [...current, ...added] }
const payload = `${JSON.stringify(merged, null, 2)}\n`

if (dryRun) {
  console.log(`--dry-run：将写入 ${MAP_FILE}（现有 ${current.length} 条，新增 ${added.length} 条）`)
  process.stdout.write(payload)
  process.exit(0)
}

mkdirSync(dirname(MAP_FILE), { recursive: true })
writeFileSync(MAP_FILE, payload)
console.log(`基线 ${baseline.length} 条（取自 ${ref.slice(0, 9)}）→ ${MAP_FILE}`)
console.log(`新增 ${added.length} 条（现有 ${current.length} → ${merged.entries.length}）`)
if (added.length === 0) console.log('（幂等：这些 idx 已经在覆盖层里了）')
