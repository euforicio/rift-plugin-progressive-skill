# bb-plugin-progressive-skill

Smart skill index compaction for BB. Port of the Hermes `progressive-skill`
plugin's decision core (usage frequency + recency decay + budget-capped
ranking) to BB's plugin model.

BB has no `build_skills_system_prompt` to monkeypatch, so this port exposes
the decision core as two native agent tools instead:

- **`progressive_skill_list`** — returns the skill catalog ranked by usage
  frequency (with recency decay) and capped to a token budget. The agent
  calls this when it needs to decide which skills are worth loading.
- **`progressive_skill_used`** — records that a skill was actually used, so
  frequently-used skills rise in the ranking.

## How it works

The decision logic is ported faithfully from the Hermes `core/` modules:

- **Recency decay** — `score = count × exp(-Δdays / 30)`. A skill used 10
  times a month ago scores lower than one used 3 times yesterday.
- **Promote threshold** — a skill with decayed score ≥ 2.0 is marked `★`
  (promoted) in the list.
- **Budget cap** — the ranked list is trimmed to a character budget
  (default 4600 chars ≈ 1150 tokens), keeping the highest-scored skills.

Usage is stored in the plugin's KV store (`bb.storage.kv`), so it persists
across sessions.

## Tools

### `progressive_skill_list`

```
progressive_skill_list(maxSkills?: number)
```

Returns the skill catalog ranked by usage frequency, capped to the budget.
`★` marks promoted skills (decayed score ≥ threshold). Call this when you
need to decide which skills are worth loading.

### `progressive_skill_used`

```
progressive_skill_used(skill: string)
```

Records that you used a skill, so it ranks higher in future
`progressive_skill_list` calls. Call this after actually loading/using a
skill.

## Settings

| Setting | Default | Description |
|---|---|---|
| `budgetChars` | `4600` | Max characters of the ranked skill list. ≈ 4 chars/token. |
| `promoteScore` | `2.0` | A skill with decayed score ≥ this is ranked as promoted. |

## Attribution

The decision core is ported from the Hermes `progressive-skill` plugin
(`core/` modules), which is MIT-licensed. See `LICENSE`.
