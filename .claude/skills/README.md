# Repo skills

This directory holds the skills an agent working on mosquito-id loads. Each skill is a
directory named in `kebab-case` containing a `SKILL.md`, and each `SKILL.md` opens with YAML
frontmatter:

```markdown
---
name: writing-style
description: ...
---

The instructions.
```

`name` defaults to the directory name; set it only to differ. `description` is the only part
Claude reads before deciding whether to load the skill, so it must say **when to use the
skill**, not just what it is. `allowed-tools` pre-approves tools for the turn and is
optional — most skills do not need it.

Conventions:

- Directory name and `name` field are `kebab-case` and match each other. The directory name
  is what you type as `/name`.
- Supporting files (scripts, references) go in the skill's own directory, next to
  `SKILL.md`.
- Keep it short. A skill nobody reads does not work.
- Skills here are **committed**, so everyone working on the repo gets them.

The upstream spec is https://code.claude.com/docs/en/skills.md — read it rather than
guessing. See `creating-skills` for when a skill is the right thing to write.

## When to add one

Write a skill when you have worked out something reusable: how a library or a tool actually
behaves, an undocumented quirk, a measurement, why an approach cannot work. Anything where
the next agent would otherwise repeat the same search. Ruling an approach out counts —
saying plainly that it does not work is what stops someone else spending a day on it.