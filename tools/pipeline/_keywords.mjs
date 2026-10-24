// 关键词表装载器：**本地覆盖层优先，代码里的通用兜底兜底**。
//
// 为什么要这层（2026-10-24）：
//   `prep-health-update.mjs` / `prep-finance-update.mjs` 的关键词表原本是写死在代码里的正则，
//   而 `package.json` 的 `files` 把 `tools/pipeline` 整目录收进发布包 —— 于是「拉稀/鼻血/经期/阴道」
//   「花呗/微粒贷/还钱」这种从个人会话里长出来的词，会跟着包发给每个装它的人。
//   同一条毛病在更早的 `map-specialties.mjs` 上已经踩过一次（44 条专题映射，见该文件顶部），
//   修法也一样：**具体词进 `data/import/`（不入库、不随包），代码里只留不分人的兜底**。
//
// 覆盖层格式：一行一个关键词，`#` 开路的是注释，空行忽略；缺文件不报错（用兜底）。
// 迁移：`node tools/migrate-keyword-lists.mjs`（从迁移前的提交里把旧词表抽出来）。
import { existsSync, readFileSync } from 'node:fs';

/**
 * 读覆盖层里的关键词，拼成一条正则；文件缺失或读坏时返回 `fallback`。
 * @param {string} file - 覆盖层路径（来自 `_paths.mjs`，如 `HEALTH_KEYWORDS`）。
 * @param {RegExp} fallback - 通用兜底（只含"健康/体检/贷款"这类不指向某个人的词）。
 * @returns {RegExp} 用于 `test()` 的正则。
 */
export function loadKeywordRe(file, fallback) {
  const words = loadKeywordList(file);
  return words.length === 0 ? fallback : new RegExp(words.join('|'));
}

/**
 * 读覆盖层里的关键词，返回数组；文件缺失或读坏时返回空数组（调用方自己决定兜底）。
 * @param {string} file - 覆盖层路径。
 * @returns {string[]} 关键词（已去空白、去注释空行）。
 */
export function loadKeywordList(file) {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
  } catch (err) {
    // 试探式读取：词表坏了不该让整轮同步失败，退回兜底并留一行提示。
    console.log(`⚠️ ${file} 读取失败，改用通用兜底：${String(err.message).slice(0, 80)}`);
    return [];
  }
}

/**
 * 读覆盖层里的**字符串集合**（JSON：`{ conversations: [...] }`，也收裸数组）；缺失/读坏 → 空 Set。
 *
 * 用途：`build-health-profile.mjs` 那 9 条「已人工确认属于他人」的会话文件名。
 * 它们不是关键词而是**真实对话标题**，所以哪怕仓是私有的也不许写回代码（2026-10-24 判据）。
 * @param {string} file - 覆盖层路径（`_paths.mjs` 的 `HEALTH_OTHER_CONVERSATIONS`）。
 * @param {string} [key] - JSON 里的数组字段名。
 * @returns {Set<string>} 集合（空 = 只用正则那条路判断归属）。
 */
export function loadStringSet(file, key = 'conversations') {
  if (!existsSync(file)) return new Set();
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : Array.isArray(data?.[key]) ? data[key] : [];
    return new Set(list.map((s) => String(s).trim()).filter((s) => s !== ''));
  } catch (err) {
    console.log(`⚠️ ${file} 读取失败，按空集合处理：${String(err.message).slice(0, 80)}`);
    return new Set();
  }
}
