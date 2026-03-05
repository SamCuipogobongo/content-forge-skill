/**
 * ContentForge — Cross-Platform Content Distillation & Self-Learning Engine
 * (Standalone Skill Version)
 *
 * This is a portable, self-contained version of the original
 * claude-daemon/content-forge.js. All hardcoded paths have been replaced
 * with environment-variable-driven defaults so the skill can run from
 * any working directory without depending on the daemon's folder layout.
 *
 * Path resolution order for style rules:
 *   1. Skill's own  ../references/style-rules-{platform}.md  (via __dirname)
 *   2. DATA_DIR/forge-style-rules-{platform}.md               (fallback)
 *
 * Collects viral posts from X, XHS, GZH, distills them, generates original
 * articles via Claude, presents for human editing, then learns from edits.
 * Exports pure functions + prompt builders, called by pipeline runner.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

// ====== 路径常量 (portable — all configurable via env vars) ======

const SKILL_DIR = path.resolve(__dirname, "..");
const REFERENCES_DIR = path.join(SKILL_DIR, "references");

const DATA_DIR = process.env.CONTENT_FORGE_DATA_DIR || path.join(process.cwd(), "content-forge-data");
const FORGE_DATA_DIR = DATA_DIR;
const SOCIAL_DIR = process.env.SOCIAL_MEDIA_DIR || path.join(process.cwd(), "Social Media");

// Style-rules: prefer skill-local references/, fall back to DATA_DIR
function resolveStyleRules(platform) {
  const skillLocal = path.join(REFERENCES_DIR, `style-rules-${platform}.md`);
  if (fs.existsSync(skillLocal)) return skillLocal;
  return path.join(DATA_DIR, `forge-style-rules-${platform}.md`);
}

const STYLE_RULES_X = resolveStyleRules("x");
const STYLE_RULES_XHS = resolveStyleRules("xhs");
const STYLE_RULES_GZH = resolveStyleRules("gzh");
const EDIT_LOG_FILE = path.join(DATA_DIR, "forge-edit-log.jsonl");
const GOOD_ARTICLES_FILE = path.join(DATA_DIR, "forge-good-articles.jsonl");
const PERFORMANCE_FILE = path.join(DATA_DIR, "forge-performance.jsonl");
const TOPIC_LOG_FILE = path.join(DATA_DIR, "forge-topic-log.jsonl");

// ====== .md 解析正则 ======
const ORIGINAL_X_RE = />>>原稿-x>>>\n([\s\S]*?)\n<<<原稿-x<<</;
const EDIT_X_RE = />>>修改-x>>>\n([\s\S]*?)\n<<<修改-x<<</;
const ORIGINAL_XHS_RE = />>>原稿-xhs>>>\n([\s\S]*?)\n<<<原稿-xhs<<</;
const EDIT_XHS_RE = />>>修改-xhs>>>\n([\s\S]*?)\n<<<修改-xhs<<</;
const ORIGINAL_GZH_RE = />>>原稿-gzh>>>\n([\s\S]*?)\n<<<原稿-gzh<<</;
const EDIT_GZH_RE = />>>修改-gzh>>>\n([\s\S]*?)\n<<<修改-gzh<<</;
const SCORE_RE = />>>评分\(1差 2凑合 3还行 4好 5完美\)>>>\n([\s\S]*?)\n<<<评分<<</;
const COMMENT_RE = />>>评语>>>\n([\s\S]*?)\n<<<评语<<</;

// ====== 平台 style rules 映射 ======
const STYLE_RULES_MAP = {
  x: STYLE_RULES_X,
  xhs: STYLE_RULES_XHS,
  gzh: STYLE_RULES_GZH,
};

// ====== 工具函数 ======

function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function yesterday() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n");
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readJsonlTail(filePath, maxLines) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const tail = lines.slice(-maxLines);
  return tail
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function contentHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * 字符级 n-gram Jaccard 相似度
 */
function computeNgramJaccard(a, b, n = 3) {
  if (!a || !b) return 0;
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const sa = norm(a);
  const sb = norm(b);
  if (sa.length < n || sb.length < n) return 0;

  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i <= s.length - n; i++) set.add(s.slice(i, i + n));
    return set;
  };
  const ga = grams(sa);
  const gb = grams(sb);
  let intersection = 0;
  for (const g of ga) if (gb.has(g)) intersection++;
  const union = ga.size + gb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 通用 JSON 数组提取（多策略）
 */
function extractJsonArray(output) {
  if (!output) return null;
  const clean = (s) => s.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, " ");

  // 1. 直接 parse
  try {
    const arr = JSON.parse(clean(output.trim()));
    if (Array.isArray(arr)) return arr;
  } catch {}

  // 2. Markdown 代码块
  const cb = output.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (cb) {
    try {
      const arr = JSON.parse(clean(cb[1].trim()));
      if (Array.isArray(arr)) return arr;
    } catch {}
  }

  // 3. 找第一个 [ 到匹配的 ]（括号计数）
  const fi = output.indexOf("[");
  if (fi === -1) return null;
  let d = 0, ci = -1;
  for (let i = fi; i < output.length; i++) {
    if (output[i] === "[") d++;
    else if (output[i] === "]") { d--; if (d === 0) { ci = i; break; } }
  }
  if (ci > fi) {
    try {
      const arr = JSON.parse(clean(output.slice(fi, ci + 1)));
      if (Array.isArray(arr)) return arr;
    } catch {}
  }

  // 4. 截断修复
  const partial = output.slice(fi);
  const lastEnd = Math.max(
    partial.lastIndexOf("},\n"),
    partial.lastIndexOf("},{"),
    partial.lastIndexOf("},\r"),
    partial.lastIndexOf("}, ")
  );
  if (lastEnd > 0) {
    try {
      const arr = JSON.parse(clean(partial.slice(0, lastEnd + 1) + "]"));
      if (Array.isArray(arr)) return arr;
    } catch {}
  }

  return null;
}

/**
 * 通用 JSON 对象提取（多策略）
 */
function extractJsonObject(output) {
  if (!output) return null;
  const clean = (s) => s.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, " ");

  /**
   * Repair malformed JSON from Claude:
   * - Unescaped newlines inside string values
   * - Unescaped double quotes inside string values (e.g. "是"等的时间"。")
   * Strategy: walk char by char, tracking in-string state, fix as we go.
   */
  const repairJson = (s) => {
    const lines = s.split("\n");
    // Rejoin: for each line, if we're inside a JSON string value, escape the newline
    // Use a state machine approach
    let inString = false;
    let result = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const prev = i > 0 ? s[i - 1] : "";
      if (!inString) {
        if (ch === '"') { inString = true; result += ch; }
        else { result += ch; }
      } else {
        // Inside a string
        if (ch === '"' && prev !== "\\") {
          // Is this the closing quote? Check if what follows looks like JSON structure
          const after = s.slice(i + 1).trimStart();
          if (after[0] === ":" || after[0] === "," || after[0] === "}" || after[0] === "]" || after.length === 0) {
            // This is a real closing quote
            inString = false;
            result += ch;
          } else {
            // Unescaped quote inside string — escape it
            result += '\\"';
          }
        } else if (ch === "\n") {
          result += "\\n";
        } else if (ch === "\r") {
          result += "\\r";
        } else if (ch === "\t") {
          result += "\\t";
        } else {
          result += ch;
        }
      }
    }
    return result;
  };

  const tryParse = (s) => {
    const trimmed = s.trim();
    // Try as-is
    try {
      const obj = JSON.parse(clean(trimmed));
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
    } catch {}
    // Try with repair
    try {
      const obj = JSON.parse(clean(repairJson(trimmed)));
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
    } catch {}
    return null;
  };

  // 1. 直接 parse
  const r1 = tryParse(output);
  if (r1) return r1;

  // 2. Markdown 代码块
  const cb = output.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (cb) {
    const r2 = tryParse(cb[1]);
    if (r2) return r2;
  }

  // 3. 找第一个 { 到匹配的 }（括号计数）
  const fi = output.indexOf("{");
  if (fi === -1) return null;
  let d = 0, ci = -1;
  for (let i = fi; i < output.length; i++) {
    if (output[i] === "{") d++;
    else if (output[i] === "}") { d--; if (d === 0) { ci = i; break; } }
  }
  if (ci > fi) {
    const r3 = tryParse(output.slice(fi, ci + 1));
    if (r3) return r3;
  }

  return null;
}

/**
 * Convert keyword to filesystem-safe slug
 */
function topicSlug(keyword) {
  return keyword
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff-]/g, "")
    .slice(0, 60);
}

// ====== Phase A: Collect ======

/**
 * Collect viral posts from X/Twitter via bird CLI
 */
function collectFromX(keyword, config) {
  const birdBin = config.birdBin || "bird";
  try {
    // Use --json-full to get _raw with views and followers
    const searchCount = config.searchCount || 100;
    const result = spawnSync(birdBin, ["search", keyword, "-n", String(searchCount), "--json-full"], {
      timeout: 60000,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
      console.error("[forge] bird search error:", result.error.message);
      return [];
    }

    const stdout = (result.stdout || "").trim();
    if (!stdout) return [];

    let tweets;
    try {
      tweets = JSON.parse(stdout);
    } catch {
      tweets = extractJsonArray(stdout);
    }
    if (!Array.isArray(tweets)) return [];

    const minFollowers = config.minFollowers != null ? config.minFollowers : 10000;
    const allowedLangs = new Set(config.langs || ["en", "zh", "und"]);
    return tweets
      .filter((t) => {
        const raw = t._raw || {};
        // Skip replies — only original posts
        if (t.id !== t.conversationId) return false;
        // Language filter (en, zh only by default)
        const lang = (raw.legacy && raw.legacy.lang) || "und";
        if (!allowedLangs.has(lang)) return false;
        // Follower filter
        const followers = extractFollowers(raw);
        return followers >= minFollowers;
      })
      .map((t) => {
        const author = t.author || {};
        const raw = t._raw || {};
        const username = typeof author === "string" ? author : (author.username || t.handle || t.username || "");
        const followers = extractFollowers(raw);
        const views = extractViews(raw);
        return {
          source_platform: "x",
          url: t.url || (t.id ? `https://x.com/${username}/status/${t.id}` : ""),
          title: "",
          text: t.text || t.content || "",
          author: username.startsWith("@") ? username : `@${username}`,
          author_followers: followers,
          likes: t.likeCount || t.likes || 0,
          comments: t.replyCount || t.replies || 0,
          shares: t.retweetCount || t.retweets || 0,
          views: views,
          posted_at: t.createdAt || t.posted_at || "",
          keyword_matched: keyword,
          engagement_score: 0,
          content_hash: "",
        };
      });
  } catch (e) {
    console.error("[forge] collectFromX failed:", e.message);
    return [];
  }
}

/** Extract followers from bird _raw: _raw.core.user_results.result.legacy.followers_count */
function extractFollowers(raw) {
  try {
    return raw.core.user_results.result.legacy.followers_count || 0;
  } catch { return 0; }
}

/** Extract views from bird _raw: _raw.views.count (string) */
function extractViews(raw) {
  try {
    return parseInt(raw.views.count, 10) || 0;
  } catch { return 0; }
}

/**
 * Collect viral posts from XHS via Python script
 */
function collectFromXHS(keyword, config) {
  const pythonBin = config.pythonBin || "python3";
  const script = config.xhsSearchScript || path.join(process.cwd(), "xhs-search.py");
  const loginTimeout = config.xhsLoginTimeout || 120;
  try {
    // Spawn with stdio: pipe stderr to see login prompts in real time
    const result = spawnSync(pythonBin, [
      script,
      "--keyword", keyword,
      "--limit", "30",
      "--login-timeout", String(loginTimeout),
    ], {
      // Allow extra time for login wait + detail page fetching (10 posts x ~12s each + buffer)
      timeout: (loginTimeout + 210) * 1000,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    // Forward stderr (login prompts, progress) to console
    if (result.stderr) {
      for (const line of result.stderr.split("\n").filter(Boolean)) {
        console.error(line);
      }
    }

    if (result.error) {
      console.error("[forge] xhs-search error:", result.error.message);
      return [];
    }

    const stdout = (result.stdout || "").trim();
    if (!stdout) return [];

    let posts;
    try {
      posts = JSON.parse(stdout);
    } catch {
      posts = extractJsonArray(stdout);
    }
    if (!Array.isArray(posts)) return [];

    return posts.map((p) => ({
      source_platform: "xhs",
      url: p.url || p.note_url || "",
      title: p.title || "",
      text: p.text || p.content || p.desc || "",
      author: p.author || p.nickname || "",
      author_followers: p.followers || p.author_followers || 0,
      likes: p.likes || p.liked_count || 0,
      favorites: p.favorites || p.collect_count || 0,
      comments: p.comments || p.comment_count || 0,
      shares: p.shares || p.shared_count || 0,
      posted_at: p.posted_at || p.time || "",
      keyword_matched: keyword,
      engagement_score: 0,
      content_hash: "",
    }));
  } catch (e) {
    console.error("[forge] collectFromXHS failed:", e.message);
    return [];
  }
}

/**
 * Collect viral posts from GZH/WeChat via Python script
 */
function collectFromGZH(keyword, config) {
  const pythonBin = config.pythonBin || "python3";
  const script = config.gzhSearchScript || path.join(process.cwd(), "gzh-search.py");
  try {
    const result = spawnSync(pythonBin, [script, "--keyword", keyword, "--limit", "30"], {
      timeout: 120000,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
      console.error("[forge] gzh-search error:", result.error.message);
      return [];
    }

    const stdout = (result.stdout || "").trim();
    if (!stdout) return [];

    let articles;
    try {
      articles = JSON.parse(stdout);
    } catch {
      articles = extractJsonArray(stdout);
    }
    if (!Array.isArray(articles)) return [];

    return articles.map((a) => ({
      source_platform: "gzh",
      url: a.url || a.link || "",
      title: a.title || "",
      text: a.text || a.content || a.digest || "",
      author: a.author || a.account || "",
      author_followers: a.followers || a.author_followers || 0,
      likes: a.likes || a.read_num || 0,
      comments: a.comments || a.comment_count || 0,
      shares: a.shares || 0,
      views: a.views || a.read_num || 0,
      is_top: a.is_top || false,
      posted_at: a.posted_at || a.publish_time || "",
      keyword_matched: keyword,
      engagement_score: 0,
      content_hash: "",
    }));
  } catch (e) {
    console.error("[forge] collectFromGZH failed:", e.message);
    return [];
  }
}

/**
 * Save raw sources to topic directory
 */
function saveSources(keyword, platform, sources) {
  const slug = topicSlug(keyword);
  const topicDir = path.join(FORGE_DATA_DIR, `${today()}-${slug}`);
  ensureDir(topicDir);
  const filePath = path.join(topicDir, `sources-${platform}.jsonl`);
  // Overwrite (not append) to prevent duplicates on re-runs
  fs.writeFileSync(filePath, sources.map((s) => JSON.stringify(s)).join("\n") + "\n");
  console.error(`[forge] saved ${sources.length} ${platform} sources to ${filePath}`);
}

// ====== Phase B: Distill ======

/**
 * Compute platform-specific engagement score
 */
function computeEngagement(source) {
  const log10 = (v) => Math.log10((v || 0) + 1);

  if (source.source_platform === "x") {
    const followers = source.author_followers || 0;
    let followerBonus = 0;
    if (followers > 50000) followerBonus = 10;
    else if (followers > 10000) followerBonus = 5;
    return (
      log10(source.likes) * 30 +
      log10(source.shares) * 25 +
      log10(source.comments) * 20 +
      log10(source.views || 0) * 5 +
      followerBonus
    );
  }

  if (source.source_platform === "xhs") {
    const followers = source.author_followers || 0;
    return (
      log10(source.likes) * 35 +
      log10(source.favorites || 0) * 15 +
      log10(source.comments) * 30 +
      log10(source.shares) * 25 +
      (followers > 50000 ? 10 : 0)
    );
  }

  if (source.source_platform === "gzh") {
    return (
      log10(source.views || 0) * 30 +
      log10(source.likes) * 25 +
      log10(source.comments) * 25 +
      (source.is_top ? 10 : 0)
    );
  }

  return 0;
}

/**
 * Distill sources: dedup, score, rank, return top 30
 */
function distillSources(allSources) {
  if (!allSources || allSources.length === 0) return [];

  // 1. Compute content_hash
  for (const s of allSources) {
    s.content_hash = contentHash(s.text || "");
  }

  // 2. Exact dedup by content_hash (keep first seen)
  const hashSeen = new Set();
  let deduped = [];
  for (const s of allSources) {
    if (hashSeen.has(s.content_hash)) continue;
    hashSeen.add(s.content_hash);
    deduped.push(s);
  }

  // 3. Near-dedup: Jaccard > 0.6, keep higher engagement
  const toRemove = new Set();
  for (let i = 0; i < deduped.length; i++) {
    if (toRemove.has(i)) continue;
    for (let j = i + 1; j < deduped.length; j++) {
      if (toRemove.has(j)) continue;
      const sim = computeNgramJaccard(deduped[i].text, deduped[j].text);
      if (sim > 0.6) {
        const scoreI = computeEngagement(deduped[i]);
        const scoreJ = computeEngagement(deduped[j]);
        toRemove.add(scoreI >= scoreJ ? j : i);
      }
    }
  }
  deduped = deduped.filter((_, idx) => !toRemove.has(idx));

  // 4. Compute engagement_score
  for (const s of deduped) {
    s.engagement_score = Math.round(computeEngagement(s) * 100) / 100;
  }

  // 5. Sort by engagement_score descending
  deduped.sort((a, b) => b.engagement_score - a.engagement_score);

  // 6. Return top 30
  const top = deduped.slice(0, 30);

  console.error(`[forge] distilled ${allSources.length} sources -> ${top.length} (after dedup & rank)`);
  return top;
}

/**
 * Save distilled sources to topic directory
 */
function saveDistilled(keyword, distilled) {
  const slug = topicSlug(keyword);
  const topicDir = path.join(FORGE_DATA_DIR, `${today()}-${slug}`);
  ensureDir(topicDir);
  const filePath = path.join(topicDir, "distilled.jsonl");
  // Overwrite (not append) to prevent duplicates on re-runs
  fs.writeFileSync(filePath, distilled.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

// ====== Phase C: Synthesize ======

/**
 * Load style rules for a platform
 */
function loadStyleRules(platform) {
  // Re-resolve at call time so runtime changes to env vars are picked up
  const skillLocal = path.join(REFERENCES_DIR, `style-rules-${platform}.md`);
  const dataFallback = path.join(DATA_DIR, `forge-style-rules-${platform}.md`);
  const rulesPath = fs.existsSync(skillLocal) ? skillLocal : dataFallback;
  try {
    return fs.readFileSync(rulesPath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Load good article examples for a platform
 */
function loadGoodArticles(platform, limit = 5) {
  const all = readJsonl(GOOD_ARTICLES_FILE);
  const filtered = all.filter((a) => a.platform === platform);
  return filtered.slice(-limit);
}

/**
 * Build the synthesis prompt for Claude
 */
function buildSynthesisPrompt(distilled, keyword, platforms, config) {
  let prompt = `你是一个跨平台内容创作专家。基于以下爆帖素材，为每个目标平台创作原创内容。

## 关键词: ${keyword}
## 目标平台: ${platforms.join(", ")}

`;

  // Per-platform style rules
  for (const p of platforms) {
    const rules = loadStyleRules(p);
    if (rules) {
      prompt += `## ${p.toUpperCase()} 风格规则\n${rules}\n\n`;
    }
  }

  // Good article examples
  for (const p of platforms) {
    const examples = loadGoodArticles(p);
    if (examples.length > 0) {
      prompt += `## ${p.toUpperCase()} 优秀范文 (人工审核通过)\n\n`;
      for (const ex of examples) {
        prompt += `标题: ${ex.title || "N/A"}\n`;
        prompt += `内容: ${(ex.text || "").slice(0, 500)}\n`;
        if (ex.likes) prompt += `表现: ${ex.likes} likes, ${ex.shares || 0} shares\n`;
        prompt += "\n";
      }
    }
  }

  // Distilled sources
  prompt += `## 素材列表 (${distilled.length} 篇, 按互动分排序)\n\n`;
  for (let i = 0; i < distilled.length; i++) {
    const s = distilled[i];
    prompt += `### 素材 ${i} [${s.source_platform}] 互动分: ${s.engagement_score}\n`;
    prompt += `作者: ${s.author} | likes: ${s.likes} | comments: ${s.comments} | shares: ${s.shares}\n`;
    if (s.title) prompt += `标题: ${s.title}\n`;
    prompt += `内容: ${s.text}\n\n`;
  }

  // Platform output specs
  prompt += `## 创作要求\n\n`;

  if (platforms.includes("x")) {
    prompt += `### X/Twitter Thread
- Thread 格式: 1/ ... 2/ ... 3/ ...
- 最多 5 条推文，每条不超过 280 字符
- 第一条必须是最吸引人的 hook
- 最后一条可以是总结或 call-to-action
\n`;
  }

  if (platforms.includes("xhs")) {
    prompt += `### 小红书 Note
- 标题带 emoji，吸引点击
- 正文用 bullet points，带 emoji 小标题
- 结尾带 3-5 个相关 hashtag
- 总字数 300-800 字
\n`;
  }

  if (platforms.includes("gzh")) {
    prompt += `### 公众号长文
- 1500-3000 字
- 有明确的分段和小标题
- 开头用故事或数据 hook
- 结尾有总结和思考
\n`;
  }

  // Anti-AI rules
  prompt += `## 反 AI 味规则
不要使用"值得一提的是"、"总的来说"、"毫无疑问"、"不可否认"、"综上所述"、"众所周知"等AI味用词。
写作要自然、有个人风格、像真人在分享经验。
用口语化表达，避免书面语套话。
\n`;

  // Output format
  prompt += `## 输出格式
Output ONLY a JSON object (no markdown fences):
{`;

  const fields = [];
  if (platforms.includes("x")) fields.push(`"x_thread": "1/ First tweet\\n\\n2/ Second tweet\\n\\n3/ Third tweet"`);
  if (platforms.includes("xhs")) fields.push(`"xhs_note": "Full XHS note text"`);
  if (platforms.includes("gzh")) fields.push(`"gzh_article": "Full article text"`);
  fields.push(`"sources_used": [0, 3, 7]`);
  fields.push(`"angle": "Brief description of the angle taken"`);

  prompt += "\n  " + fields.join(",\n  ") + "\n}";

  return prompt;
}

/**
 * Parse Claude's synthesis output
 */
function parseSynthesisResult(output) {
  return extractJsonObject(output);
}

// ====== Phase D: Generate Review Markdown ======

/**
 * Generate article review .md content
 */
function generateArticleMd(keyword, platforms, synthesis, distilled) {
  const dateStr = today();
  let md = `# ${dateStr} ${keyword} — 内容蒸馏\n`;
  md += `- 关键词: ${keyword} | 平台: ${platforms.join(", ")} | 素材源: ${distilled.length} 篇\n\n`;

  // X section
  if (platforms.includes("x") && synthesis.x_thread) {
    md += `## X Thread Draft\n`;
    md += `>>>原稿-x>>>\n${synthesis.x_thread}\n<<<原稿-x<<<\n`;
    md += `>>>修改-x>>>\n\n<<<修改-x<<<\n`;
    md += `>>>评分(1差 2凑合 3还行 4好 5完美)>>>\n\n<<<评分<<<\n`;
    md += `>>>评语>>>\n\n<<<评语<<<\n\n`;
  }

  // XHS section
  if (platforms.includes("xhs") && synthesis.xhs_note) {
    md += `## 小红书 Note Draft\n`;
    md += `>>>原稿-xhs>>>\n${synthesis.xhs_note}\n<<<原稿-xhs<<<\n`;
    md += `>>>修改-xhs>>>\n\n<<<修改-xhs<<<\n`;
    md += `>>>评分(1差 2凑合 3还行 4好 5完美)>>>\n\n<<<评分<<<\n`;
    md += `>>>评语>>>\n\n<<<评语<<<\n\n`;
  }

  // GZH section
  if (platforms.includes("gzh") && synthesis.gzh_article) {
    md += `## 公众号 Article Draft\n`;
    md += `>>>原稿-gzh>>>\n${synthesis.gzh_article}\n<<<原稿-gzh<<<\n`;
    md += `>>>修改-gzh>>>\n\n<<<修改-gzh<<<\n`;
    md += `>>>评分(1差 2凑合 3还行 4好 5完美)>>>\n\n<<<评分<<<\n`;
    md += `>>>评语>>>\n\n<<<评语<<<\n\n`;
  }

  // Sources section
  md += `---\n## 素材来源\n\n`;
  for (let i = 0; i < distilled.length; i++) {
    const s = distilled[i];
    md += `${i}. [${s.source_platform}] ${s.url} (互动分: ${s.engagement_score})\n`;
  }

  return md;
}

/**
 * Save article .md to appropriate platform directories + combined copy
 */
function saveArticleMd(keyword, platforms, mdContent) {
  const dateStr = today();
  const slug = topicSlug(keyword);
  const savedPaths = [];

  // Save to platform-specific directories
  if (platforms.includes("x")) {
    const xDir = path.join(SOCIAL_DIR, "X", "samcmkt", "threads");
    ensureDir(xDir);
    const xPath = path.join(xDir, `${dateStr} ${keyword}.md`);
    try {
      fs.writeFileSync(xPath, mdContent);
      savedPaths.push(xPath);
    } catch (e) {
      console.error("[forge] failed to save X md:", e.message);
    }
  }

  if (platforms.includes("xhs")) {
    const xhsDir = path.join(SOCIAL_DIR, "小红书");
    ensureDir(xhsDir);
    const xhsPath = path.join(xhsDir, `${dateStr} ${keyword}.md`);
    try {
      fs.writeFileSync(xhsPath, mdContent);
      savedPaths.push(xhsPath);
    } catch (e) {
      console.error("[forge] failed to save XHS md:", e.message);
    }
  }

  if (platforms.includes("gzh")) {
    const gzhDir = path.join(SOCIAL_DIR, "公众号");
    ensureDir(gzhDir);
    const gzhPath = path.join(gzhDir, `${dateStr} ${keyword}.md`);
    try {
      fs.writeFileSync(gzhPath, mdContent);
      savedPaths.push(gzhPath);
    } catch (e) {
      console.error("[forge] failed to save GZH md:", e.message);
    }
  }

  // Save combined copy to topic directory
  const topicDir = path.join(FORGE_DATA_DIR, `${dateStr}-${slug}`);
  ensureDir(topicDir);
  const combinedPath = path.join(topicDir, "article.md");
  try {
    fs.writeFileSync(combinedPath, mdContent);
  } catch (e) {
    console.error("[forge] failed to save combined md:", e.message);
  }

  console.error(`[forge] saved article.md to ${savedPaths.length + 1} locations`);
  return combinedPath;
}

// ====== Phase E: Learn (Self-Learning) ======

/**
 * Parse a single article .md and extract edit pairs per platform
 */
function parseArticleMd(mdContent) {
  const result = { edits: [], scores: [], comments: [] };

  const platformPairs = [
    { platform: "x", originalRe: ORIGINAL_X_RE, editRe: EDIT_X_RE },
    { platform: "xhs", originalRe: ORIGINAL_XHS_RE, editRe: EDIT_XHS_RE },
    { platform: "gzh", originalRe: ORIGINAL_GZH_RE, editRe: EDIT_GZH_RE },
  ];

  for (const { platform, originalRe, editRe } of platformPairs) {
    const origMatch = mdContent.match(originalRe);
    const editMatch = mdContent.match(editRe);

    if (origMatch && editMatch) {
      const original = origMatch[1].trim();
      const edited = editMatch[1].trim();
      if (edited && edited !== original) {
        result.edits.push({ platform, original, edited });
      }
    }
  }

  // Extract scores (there may be multiple score blocks, one per platform)
  const scoreBlocks = mdContent.match(/>>>评分\(1差 2凑合 3还行 4好 5完美\)>>>\n([\s\S]*?)\n<<<评分<<</g);
  if (scoreBlocks) {
    for (const block of scoreBlocks) {
      const m = block.match(/>>>评分\(1差 2凑合 3还行 4好 5完美\)>>>\n([\s\S]*?)\n<<<评分<<</);
      if (m) {
        const parsed = parseInt(m[1].trim());
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 5) {
          result.scores.push(parsed);
        }
      }
    }
  }

  // Extract comments
  const commentBlocks = mdContent.match(/>>>评语>>>\n([\s\S]*?)\n<<<评语<<</g);
  if (commentBlocks) {
    for (const block of commentBlocks) {
      const m = block.match(/>>>评语>>>\n([\s\S]*?)\n<<<评语<<</);
      if (m && m[1].trim()) {
        result.comments.push(m[1].trim());
      }
    }
  }

  return result;
}

/**
 * Review yesterday's article .md files for edits
 */
function reviewYesterdayArticles(config) {
  const result = { editPairs: [], scores: [], keywords: [] };
  const yesterdayStr = yesterday();

  // Scan content-forge-data for yesterday's directories
  try {
    if (!fs.existsSync(FORGE_DATA_DIR)) return result;
    const dirs = fs.readdirSync(FORGE_DATA_DIR).filter((d) => d.startsWith(yesterdayStr));

    for (const dir of dirs) {
      const mdPath = path.join(FORGE_DATA_DIR, dir, "article.md");
      if (!fs.existsSync(mdPath)) continue;

      const mdContent = fs.readFileSync(mdPath, "utf8");
      const parsed = parseArticleMd(mdContent);

      // Extract keyword from directory name: YYYY-MM-DD-{slug}
      const keyword = dir.replace(`${yesterdayStr}-`, "").replace(/-/g, " ");
      result.keywords.push(keyword);

      for (const edit of parsed.edits) {
        const entry = {
          date: yesterdayStr,
          keyword,
          platform: edit.platform,
          original: edit.original,
          edited: edit.edited,
        };
        result.editPairs.push(entry);
        appendJsonl(EDIT_LOG_FILE, entry);
      }

      result.scores.push(...parsed.scores);
    }
  } catch (e) {
    console.error("[forge] reviewYesterdayArticles error:", e.message);
  }

  console.error(`[forge] reviewed yesterday: ${result.editPairs.length} edits, ${result.scores.length} scores`);
  return result;
}

/**
 * Build learn prompt from edit pairs (grouped by platform)
 */
function buildArticleLearnPrompt(editPairs, config) {
  if (!editPairs || editPairs.length === 0) return null;

  // Group by platform
  const byPlatform = {};
  for (const pair of editPairs) {
    if (!byPlatform[pair.platform]) byPlatform[pair.platform] = [];
    byPlatform[pair.platform].push(pair);
  }

  // Load current style rules for context
  let prompt = `以下是人工编辑数据，分平台展示。分析编辑模式，提炼风格规则。\n\n`;

  for (const [platform, pairs] of Object.entries(byPlatform)) {
    const rules = loadStyleRules(platform);
    prompt += `## ${platform.toUpperCase()} 平台 (${pairs.length} 条编辑)\n\n`;
    if (rules) {
      prompt += `当前风格规则:\n${rules}\n\n`;
    }
    prompt += `编辑对:\n`;
    for (const pair of pairs) {
      prompt += `原稿: "${pair.original.slice(0, 500)}"\n`;
      prompt += `修改: "${pair.edited.slice(0, 500)}"\n---\n`;
    }
    prompt += "\n";
  }

  prompt += `分析人工编辑的模式。哪些内容被一致修改？找出写作偏好。

Output ONLY a JSON object (no markdown fences):
{
  "platforms": {
    "x": {"add_rules": ["DO: new rule text"], "remove_rules": ["exact text to remove"], "analysis": "..."},
    "xhs": {"add_rules": [...], "remove_rules": [...], "analysis": "..."},
    "gzh": {"add_rules": [...], "remove_rules": [...], "analysis": "..."}
  }
}
Only include platforms that have edits.`;

  return prompt;
}

/**
 * Apply learn result to per-platform style rules files.
 * Writes to the skill-local references/ directory if it exists,
 * otherwise falls back to DATA_DIR.
 */
function applyArticleLearnResult(output) {
  if (!output) return false;
  const obj = extractJsonObject(output);
  if (!obj || !obj.platforms) return false;

  let applied = false;

  for (const [platform, changes] of Object.entries(obj.platforms)) {
    // Determine write target: prefer skill-local references/
    const skillLocal = path.join(REFERENCES_DIR, `style-rules-${platform}.md`);
    const dataFallback = path.join(DATA_DIR, `forge-style-rules-${platform}.md`);
    const rulesPath = fs.existsSync(skillLocal) ? skillLocal : dataFallback;

    try {
      let rules;
      if (fs.existsSync(rulesPath)) {
        rules = fs.readFileSync(rulesPath, "utf8");
      } else {
        // Create initial style rules file
        rules = `# ${platform.toUpperCase()} Content Style Rules (auto-updated)\n> Last updated: ${today()} | Version: 1\n\n## DO\n\n## DON'T\n`;
      }

      // Remove rules
      if (changes.remove_rules) {
        for (const rule of changes.remove_rules) {
          rules = rules.replace(`- ${rule}\n`, "");
        }
      }

      // Add rules
      if (changes.add_rules) {
        for (const rule of changes.add_rules) {
          if (rule.startsWith("DO:")) {
            rules = rules.replace("## DO\n", `## DO\n- ${rule.replace("DO: ", "")}\n`);
          } else if (rule.startsWith("DON'T:")) {
            rules = rules.replace("## DON'T\n", `## DON'T\n- ${rule.replace("DON'T: ", "")}\n`);
          } else {
            rules = rules.replace("## DO\n", `## DO\n- ${rule}\n`);
          }
        }
      }

      // Update version
      rules = rules.replace(
        /Last updated: \S+ \| Version: \d+/,
        `Last updated: ${today()} | Version: ${parseInt((rules.match(/Version: (\d+)/) || [, "1"])[1]) + 1}`
      );

      fs.writeFileSync(rulesPath, rules);
      applied = true;
      console.error(`[forge] updated style rules for ${platform}`);
    } catch (e) {
      console.error(`[forge] failed to apply learn result for ${platform}:`, e.message);
    }
  }

  return applied;
}

// ====== Phase F: Promote ======

/**
 * Track article performance
 */
function trackArticlePerformance(url, platform, metrics) {
  appendJsonl(PERFORMANCE_FILE, {
    date: today(),
    url,
    platform,
    likes: metrics.likes || 0,
    comments: metrics.comments || 0,
    shares: metrics.shares || 0,
    checkedAt: new Date().toISOString(),
  });
}

/**
 * Promote high-performing articles to good-articles pool
 */
function promoteGoodArticles(config) {
  const perfData = readJsonl(PERFORMANCE_FILE);
  if (perfData.length === 0) return 0;

  const existing = readJsonl(GOOD_ARTICLES_FILE);
  const existingUrls = new Set(existing.map((e) => e.url));
  let promoted = 0;

  const likesThreshold = (config && config.promoteLikesThreshold) || 50;
  const sharesThreshold = (config && config.promoteSharesThreshold) || 20;

  for (const perf of perfData) {
    if (existingUrls.has(perf.url)) continue;
    if ((perf.likes || 0) > likesThreshold || (perf.shares || 0) > sharesThreshold) {
      appendJsonl(GOOD_ARTICLES_FILE, {
        url: perf.url,
        platform: perf.platform,
        title: perf.title || "",
        text: perf.text || "",
        likes: perf.likes,
        shares: perf.shares,
        comments: perf.comments,
        promotedAt: today(),
      });
      existingUrls.add(perf.url);
      promoted++;
    }
  }

  // Cap at 20 per platform (rolling window)
  const all = readJsonl(GOOD_ARTICLES_FILE);
  const byPlatform = {};
  for (const a of all) {
    const p = a.platform || "unknown";
    if (!byPlatform[p]) byPlatform[p] = [];
    byPlatform[p].push(a);
  }

  let needRewrite = false;
  const kept = [];
  for (const [, articles] of Object.entries(byPlatform)) {
    if (articles.length > 20) {
      kept.push(...articles.slice(-20));
      needRewrite = true;
    } else {
      kept.push(...articles);
    }
  }

  if (needRewrite) {
    fs.writeFileSync(GOOD_ARTICLES_FILE, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  console.error(`[forge] promoted ${promoted} articles to good-articles pool`);
  return promoted;
}

// ====== Pipeline Orchestration ======

/**
 * Main pipeline: collect + distill + build prompt
 * Returns prompt and context for caller to run through Claude
 */
function runForgePipeline(keyword, platforms, config) {
  if (!keyword) {
    console.error("[forge] keyword is required");
    return null;
  }
  platforms = platforms || ["x", "xhs", "gzh"];
  config = config || {};

  const slug = topicSlug(keyword);
  const topicDir = path.join(FORGE_DATA_DIR, `${today()}-${slug}`);
  ensureDir(topicDir);

  // Phase A: Collect
  console.error(`[forge] Phase A: collecting for "${keyword}" on [${platforms.join(", ")}]`);
  const allSources = [];

  if (platforms.includes("x")) {
    try {
      // Support multiple search queries to broaden coverage
      const queries = config.xQueries || [keyword];
      const seen = new Set();
      let xSources = [];
      for (const q of queries) {
        const batch = collectFromX(q, config);
        for (const s of batch) {
          if (!seen.has(s.url)) { seen.add(s.url); xSources.push(s); }
        }
      }
      console.error(`[forge] X: ${xSources.length} sources (${queries.length} queries)`);
      if (xSources.length > 0) {
        saveSources(keyword, "x", xSources);
        allSources.push(...xSources);
      }
    } catch (e) {
      console.error("[forge] X collection failed:", e.message);
    }
  }

  if (platforms.includes("xhs")) {
    try {
      const xhsSources = collectFromXHS(keyword, config);
      console.error(`[forge] XHS: ${xhsSources.length} sources`);
      if (xhsSources.length > 0) {
        saveSources(keyword, "xhs", xhsSources);
        allSources.push(...xhsSources);
      }
    } catch (e) {
      console.error("[forge] XHS collection failed:", e.message);
    }
  }

  if (platforms.includes("gzh")) {
    try {
      const gzhSources = collectFromGZH(keyword, config);
      console.error(`[forge] GZH: ${gzhSources.length} sources`);
      if (gzhSources.length > 0) {
        saveSources(keyword, "gzh", gzhSources);
        allSources.push(...gzhSources);
      }
    } catch (e) {
      console.error("[forge] GZH collection failed:", e.message);
    }
  }

  if (allSources.length === 0) {
    console.error("[forge] no sources collected, aborting");
    return null;
  }

  // Phase B: Distill
  console.error(`[forge] Phase B: distilling ${allSources.length} sources`);
  const distilled = distillSources(allSources);
  saveDistilled(keyword, distilled);

  if (distilled.length === 0) {
    console.error("[forge] no sources survived distillation, aborting");
    return null;
  }

  // Phase C: Build synthesis prompt
  console.error("[forge] Phase C: building synthesis prompt");
  const prompt = buildSynthesisPrompt(distilled, keyword, platforms, config);

  return { prompt, distilled, topicDir, keyword, platforms };
}

/**
 * Complete pipeline after Claude returns synthesis output
 */
function completeForgePipeline(keyword, platforms, synthesisOutput, distilled, config) {
  config = config || {};

  // Parse synthesis result
  const synthesis = parseSynthesisResult(synthesisOutput);
  if (!synthesis) {
    console.error("[forge] failed to parse synthesis result");
    return null;
  }

  // Phase D: Generate and save article .md
  console.error("[forge] Phase D: generating article.md");
  const articleMd = generateArticleMd(keyword, platforms, synthesis, distilled);
  const mdPath = saveArticleMd(keyword, platforms, articleMd);

  // Log to topic-log.jsonl
  appendJsonl(TOPIC_LOG_FILE, {
    date: today(),
    keyword,
    platforms,
    sourcesDistilled: distilled.length,
    angle: synthesis.angle || "",
    sourcesUsed: synthesis.sources_used || [],
    mdPath,
  });

  console.error(`[forge] pipeline complete: ${mdPath}`);
  return { mdPath, synthesis, articleMd };
}

// ====== Exports ======
module.exports = {
  // Constants
  DATA_DIR,
  FORGE_DATA_DIR,
  STYLE_RULES_X,
  STYLE_RULES_XHS,
  STYLE_RULES_GZH,
  EDIT_LOG_FILE,
  GOOD_ARTICLES_FILE,
  PERFORMANCE_FILE,
  TOPIC_LOG_FILE,

  // Utilities
  today,
  topicSlug,
  contentHash,
  computeNgramJaccard,
  appendJsonl,
  readJsonl,
  readJsonlTail,
  extractJsonArray,
  extractJsonObject,

  // Phase A: Collect
  collectFromX,
  collectFromXHS,
  collectFromGZH,
  saveSources,

  // Phase B: Distill
  distillSources,

  // Phase C: Synthesize
  loadStyleRules,
  loadGoodArticles,
  buildSynthesisPrompt,
  parseSynthesisResult,

  // Phase D: Review
  generateArticleMd,
  saveArticleMd,

  // Phase E: Learn
  reviewYesterdayArticles,
  buildArticleLearnPrompt,
  applyArticleLearnResult,

  // Phase F: Promote
  promoteGoodArticles,
  trackArticlePerformance,

  // Pipeline
  runForgePipeline,
  completeForgePipeline,
};
