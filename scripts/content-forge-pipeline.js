#!/usr/bin/env node
"use strict";

// Allow spawning Claude from within a Claude Code session
delete process.env.CLAUDECODE;

const path = require("path");
const { spawnSync } = require("child_process");

// Parse CLI args manually (no external deps)
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}
function hasFlag(name) { return args.includes(name); }

const forge = require("./content-forge");

const CONFIG = {
  pythonBin: process.env.PYTHON_BIN || "python3",
  birdBin: process.env.BIRD_BIN || "bird",
  claudeBin: process.env.CLAUDE_BIN || "claude",
  minFollowers: parseInt(process.env.MIN_FOLLOWERS || "1000", 10),
  minEngagement: parseInt(process.env.MIN_ENGAGEMENT || "10", 10),
};

async function main() {
  if (hasFlag("--help") || hasFlag("-h") || args.length === 0) {
    console.log(`ContentForge — Cross-platform content distillation engine

Usage:
  node content-forge-pipeline.js --keyword "AI agents" [--platforms x,xhs,gzh]
  node content-forge-pipeline.js --learn [--platform xhs]
  node content-forge-pipeline.js --status

Options:
  --keyword <kw>      Topic keyword to research
  --platforms <list>   Comma-separated: x, xhs, gzh (default: x,xhs,gzh)
  --learn              Run learning from yesterday's edits
  --platform <p>       Specific platform for --learn
  --status             Show recent topic history
  --help               Show this help`);
    process.exit(0);
  }

  if (hasFlag("--status")) {
    return runStatus();
  }

  if (hasFlag("--learn")) {
    return runLearn();
  }

  const keyword = getArg("--keyword");
  if (!keyword) {
    console.error("Error: --keyword is required");
    process.exit(1);
  }

  const platformsStr = getArg("--platforms") || "x,xhs,gzh";
  const platforms = platformsStr.split(",").map(p => p.trim()).filter(Boolean);

  return runForge(keyword, platforms);
}

async function runForge(keyword, platforms) {
  console.log(`[forge-cli] Starting: "${keyword}" platforms=[${platforms}]`);

  // Phase A+B: Collect and distill
  const result = forge.runForgePipeline(keyword, platforms, CONFIG);
  console.log(`[forge-cli] Collected ${result.distilled.length} sources after distillation`);

  if (result.distilled.length === 0) {
    console.log("[forge-cli] No sources found. Exiting.");
    return;
  }

  // Phase C: Run Claude to synthesize
  console.log("[forge-cli] Running Claude synthesis...");
  const claudeOutput = runClaude(result.prompt);
  if (!claudeOutput) {
    console.error("[forge-cli] Claude synthesis failed");
    process.exit(1);
  }

  // Phase D: Complete pipeline (generate .md)
  const completion = forge.completeForgePipeline(
    keyword, platforms, claudeOutput, result.distilled, CONFIG
  );
  console.log(`[forge-cli] Article saved to: ${completion.mdPath}`);
  console.log("[forge-cli] Done! Edit the .md file and run --learn tomorrow.");
}

function runClaude(prompt) {
  // Use PROJECT_ROOT env var if set, otherwise fall back to cwd
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const child = spawnSync(CONFIG.claudeBin, [
    "--print",
    "--dangerously-skip-permissions",
    "--max-turns", "5",
    prompt,
  ], {
    cwd: projectRoot,
    env: { ...process.env, HOME: process.env.HOME || "/Users/samcui233" },
    timeout: 300000, // 5 min
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });
  if (child.error) {
    console.error("[forge-cli] Claude error:", child.error.message);
    return null;
  }
  if (child.stderr) {
    console.error("[forge-cli] Claude stderr:", child.stderr.slice(0, 500));
  }
  return child.stdout || null;
}

function runLearn() {
  console.log("[forge-cli] Running learning from yesterday's edits...");
  const review = forge.reviewYesterdayArticles(CONFIG);
  console.log(`[forge-cli] Found ${review.editPairs.length} edits, ${review.scores.length} scores`);

  if (review.editPairs.length === 0) {
    console.log("[forge-cli] No edits found. Nothing to learn.");
    return;
  }

  const prompt = forge.buildArticleLearnPrompt(review.editPairs, CONFIG);
  if (!prompt) {
    console.log("[forge-cli] No learn prompt generated.");
    return;
  }

  console.log("[forge-cli] Running Claude learning...");
  const output = runClaude(prompt);
  if (output) {
    const applied = forge.applyArticleLearnResult(output);
    console.log(`[forge-cli] Learn result applied: ${applied}`);
  }

  // Also promote good articles
  const promoted = forge.promoteGoodArticles(CONFIG);
  console.log(`[forge-cli] Promoted ${promoted} articles`);
}

function runStatus() {
  const logs = forge.readJsonlTail(forge.TOPIC_LOG_FILE, 20);
  if (logs.length === 0) {
    console.log("No forge runs yet.");
    return;
  }
  console.log("Recent ContentForge runs:");
  console.log("\u2500".repeat(60));
  for (const entry of logs.reverse()) {
    console.log(`  ${entry.date} | ${entry.keyword} | platforms: ${(entry.platforms || []).join(",")} | sources: ${entry.sourcesDistilled || 0}`);
  }
}

main().catch(err => {
  console.error("[forge-cli] Fatal:", err.message);
  process.exit(1);
});
