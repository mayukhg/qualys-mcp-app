# Agentic AI Use Cases

The Risk Copilot app in this repo is conversational: a human asks, the copilot answers. The next step is agentic — autonomous, multi-step action that doesn't wait on a human to drive each turn. The governance layer already built into [`app/server/server.js`](app/server/server.js) (per-profile module allowlist, `DENY_WRITE` enforcement, append-only audit log) is what makes any of the following safe to actually run unattended — the same "guardrails are the product" argument from [`portfolio/a-protocol-is-not-a-product.md`](portfolio/a-protocol-is-not-a-product.md), just applied to autonomy instead of conversation.

## Autonomous monitoring & reporting

- **Scheduled risk-sweep agent** — runs the full CSAM → VM → PC → WAS → TC → CS → PM → CA chain unattended every Monday and pushes the exec summary to Slack/email, instead of waiting for someone to open the chat.
- **Coverage-gap watchdog** — polls CA + CSAM continuously and fires an alert the moment a critical or internet-facing asset loses agent coverage, rather than answering only when asked.
- **Compliance drift agent** — reruns PC posture checks on a schedule; when a previously-passing control starts failing, it auto-correlates against recent VM/CS changes to suggest a root cause.
- **Audit-log-to-narrative agent** — reads `mcp-audit.jsonl` periodically and writes a plain-English compliance summary ("340 read queries, 2 blocked writes, 0 allowlist violations this week") — turns raw logs into audit-ready evidence without a human combing through JSON.

## Human-in-the-loop remediation

- **Approval-gated write agent — ✅ implemented.** The demo hard-blocks every write via `DENY_WRITE`; this agent *proposes* a specific, evidence-backed write (e.g., "run PM job Q3-log4j-remediation") and only executes after a human clicks Approve in the Workbench. It's a narrow, named exception to `DENY_WRITE`, not a bypass of it — the generic `qualys_cli()` passthrough stays fully blocked, approval still goes through the same module allowlist (a Manager-profile session can't approve anything, since the card never renders), and every propose/approve/execute/reject/denial is its own audit log line. See [`app/server/server.js`](app/server/server.js) (`proposals` map, `/api/remediation/:id/approve|reject`) and [`README.md`](README.md#approval-gated-remediation-agent) for the full writeup. This was picked over the alternatives above because it directly completes the app's own narrative — the evidence already said "a fix exists but hasn't run"; this closes that loop instead of adding another read-only view.
- **Ticket-drafting agent** — on a new critical CVE, cross-references VM detections + CSAM ranking + CA coverage to scope blast radius, then drafts a Jira/ServiceNow ticket with the evidence bundle attached, instead of an analyst assembling it by hand.

## Persona-aware push agents

- **Manager briefing agent** — flips the Manager profile from pull (self-service chat) to push: a weekly scoped briefing generated and sent automatically, still bounded by the same `VM/WAS/CSAM` allowlist.
- **Meta-governance agent** — given a role description, proposes the right `ALLOWED_MODULES`/`DENY_WRITE` config for a new persona — an agent that manages the governance layer itself.

## Cross-tool / multi-agent

- **Detect → ticket → notify → track loop** — chain `qualys-cli-mcp` with other MCP servers (Jira, Slack, PagerDuty) so the whole triage-to-resolution path runs agentically, with Qualys as just one leg.
- **Attacker/defender simulation** — one agent reasons over the same CVE + WAS + coverage-gap data as an attacker would (chaining exploitability), while the Risk Copilot defends/prioritizes — reuses data the app already surfaces, applied to attack-path reasoning.
