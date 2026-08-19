// bb-plugin-progressive-skill — smart skill index compaction for BB.
//
// Port of the Hermes `progressive-skill` plugin's decision core (usage
// frequency + recency decay + budget-capped ranking) to BB's plugin model.
//
// BB has no `build_skills_system_prompt` to monkeypatch, so the port exposes
// the decision core as two native agent tools instead:
//
//   - `progressive_skill_list` — returns the skill catalog ranked by usage
//     frequency (with recency decay) and capped to a token budget. The agent
//     calls this when it needs to know which skills are worth loading.
//   - `progressive_skill_used` — records that a skill was actually used, so
//     frequently-used skills rise in the ranking.
//
// The decision logic (decay scoring, promote threshold, budget cap) is ported
// faithfully from the Hermes core/ modules.
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ─── Config (mirrors core/config.py) ──────────────────────────────────

const DECAY_DAYS = 30.0; // score = count × exp(-Δdays / 30)
const PROMOTE_SCORE = 2.0; // a skill is "promoted" when its decayed score ≥ this
const LIST_BUDGET_CHARS = 4600; // ≈ 1150 tokens

// ─── Usage store (mirrors core/scorer.py) ──────────────────────────────

interface UsageEntry {
  count: number;
  last_used: number; // epoch seconds
}

class UsageTracker {
  private usage = new Map<string, UsageEntry>();
  private dirty = false;

  constructor(private kv: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> }) {}

  async load(): Promise<void> {
    try {
      const raw = await this.kv.get<Record<string, unknown>>("usage");
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) {
          if (v && typeof v === "object") {
            const e = v as Record<string, unknown>;
            this.usage.set(k, {
              count: Number(e.count) || 0,
              last_used: Number(e.last_used) || 0,
            });
          }
        }
      }
    } catch {
      // start empty
    }
  }

  record(skillName: string): void {
    if (!skillName) return;
    const now = Date.now() / 1000;
    const entry = this.usage.get(skillName);
    if (entry) {
      entry.count += 1;
      entry.last_used = now;
    } else {
      this.usage.set(skillName, { count: 1, last_used: now });
    }
    this.dirty = true;
  }

  decayedScore(count: number, lastUsed: number): number {
    const days = Math.max(0, (Date.now() / 1000 - lastUsed) / 86400);
    return count * Math.exp(-days / DECAY_DAYS);
  }

  snapshot(): Map<string, UsageEntry> {
    return new Map(this.usage);
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of this.usage) obj[k] = v;
    await this.kv.set("usage", obj);
    this.dirty = false;
  }
}

// ─── Plugin entry ──────────────────────────────────────────────────────

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("bb-plugin-progressive-skill loaded");

  const settings = bb.settings.define({
    budgetChars: {
      type: "string" as const,
      label: "Skill list budget (chars)",
      default: String(LIST_BUDGET_CHARS),
      description: "Max characters of the ranked skill list. ≈ 4 chars/token.",
    },
    promoteScore: {
      type: "string" as const,
      label: "Promote threshold (decayed score)",
      default: String(PROMOTE_SCORE),
      description: "A skill with decayed score ≥ this is ranked as 'promoted'.",
    },
  });

  const { budgetChars, promoteScore } = await settings.get();
  const budget = Number(budgetChars) || LIST_BUDGET_CHARS;
  const promote = Number(promoteScore) || PROMOTE_SCORE;
  const tracker = new UsageTracker(bb.storage.kv);
  await tracker.load();

  // Resolve the environment for a thread so we can list its skills.
  async function resolveEnvironment(threadId: string, projectId: string) {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId) {
        return { projectId, environmentId: thread.environmentId };
      }
    } catch {
      // fall through
    }
    return { projectId, environmentId: null };
  }

  // ── Tool: progressive_skill_list ─────────────────────────────────────
  // Returns the skill catalog ranked by usage frequency (recency-decayed),
  // capped to the budget. The agent calls this to decide which skills to load.

  bb.agents.registerTool({
    name: "progressive_skill_list",
    description:
      "List available skills ranked by usage frequency (recency-decayed), capped to a token budget. " +
      "Call this when you need to decide which skills are worth loading — frequently-used skills rank first, " +
      "rarely-used ones are trimmed to fit the budget. Returns the ranked list plus a 'promoted' marker " +
      "on skills above the usage threshold.",
    parameters: z.object({
      maxSkills: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Optional cap on the number of skills returned (default: all that fit the budget)."),
    }),
    async execute({ maxSkills }, ctx) {
      const env = await resolveEnvironment(ctx.threadId, ctx.projectId);
      const skills = await bb.sdk.skills.list(env);
      const usage = tracker.snapshot();

      // Rank: decayed score desc, then name asc for ties.
      const ranked = skills.skills
        .map((s) => {
          const name = s.name ?? s.id ?? "";
          const entry = usage.get(name);
          const score = entry ? tracker.decayedScore(entry.count, entry.last_used) : 0;
          return { name, score, promoted: score >= promote };
        })
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

      // Budget cap: keep highest-scored until budget exhausted.
      const kept: typeof ranked = [];
      let used = 0;
      for (const r of ranked) {
        const cost = r.name.length + 1;
        if (used + cost > budget) break;
        kept.push(r);
        used += cost;
        if (maxSkills && kept.length >= maxSkills) break;
      }

      const lines = kept.map((r) => `${r.promoted ? "★ " : "  "}${r.name}`);
      const summary = `progressive-skill: ${kept.length}/${ranked.length} skills within ${budget} chars. ` +
        `★ = promoted (decayed score ≥ ${promote}). Call progressive_skill_used after loading a skill.`;
      return summary + "\n" + lines.join("\n");
    },
  });

  // ── Tool: progressive_skill_used ────────────────────────────────────
  // Records that a skill was used, so it rises in the ranking.

  bb.agents.registerTool({
    name: "progressive_skill_used",
    description:
      "Record that you used a skill, so it ranks higher in future progressive_skill_list calls. " +
      "Call this after actually loading/using a skill.",
    parameters: z.object({
      skill: z.string().min(1).describe("The skill name you used."),
    }),
    async execute({ skill }) {
      tracker.record(skill);
      await tracker.save();
      return `Recorded usage of '${skill}'. It will rank higher next time.`;
    },
  });

  // ── Cleanup ─────────────────────────────────────────────────────────

  bb.onDispose(async () => {
    await tracker.save();
    bb.log.info("bb-plugin-progressive-skill disposed");
  });
}
