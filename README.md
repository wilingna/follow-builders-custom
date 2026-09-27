**English** | [中文](README.zh-CN.md)

# 🛠️ Follow Builders — Custom Edition

> 二创说明 / Fork notice
> 本仓库基于开源项目 [zarazhangrui/follow-builders](https://github.com/zarazhangrui/follow-builders) 二次开发，
> 在原版"抓取 → 摘要 → 推送"的每日 AI builders digest 之上，新增了 **5 个个人定制 remix 命令**
> （英语学习包 / 跟读文案+配音 / 项目关联口播稿 / 企业AI落地博客初稿 / 人物速查）
> 和 **一条独立的口播视频自动生产流水线**（配音 → AI 配图/分镜视频 → 双语字幕烧录成片）。
> 原始抓取层（`scripts/prepare-digest.js`、`config/default-sources.json`、核心 `SKILL.md` 流程）**未做任何修改**，
> 上游更新可以直接合并，不会和本仓库的定制冲突。

This repo forks [zarazhangrui/follow-builders](https://github.com/zarazhangrui/follow-builders) (an AI builders digest skill for Claude Code / OpenClaw) and adds a personal remix layer on top: **5 custom slash commands** (English-learning extraction, shadowing script + reference audio, project-linked spoken scripts, enterprise-AI blog drafts, and an on-demand person lookup) plus **a standalone video production pipeline** (TTS narration → AI-generated scene images or text-to-video clips → burned bilingual subtitles → final cut). The upstream fetch layer is untouched, so this stays mergeable with upstream.

---

## 🎯 TL;DR

**EN** — Upstream `follow-builders` gives you a daily digest of what real AI builders are saying. This fork reuses the *exact same* fetched JSON and adds a second remix layer that turns any digest item into: an English study pack, a 1-minute shadowing script with generated audio, a 3-minute spoken video script tied to your own work, or a blog draft. A separate `scripts/` pipeline can then turn a script into an actual short-form video (voiceover + AI scenes + burned captions), no video editor required.

**中文** — 原版 `follow-builders` 每天给你一份"AI builders 在说什么"的摘要。这个二创版本复用**同一份**抓取到的 JSON 数据，加了第二层 remix：把当天任意一条素材，一键变成英语学习包、1分钟跟读稿+配音、和自己项目相关的3分钟口播稿、或企业AI落地博客初稿。另外有一条独立的 `scripts/` 流水线，可以把口播稿直接做成短视频成片（配音 + AI 生成分镜 + 烧录双语字幕），不需要任何视频剪辑软件。

---

## ✨ What's New in This Fork / 新增功能

| Command | 作用 | 依赖 |
|---|---|---|
| `/eng` | 从当天素材提炼英语学习包（句型 / 词汇 / 语法点） | 无（纯文本） |
| `/shadow <关键词或序号>` | 把一条素材改写成 ~1 分钟跟读稿，并生成参考读音 mp3 | `OPENROUTER_API_KEY`（TTS） |
| `/script <关键词或序号>` | 把一条素材写成 ≤3 分钟、结合你自己项目的口播文案 | 无（纯文本） |
| `/blogdraft <关键词或序号>` | 结合企业 AI 落地实践视角，写一篇 600–900 字博客初稿 | 无（纯文本） |
| `/lookup <人名>` | 独立于每日 digest，实时搜索某人最近的公开访谈/发言并写成口播稿或博客 | 无（联网搜索） |

以上命令都复用同一份 `prepare-digest.js` 产出的 JSON，**不增加抓取频率、不新增定时任务**。命令路由逻辑见 [SKILL.md](SKILL.md) 的 "Custom Commands (Personal Extension)" 段落。

**视频生产流水线（进阶，手动调用，尚未接入 slash command）：**

```
脚本文本 (来自 /shadow 或 /script)
   │
   ├─▶ scripts/generate-audio.js        →  配音 mp3（OpenRouter TTS, Deepgram Aura-2）
   ├─▶ scripts/generate-images.js       →  逐分镜 AI 插画（OpenRouter Image API）
   │        或
   │   scripts/generate-video-clips.js  →  逐分镜 AI 文生视频（OpenRouter, Kling v3.0）
   ├─▶ scripts/srt-to-ass.js            →  字幕格式转换（烧录定位更可靠）
   └─▶ scripts/compose-video.js         →  用 ffmpeg 合成最终成片
            → <name>-9x16.mp4 / -16x9.mp4（含音频+字幕）
            → <name>-9x16-silent.mp4 / -16x9-silent.mp4（静音版，供二次配音）
```

## 🧰 Prerequisites / 前置条件

- Node.js 18+（`scripts/` 使用原生 `fetch`）
- 已安装并可用的 `ffmpeg`（仅 `compose-video.js` 需要，用于剪辑合成与字幕烧录）
- 一个 [OpenRouter](https://openrouter.ai/) API key，写入项目根目录 `.env`：
  ```
  OPENROUTER_API_KEY=sk-or-...
  ```
  仅 `/shadow` 的配音、以及视频流水线的配图/文生视频步骤需要它；`/eng`、`/script`、`/blogdraft`、`/lookup` 都是纯文本，不需要任何 API key。
- 原版 `follow-builders` 的运行环境（Claude Code 或 OpenClaw + 已装好的 `scripts/` 依赖，见下方 Installation）

## 🚀 Usage

在装好本 skill 的 Claude Code / OpenClaw 会话里直接输入命令即可，例如：

```
/eng
/shadow karpathy
/script 2
/blogdraft agent 落地
/lookup Andrej Karpathy
```

手动跑视频流水线（以 `/shadow` 产出的脚本为例）：

```bash
cd scripts
node generate-audio.js ../output/shadow-script.txt
node generate-images.js ../output/segments.json ../output/images
node compose-video.js \
  --segments ../output/video-segments.json \
  --clips ../output/clips \
  --audio ../output/shadow-script.mp3 \
  --srt ../output/shadow-script.srt \
  --out-prefix ../output/shadow-demo-v1
```

## 📦 Everything from Upstream / 原版功能

每日 digest 的抓取、摘要、推送、多语言、默认信源列表等核心功能与原版一致，完整说明见 [zarazhangrui/follow-builders 的 README](https://github.com/zarazhangrui/follow-builders#readme)，本仓库不重复列出。安装方式同样是把仓库 clone 到你的 Claude Code / OpenClaw skills 目录后 `cd scripts && npm install`。

## 🔒 Privacy

- 与原版一致：每日 digest 抓取不需要任何 API key，内容集中抓取
- 本仓库新增的 `/shadow` 配音、视频流水线的配图/文生视频，会把脚本文本发送给 OpenRouter（因为需要调用其 TTS / 图像 / 视频生成 API）；`OPENROUTER_API_KEY` 只保存在本地 `.env`，不会被提交到仓库（见 `.gitignore`）
- `/lookup` 会执行实时联网搜索，仅在你显式输入该命令时触发

## 🙏 Credits & License

- 原始项目 / Original project: [zarazhangrui/follow-builders](https://github.com/zarazhangrui/follow-builders) by Zara Zhang（[@zarazhangrui](https://x.com/zarazhangrui)）— MIT License，版权声明见 [LICENSE](LICENSE)
- 本仓库延续同一份 MIT 协议；README 中「What's New in This Fork」列出的自定义命令与视频生产脚本为本仓库新增的二创部分

---

<a id="中文"></a>
## 中文说明

见上文各节的中文部分；本仓库以中文为主要维护语言，欢迎按需修改 `prompts/custom/*.md` 定制你自己的 remix 风格。原版的完整中文说明保留在 [README.zh-CN.md](README.zh-CN.md)。
