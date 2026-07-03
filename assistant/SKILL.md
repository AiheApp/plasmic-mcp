---
name: plasmic-design-assist
description: Headless Plasmic design assistant over the plasmic MCP MODEL tools with an atomic preview→confirm→apply protocol (plasmic_plan_mutations / plasmic_apply_mutations) — no browser, no canvas, no CDP. First argument is a Plasmic project ID, followed by the design request. Use for adding/changing/removing pages, text, elements, or token-based styles in a studio.aihe.dev project. For interactive in-browser canvas work use plasmic-designer instead.
allowed-tools: mcp__plasmic__plasmic_list_pages mcp__plasmic__plasmic_get_page_model mcp__plasmic__plasmic_get_element mcp__plasmic__plasmic_list_tokens mcp__plasmic__plasmic_plan_mutations mcp__plasmic__plasmic_apply_mutations
metadata:
  version: "1.0.0"
---

# Plasmic Design Assist

Install: copy this directory to `~/.claude/skills/plasmic-design-assist/`
(requires the `plasmic` MCP server from this repo to be registered — see
`assistant/RUNBOOK.md`).

## Arguments

`$ARGUMENTS` = `<projectId> <design request…>`. If the project ID is missing
or ambiguous, ask for it before doing anything.

## Instructions

Read `/Users/salami/Documents/projects/plasmic-mcp/assistant/PROMPT.md` and
follow it exactly, with the parsed `projectId` and request as inputs.

The one skill-specific rule: step 5 of the workflow (preview + confirm) is a
REAL user interaction here — show the plan preview and wait for the user's
explicit "yes" (or equivalent) in the conversation before calling
`plasmic_apply_mutations`. If the user declines or amends, re-plan.
