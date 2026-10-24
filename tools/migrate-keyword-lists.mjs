#!/usr/bin/env node
/**
 * 一次性迁移（2026-10-24）：把 `prep-health-update.mjs` / `prep-finance-update.mjs` 里
 * **硬编码**的关键词正则落成本地覆盖层 `<IMPORT_DIR>/{health,finance}-keywords.txt`。
 *
 * 为什么要搬：与 `tools/migrate-baseline-map.mjs` 同一个理由 —— 这两张表是从个人语料里长出来的
 * （「拉稀/鼻血/经期/阴道/生殖」这类健康词、「花呗/微粒贷/分付/还债」这类财务词），而
 * `files` 白名单把 `tools/pipeline` 整目录收进发布包。哪怕一个会话都没发出去，光那张表
 * 就已经告诉每个装它的人「这个作者在关心什么」。现在代码里只剩通用兜底，具体词在
 * `data/import/`（不入库、不随包）。
 *
 * 用法：
 *   node tools/migrate-keyword-lists.mjs                  # 从 HEAD 版脚本抽词
 *   node tools/migrate-keyword-lists.mjs --ref <commit>   # 指定提交
 *   node tools/migrate-keyword-lists.mjs --dry-run        # 只打印，不落盘
 *   node tools/migrate-keyword-lists.mjs --force          # 覆盖已存在的词表（默认不动）
 *
 * 判据：
 *   · 首次运行打印 `health 61 词 / finance 58 词`（数字以实际为准），两个文件出现在 `data/import/`；
 *   · 再跑一次打印 `已存在，跳过`（默认不覆盖，避免手改过的词表被冲掉）；
 *   · `node tools/preflight.mjs --no-npx` 的「随包内容扫描」仍为 0。
 *
 * 本脚本**不随包发布**（在 `tools/` 根，不在 `files` 白名单里），留着当迁移记录。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 与 migrate-baseline-map.mjs 同一条：只重现 importDir 的优先级，不 import `_paths.mjs`
//（那个模块 import 时会把 cwd 钉到 tools/pipeline/）。
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
const force = argv.includes('--force')
const refIndex = argv.indexOf('--ref')
const explicitRef = refIndex >= 0 ? argv[refIndex + 1] : null
if (refIndex >= 0 && !explicitRef) {
  console.error('用法：node tools/migrate-keyword-lists.mjs [--ref <commit>] [--dry-run] [--force]')
  process.exit(64)
}

const IMPORT = importDir()

/** 三张表：脚本 → (变量名, 词表文件名, 怎么抽)。 */
const TABLES = [
  {
    script: 'tools/pipeline/prep-health-update.mjs',
    variable: 'HEALTHY_TITLE',
    kind: 'regex',
    file: 'health-keywords.txt',
    title: '健康相关会话的标题关键词（本机覆盖层；不入库、不随包）',
  },
  {
    script: 'tools/pipeline/prep-health-update.mjs',
    variable: 'CONTINUED_HEALTH',
    kind: 'array',
    file: 'health-continued-titles.txt',
    title: '被续聊且属于健康核心来源的会话标题（本机覆盖层；不入库、不随包）',
  },
  {
    script: 'tools/pipeline/prep-finance-update.mjs',
    variable: 'FIN_RE',
    kind: 'regex',
    file: 'finance-keywords.txt',
    title: '财务相关会话的标题关键词（本机覆盖层；不入库、不随包）',
  },
  {
    script: 'tools/pipeline/build-health-profile.mjs',
    variable: 'OTHER_CONVERSATIONS',
    kind: 'set',
    file: 'health-other-conversations.json',
    title: '已人工确认属于他人的会话文件名（本机覆盖层；不入库、不随包）',
  },
]

/** 读某个提交里的脚本；读不到（比如还没提交过）返回 null。 */
function readAt(ref, rel) {
  try {
    return execFileSync('git', ['show', `${ref}:${rel}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
}

/** 抽出 `const <VAR> = /…/;` 里的正则源（跨行也认）。 */
function regexSource(text, variable) {
  if (text === null) return null
  const m = text.match(new RegExp(`const\\s+${variable}\\s*=\\s*/([^/\\n]+)/\\s*;`))
  return m === null ? null : m[1]
}

/** 抽出 `const <VAR> = ['…', '…'];` 里的字符串数组。 */
function arraySource(text, variable) {
  if (text === null) return null
  const m = text.match(new RegExp(`const\\s+${variable}\\s*=\\s*\\[([^\\]]*)\\]\\s*;`))
  if (m === null) return null
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).filter((s) => s !== '')
}

/**
 * 抽出 `const <VAR> = new Set(['…', '…']);` 里的字符串数组。
 *
 * 为什么单独认这种形态：这 9 条是**会话文件名**（真实对话标题），不是关键词 ——
 * 它是 `tools/pipeline` 里最该搬走的东西（比任何词表都具体）。上一轮的扫描只匹配正则，漏了它。
 */
function setSource(text, variable) {
  if (text === null) return null
  const m = text.match(new RegExp(`const\\s+${variable}\\s*=\\s*new\\s+Set\\(\\[([\\s\\S]*?)\\]\\)\\s*;`))
  if (m === null) return null
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).filter((s) => s !== '')
}

const ref = explicitRef ?? 'HEAD'
let wrote = 0

for (const t of TABLES) {
  const text = readAt(ref, t.script)
  const words = t.kind === 'regex' ? null : t.kind === 'set' ? setSource(text, t.variable) : arraySource(text, t.variable)
  const source = t.kind === 'regex' ? regexSource(text, t.variable) : null
  if (words === null && source === null) {
    // 已经搬过的表在 HEAD 里就是"不存在"（代码里只剩兜底）：跳过，不算错。
    console.log(`${t.variable}：${ref.slice(0, 9)} 里没有 \`const ${t.variable} = …;\` —— 已搬过，跳过`)
    continue
  }
  const list = words ?? source.split('|').map((s) => s.trim()).filter((s) => s !== '')
  // 词里出现正则元字符会让「一行一词」的读法失真：先在这一步拦住，别等运行期才发现（只对词表适用，会话名不查）。
  if (t.kind !== 'set') {
    const meta = list.filter((w) => /[\\^$.*+?()[\]{}|]/.test(w))
    if (meta.length > 0) {
      console.error(`${t.variable} 里有正则元字符，不能按「一行一词」搬：${meta.join('、')}`)
      process.exit(1)
    }
  }
  // 语义不变的自检：正则拆开再拼回去必须逐字等于原正则。
  if (t.kind === 'regex' && list.join('|') !== source) {
    console.error(`${t.variable} 拆分后拼不回原正则（疑似有不规范空白），停下人工看一眼。`)
    process.exit(1)
  }
  if (list.length === 0) {
    console.error(`${t.variable} 解析出 0 条 —— 格式变了？先人工看一眼旧文件。`)
    process.exit(1)
  }

  const target = join(IMPORT, t.file)
  const unit = t.kind === 'set' ? '条会话' : t.kind === 'array' ? '条标题' : '词'
  const payload = t.kind === 'set'
    ? `${JSON.stringify({ _note: `${t.title}；由 tools/migrate-keyword-lists.mjs 从 ${ref.slice(0, 9)} 抽出`, conversations: list }, null, 2)}\n`
    : [
        `# ${t.title}`,
        `# 一行一个${unit === '条标题' ? '会话标题' : '关键词'}；以 # 开头的行与空行忽略。由 tools/migrate-keyword-lists.mjs 从 ${ref.slice(0, 9)} 抽出。`,
        `# 缺这个文件时脚本用通用兜底（只含"健康/体检/贷款"这类不分人的词），不会报错。`,
        ...list,
        '',
      ].join('\n')

  if (existsSync(target) && !force) {
    console.log(`${t.file} 已存在，跳过（要覆盖加 --force）：${target}`)
    continue
  }
  if (dryRun) {
    console.log(`--dry-run：会把 ${list.length} ${unit}写到 ${target}`)
    continue
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, payload, 'utf8')
  wrote++
  console.log(`${t.variable}：${list.length} ${unit}→ ${target}`)
}

if (wrote === 0 && !dryRun) console.log('没有写入任何文件（都已存在）。')
