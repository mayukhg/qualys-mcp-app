# qualys-mcp-app

Workspace for exploring and building on top of [`qualys-cli-mcp`](https://pypi.org/project/qualys-cli-mcp/), the official Qualys Model Context Protocol (MCP) server.

## What is `qualys-cli-mcp`?

`qualys-cli-mcp` is an MCP server that gives LLMs (Claude, GPT, Llama, etc.) governed, auditable access to the Qualys Cloud Platform — spanning Vulnerability Management (VM), Patch Management (PM), Policy Compliance (PC), Web Application Scanning (WAS), TotalCloud/CSPM, Container Security (CS), CSAM, Cloud Agent (CA), and more.

- **PyPI package:** `qualys-cli-mcp`, currently at version `0.1.2` (Beta), MIT licensed, maintained by Qualys (Andrew Nelson).
- **Install:** `pip install qualys-cli-mcp` (requires Python ≥3.11 on macOS, Linux, or Windows). It automatically pulls in `qualys-cli` as a dependency.
- **Run:** registered as an MCP server via the `qualys-mcp` command, wired into an MCP client (e.g. Claude Desktop) with a simple `{"mcpServers": {"qualys": {"command": "qualys-mcp"}}}` config entry.

### Architecture

The server sits in the middle of a three-layer stack:

```
LLM (Claude / GPT / Llama)
        │  MCP protocol
        ▼
qualys-cli-mcp   ── validates commands, redacts credentials, enforces policy
        │
        ▼
qualys-cli       ── handles auth, retries, and the actual Qualys API calls
        │
        ▼
Qualys Cloud Platform
```

The MCP server itself does not talk to Qualys directly — it wraps the existing `qualys-cli` tool, adding a safety/governance layer in front of it so an LLM can drive the CLI without arbitrary shell access.

### Tools exposed

**Generic tools**
- `qualys_cli(command)` — execute any `qualys-cli` command (escape hatch for anything not covered by a curated tool).
- `qualys_cli_help()` — returns the full command reference so the LLM can discover available commands.

**Curated tools (16 typed wrappers)**, grouped by module:
- Vulnerability Management — scan / host / detection queries, KnowledgeBase (KB) lookups.
- Patch Management — job and patch listing.
- Policy Compliance — posture assessment.
- Web Application Scanning — finding lists.
- TotalCloud / CSPM — connector and CDR (Cloud Detection & Response) data.
- Container Security — image vulnerability scanning.
- Asset Management (CSAM) — risk ranking and inventory.
- Cloud Agent — agent inventory.

### Configuration

Credentials are set up once via `qualys-cli configure` and stored in the OS keyring (Keychain / Secret Service / Credential Manager) — never passed as plaintext to the LLM.

Behavior is tuned through environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `QUALYS_PROFILE` | Which `qualys-cli` profile to use | `default` |
| `QUALYS_CLI_PATH` | Path to the `qualys-cli` binary | auto-detected |
| `QUALYS_MCP_TIMEOUT` | Command timeout (seconds) | `120` |
| `QUALYS_MCP_MAX_RESPONSE` | Response size cap (bytes) | `800000` |
| `QUALYS_MCP_MAX_RETRIES` | Retries on transient failure | `2` |
| `QUALYS_MCP_ALLOWED_MODULES` | Module allowlist | all modules |
| `QUALYS_MCP_DENY_WRITE` | Set to `1` to force read-only mode | off |
| `QUALYS_MCP_AUDIT_LOG` | Path to the append-only audit log | `~/.config/qualys-cli/mcp-audit.jsonl` |

### Security posture

This is clearly designed for enterprise/security-sensitive use rather than a quick demo integration:

- Argv-level validation to prevent command injection through the generic `qualys_cli()` tool.
- Credential redaction in tool output, with secrets held in the OS keyring rather than env vars or config files.
- Module allowlisting (`QUALYS_MCP_ALLOWED_MODULES`) to restrict which Qualys modules an LLM session can touch.
- Read-only enforcement (`QUALYS_MCP_DENY_WRITE`) to block any state-changing calls.
- Response truncation (`QUALYS_MCP_MAX_RESPONSE`) to avoid flooding the LLM context with oversized payloads.
- Append-only, structured (JSONL) audit logging of every command executed.
- Automatic retry with exponential backoff for transient API failures.

### Supported modules

VM, PC (Policy Compliance), PM (Patch), ETM (TruRisk), WAS, TC (TotalCloud), CA (Cloud Agent), CS (Container Security), CSAM, Asset, ScanAuth, User, and Sub — modules use a mix of Basic and JWT auth depending on the underlying Qualys API.

## Possible use cases

- **Conversational vulnerability triage** — ask an LLM "what are my critical, internet-facing vulnerabilities from the last 7 days?" and have it call VM scan/detection/KB tools to assemble the answer instead of hand-building QQL queries.
- **Patch prioritization assistant** — combine Patch Management job/patch data with VM detections so the LLM can recommend which patch jobs close the most severe exposures first.
- **Compliance posture Q&A** — let security/compliance teams ask natural-language questions about Policy Compliance posture (e.g. "which hosts fail CIS benchmark X?") without writing PC queries by hand.
- **WAS findings summarization** — surface and summarize web application scan findings for a dev team, e.g. "list all high-severity findings for app Y opened this sprint."
- **Cloud misconfiguration review (TotalCloud/CSPM)** — query TotalCloud connector and CDR data conversationally to investigate cloud detection & response alerts or misconfigured resources.
- **Container image risk gate** — ask about known vulnerabilities in a specific container image as part of a CI/CD or release-review conversation.
- **Asset inventory & risk ranking lookups (CSAM)** — quickly answer "what are our riskiest assets right now?" by having the LLM pull CSAM risk-ranking data.
- **Cloud Agent fleet health checks** — check agent inventory/coverage gaps ("which hosts are missing a Cloud Agent?") through natural-language prompts.
- **Security copilot inside chat/IDE tools** — embed `qualys-mcp` in Claude Desktop (or any MCP-compatible client) so analysts can query Qualys data directly from their existing chat workflow instead of switching to the Qualys UI.
- **Governed, read-only self-service reporting** — use `QUALYS_MCP_DENY_WRITE=1` plus module allowlisting to give a broader audience (e.g. engineering managers) safe, read-only access to security data via an LLM, with every query captured in the audit log.
- **Building custom MCP-based security tooling** — use `qualys_cli()` / `qualys_cli_help()` as a foundation for prototyping new automations or bots that need programmatic, auditable access to Qualys without writing a full API client.

## Sources

- [qualys-cli-mcp on PyPI](https://pypi.org/project/qualys-cli-mcp/)
