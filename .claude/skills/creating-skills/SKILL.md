---
name: creating-skills
description: When and how to add a skill to mosquito-id's .claude/skills directory - the trigger rule for writing one, the frontmatter, and how to keep it short. Use when an agent has worked out something reusable and is deciding between a skill, a code comment, a doc page or a commit message, or when writing or editing a SKILL.md.
---

# Creating a skill

The spec is upstream and authoritative — read it, do not work from memory:
https://code.claude.com/docs/en/skills.md

The gist: a skill is a directory `.claude/skills/<name>/SKILL.md`, where `SKILL.md` is YAML
frontmatter (`name`, `description`) followed by markdown instructions. Claude reads only the
`description` when deciding whether to load it; the directory name is what you type as
`/name`. `allowed-tools` is optional. See `README.md` in this directory for the conventions.

## The trigger rule

Write a skill when you have **worked out something reusable** that another agent here would
otherwise have to rediscover:

- how a library or a tool actually behaves, against what its docs imply
- an undocumented quirk or a silent failure mode
- a measurement — a number with the conditions it was measured under
- why an approach cannot work

**Ruling an approach out counts.** "X does not work, because Y" is a finding, and saying so
plainly is what stops the next reader repeating the search.

Do not write one for: what the code already says, what a code comment can carry at the point
of use, or anything true only inside this conversation.

## Keep it short

A skill nobody reads does not work. If it runs past a screen, most of it is either a general
skill someone will load anyway or detail that belongs in a linked file.

In the `description`, say **when to use it**, not just what it is — that is the only text
Claude sees when choosing. A description listing symptoms is the one that triggers; a
description listing contents is not.

Before adding a second skill on the same subject, edit the existing one. A near-duplicate
means nobody finds either.

## Where

`.claude/skills/<name>/SKILL.md` at the repo root, `kebab-case`, and **committed** — the
point is that the next agent gets it without being told.