---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria.
---

# Karpathy Guidelines

Behavioral guidelines to reduce common LLM coding mistakes, derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## Goal

Apply four coding discipline rules to avoid common LLM pitfalls: over-engineering, scope creep, unnecessary edits, and unverifiable outcomes.

## When to use this skill

- Writing new code (prevent over-engineering before it starts)
- Reviewing or refactoring existing code
- Any task where scope or complexity is ambiguous
- When asked to "improve", "clean up", or "fix" code

## Instructions

Apply all four guidelines in sequence:

### 1. Think Before Coding — Surface assumptions first

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First — Minimum code that solves the problem

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

> Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes — Touch only what you must

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that **your** changes made unused.
- Don't remove pre-existing dead code unless asked.

> Test: Every changed line must trace directly to the user's request.

### 4. Goal-Driven Execution — Define success criteria, loop until verified

Transform vague tasks into verifiable goals before starting:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a plan upfront:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

## Constraints

- Do not add code "for future use" or "just in case".
- Do not silently resolve ambiguity — surface it.
- Do not clean up pre-existing code unrelated to the task.
- Do not skip defining success criteria for non-trivial tasks.

## Best practices

- The simpler solution is almost always correct.
- Unclear requirements produce overcomplicated code. Clarify first.
- A plan with verifiable steps lets you work autonomously without constant check-ins.
- When in doubt: do less, confirm, then continue.
