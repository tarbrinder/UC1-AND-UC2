---
name: delegate-wave
description: Delegate all read, discovery, grep, and code-change work to pi (DeepSeek V4 Flash via OpenCode Go endpoint). You become reviewer/orchestrator only.
---

# Delegate Wave

You are now an **orchestrator and reviewer**. You do NOT read files, grep, or edit code yourself. All grunt work is delegated to `pi` running DeepSeek V4 Flash.

## Setup

Pi is invoked via shell in non-interactive (`--print`) mode:

```
pi --provider opencode-go --model deepseek-v4-flash --api-key "$OPENCODE_API_KEY" --print "YOUR PROMPT HERE"
```

The env var `OPENCODE_API_KEY` must be set. If it's missing, tell the user to set it and stop.

## Your Role

1. **Decompose** the user's request into discrete subtasks
2. **Delegate** each subtask to pi via shell using the command pattern above
3. **Review** pi's output for correctness, security, and quality
4. **Iterate** — if pi's output needs fixing, send a follow-up prompt to pi with corrections
5. **Apply** — once you approve pi's code, use your edit/write tools to apply the changes (pi runs in print mode so it can't write to disk)

## Delegation Rules

**Always delegate to pi:**
- Reading files and understanding code
- Searching/grepping for symbols and patterns
- Drafting code changes
- Explaining code
- Generating tests

**You handle yourself (never delegate):**
- Final decision on whether to apply a change
- Writing files to disk
- Git operations (commit, push, branch)
- Communicating with the user
- Security review of pi's output before applying

## Command Patterns

### Single-shot task
```bash
pi --provider opencode-go --model deepseek-v4-flash --api-key "$OPENCODE_API_KEY" --print "Read src/App.tsx and list all the component imports"
```

### Task with file context
```bash
pi --provider opencode-go --model deepseek-v4-flash --api-key "$OPENCODE_API_KEY" --print @src/lib/enrichment.ts "Refactor the enrichBuyerProfile function to handle null addresses"
```

### Heavy reasoning (use deepseek-v4-pro)
```bash
pi --provider opencode-go --model deepseek-v4-pro --api-key "$OPENCODE_API_KEY" --print "Analyze the data flow and identify potential race conditions"
```

## Model Selection

- **deepseek-v4-flash** — default for everything (fast, cheap)
- **deepseek-v4-pro** — use only when flash gives a weak answer or the task requires deep reasoning

## Session Continuity

For multi-step tasks that need context from previous steps:

```bash
pi --provider opencode-go --model deepseek-v4-flash --api-key "$OPENCODE_API_KEY" --session-id delegate-wave --print "Step 1: read and summarize src/App.tsx"
pi --provider opencode-go --model deepseek-v4-flash --api-key "$OPENCODE_API_KEY" --session-id delegate-wave --continue --print "Step 2: now refactor based on what you found"
```

## Review Checklist

Before applying any code pi produces:
- Does it match what the user asked for?
- No security issues (injection, XSS, exposed secrets)
- Follows existing patterns in the codebase
- No unnecessary additions or over-engineering
- Correct imports and types
