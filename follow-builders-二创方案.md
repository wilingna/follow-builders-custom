# Follow Builders 二创方案 —— 英语学习 + 口播文案 + 博客灵感

> 基于 zarazhang 的开源项目 follow-builders 做个人扩展层。
> 原则：**不改动原仓库任何文件**，只在 `~/.follow-builders/prompts/custom/` 下新增文件，
> 这样上游更新（source list、核心脚本）不会覆盖你的定制，未来 `git pull` 也不冲突。

---

## 0. 总体思路

现有架构已经把"抓数据"和"怎么remix"分开了：
- `scripts/prepare-digest.js` 抓取 podcasts / x / blogs，统一吐出一份 JSON（含 transcript 全文）
- `prompts/*.md` 决定 Claude 怎么把 JSON 变成人话
- 你已经在用的语言机制（en / zh / bilingual）证明了这套架构本来就支持"同一份原始内容，多种输出形态"

你要加的四个功能，都是 **同一份原始素材 → 不同的remix prompt → 不同的输出格式**，完全复用现有的抓取层，不用碰 `prepare-digest.js`。

---

## 1. 新增四个触发命令

在 SKILL.md 的 "## Manual Trigger" 段落后追加：

```
## Custom Commands (Personal Extension)

- `/eng` — 从今日素材里提炼英语学习包（句模/单词/词组/语法）
- `/shadow <关键词或序号>` — 把指定一条内容改写成1分钟英语跟读稿 + 生成标准读音音频
- `/script <关键词或序号>` — 结合我在做的项目，写一段3分钟以内的口播文案
- `/blogdraft <关键词或序号>` — 结合我的企业AI落地实践，写一篇博客解读文章

These read from `~/.follow-builders/prompts/custom/*.md`. If a file doesn't exist,
fall back to the closest default prompt and note that customization is missing.
```

---

## 2. 功能一：英语学习包（句模 / 单词 / 词组 / 语法）

**文件**：`~/.follow-builders/prompts/custom/english-patterns.md`

```markdown
# English Learning Extraction Prompt

You are extracting reusable English learning material from today's source content
(tweets + podcast transcripts) for an advanced-beginner learner preparing for
independent international travel and business communication (digital nomad).

## Instructions

Pick 3-5 sentences from today's content that are genuinely useful for spoken/
written fluency — not exotic vocabulary, but high-frequency patterns a fluent
professional actually uses.

For EACH sentence, output:

### 句型 (Sentence Pattern)
- Original sentence (quoted, with source link)
- The reusable pattern, abstracted (e.g. "The thing that surprised me most was X" →
  "令我最惊讶的是X")
- One example of the learner reusing this pattern for her own context (AI/HR/
  enterprise topics), in English

### 词汇 (Vocabulary)
- 2-3 words/phrases from the sentence worth learning
- Simple English definition + Chinese gloss
- One original example sentence using it in a business/tech context

### 语法点 (Grammar Note)
- Only if the sentence contains a grammar structure worth explaining
  (e.g. reduced relative clause, conditional, participle phrase)
- Explain briefly in Chinese, plain terms, no jargon-heavy grammar terminology

## Format
Keep it scannable — headers, short bullets. Total length under 500 words per run.
Do NOT invent example sentences unrelated to the learner's real interests
(AI transformation, HR, organizational design, content creation).
```

**用法建议**：`/eng` 默认对当天digest素材跑一遍；也可以支持 `/eng <这一段/这条推文>` 单独喂一句进去精讲。

---

## 3. 功能二：1分钟跟读文案 + 标准读音

这个功能拆成两半：**文本改写**（Claude能做）+ **标准读音**（需要接TTS，Claude Code要帮你装一个）。

**文件**：`~/.follow-builders/prompts/custom/shadowing-script.md`

```markdown
# Shadowing Script Prompt

Turn ONE source item (a podcast segment or a tweet thread) into a ~1-minute
spoken English script (roughly 130-150 words at natural pace) for shadowing
practice — the learner will listen to a reference audio and mimic the rhythm,
then re-record herself.

## Instructions
- Simple, natural spoken English — contractions, short sentences, no jargon
  the learner wouldn't use herself
- First person, as if the learner is explaining this insight to her own audience
- Include 1-2 of the "reusable patterns" flagged by the english-patterns prompt
  if available, so the shadowing session doubles as retention practice
- End with one line inviting reflection ("Here's what I'm taking from it...")
- Output ONLY the script text — no headers, no meta-commentary — since this
  text will be sent straight to a text-to-speech engine
```

**TTS（标准读音）方案** —— 让Claude Code帮你在这两个里选一个装上：

| 方案 | 效果 | 成本 | 实现难度 |
|---|---|---|---|
| macOS 自带 `say` 命令 | 机械但免费，够用来对节奏 | 免费 | 最低，一行bash命令 |
| OpenAI TTS (`tts-1` / `tts-1-hd`) | 接近真人，语调自然，适合精细跟读 | 约$15/百万字符，单条几乎免费 | 需要OpenAI API key，几行代码 |
| ElevenLabs | 音质最好，可选口音（英/美） | 有免费额度，超出后按量计费 | 需要API key |

给Claude Code的建议实现（以 OpenAI TTS 为例，性价比最高）：

```javascript
// scripts/generate-audio.js
// 读取 shadowing script 文本，调用 OpenAI TTS，输出 mp3
const fs = require('fs');
const script = fs.readFileSync(process.argv[2], 'utf-8');

const res = await fetch('https://api.openai.com/v1/audio/speech', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'tts-1',
    voice: 'alloy',       // 可试 'nova' / 'shimmer'，选自己顺耳的
    input: script,
    speed: 0.9             // 略慢，适合跟读
  })
});
const buffer = Buffer.from(await res.arrayBuffer());
fs.writeFileSync('shadow-output.mp3', buffer);
```

流程：`/shadow <关键词>` → Claude用 shadowing-script.md 生成文本 → 调 generate-audio.js
生成mp3 → 把文本+音频路径一起返回给你，你先听音频找感觉，再对着文本练口播。

---

## 4. 功能三：结合在做项目的启发口播文案（≤3分钟）

**文件**：`~/.follow-builders/prompts/custom/insight-script.md`

```markdown
# Insight Script Prompt (Project-Linked)

You are writing a ≤3-minute spoken video script (roughly 400-450 words) that
connects ONE piece of today's content to the learner's own ongoing work, for
her to record as a voiceover.

## Learner's context (use to find genuine connections, don't force it)
- Leads AI-native organization transformation at a ~300-person enterprise
  (recruiting automation, AI skills rollout, org design)
- Publishes an AI-native organizational maturity model (open source)
- Building independent consulting + content IP practice around AI adoption
  for enterprises, aiming for independence in ~2028

## Instructions
- Open with the specific insight from the source (name the builder, be specific)
- Pivot to a genuine, non-generic connection to her work — a real tension,
  confirmation, or contradiction with something she's currently doing or has
  written about. If there's no real connection, say so and pick a different item.
- Include one concrete, actionable "so what" — what would she try differently
  because of this?
- Conversational spoken register — this is a script to be read aloud, not an essay
- End with an open question to the (future) audience, not a hard conclusion
- Cite the source builder/link at the end for attribution
```

---

## 5. 功能四：企业AI落地实践解读博客文章

**文件**：`~/.follow-builders/prompts/custom/blog-insight.md`

```markdown
# Blog Insight Prompt (Enterprise AI Practice)

You are drafting a blog article (600-900 words) that uses ONE piece of today's
content as a jumping-off point for original analysis on enterprise AI adoption —
written for practitioners (HR/org leaders, AI transformation owners), not
general AI enthusiasts.

## Angle options (pick whichever the source content actually supports)
- AI-native organization design: how roles, incentives, or workflows need to change
- AI talent strategy: hiring, upskilling, or evaluating people in an AI-native org
- Model/agent tuning in practice: what actually makes an AI system "get smarter"
  in a real deployment (prompting, feedback loops, guardrails), not lab benchmarks
- Personal AI transition: how an individual practitioner (not just orgs) should
  be adapting
- Concrete next actions: end with 2-3 things a reader could try this week

## Instructions
- Lead with a strong, specific claim — not "AI is changing everything"
- Use the source content as evidence/counterpoint, not the whole article — this
  is HER analysis, informed by the source, not a summary of it
- Draw on real practitioner experience patterns (structural bottlenecks, politics,
  what breaks when rolling AI out inside an actual org) rather than theory
- Avoid generic AI-thought-leader language ("AI is not just a tool, it's a
  paradigm shift") — be specific and slightly contrarian where honest
- Structure: hook → the source insight → the tension/connection → concrete
  implication → 2-3 action items → one open question
- This is a DRAFT for her own editing, not a final polished piece — flag where
  she should insert a specific example from her own work with [YOUR EXAMPLE HERE]
```

---

## 6. 交给 Claude Code 的执行指令（可直接复制）

```
我在用开源项目 follow-builders（~/.follow-builders 或对应的技能目录）。
我想在不修改原仓库文件的前提下，新增4个个人定制的remix模式。

请：
1. 在 ~/.follow-builders/prompts/custom/ 下创建以下4个文件，内容见附件
   （english-patterns.md / shadowing-script.md / insight-script.md / blog-insight.md）
2. 修改本地 SKILL.md（如果是技能形式安装的），在 Manual Trigger 部分加入
   /eng /shadow /script /blogdraft 四个命令的路由说明
3. 帮我实现 scripts/generate-audio.js，调用 OpenAI TTS 把 shadowing script
   转成 mp3。我会提供 OPENAI_API_KEY，存到 .env
4. 跑一次 /shadow 测试全流程，确认文本+音频都能正常生成

不要改动 scripts/prepare-digest.js、config/default-sources.json 或核心 SKILL.md
的既有流程，只做增量扩展。
```

---

## 备注

- 功能1-4都复用同一份JSON数据源，不会增加抓取频率或触发新的API调用
- 如果你希望"英语学习包"每天自动跟主digest一起推送（而不是手动`/eng`触发），
  可以让Claude Code把它接进 Step 4（Remix content）之后，作为digest的附加section
- TTS建议先用OpenAI `tts-1`试水，音质对练口播够用；如果后续想要更细腻的语调，
  再换ElevenLabs
