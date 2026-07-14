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

## Featured use case: Unified Cross-Domain Risk Prioritization Copilot

This use case is designed to exercise **every module the MCP server exposes** in a single, coherent workflow, rather than treating each tool as an isolated query.

### 1. Business problem

A mid-size enterprise's security team runs Qualys VM, WAS, PC, TotalCloud, Container Security, and Cloud Agent — but each module is queried separately, through separate UI screens or QQL, by different people. The result:

- No single, ranked view of "what should we fix first" across on-prem hosts, cloud resources, containers, and web apps.
- Analysts spend hours each week manually cross-referencing an asset's vulnerabilities (VM), its compliance posture (PC), whether it's internet-facing (WAS), whether it's cloud-hosted and misconfigured (TotalCloud/CDR), whether it runs vulnerable container images (CS), and whether it even has monitoring coverage (Cloud Agent) — before they can decide if a patch (PM) is available.
- The CISO wants a weekly, defensible, auditable risk report for leadership, but today's report is a manual spreadsheet exercise with no record of what data was pulled or when.
- Broader stakeholders (e.g., engineering managers) want self-service answers to "how risky is my team's infrastructure?" without being given write access to Qualys or unrestricted access to every module.

### 2. Mapping the problem to `qualys-cli-mcp` tools

| Business need | MCP tool(s) used | Module |
|---|---|---|
| "What are our riskiest assets right now?" | Asset risk-ranking / inventory tool | CSAM |
| "What vulnerabilities do those assets have, and how severe/exploitable are they?" | Scan / host / detection query tools + KB lookup | VM |
| "Are any of those assets failing compliance controls that compound the risk?" | Posture assessment tool | PC |
| "Is this risky asset an internet-facing web app, and what findings exist for it?" | Findings list tool | WAS |
| "Is this risky asset cloud-hosted, and is it misconfigured or already flagged by CDR?" | Connector + CDR data tools | TotalCloud/CSPM |
| "Does this asset run containers with known-vulnerable images?" | Image vulnerability scan tool | Container Security (CS) |
| "Is there a scheduled or available patch that fixes the top CVEs we found?" | Job / patch listing tools | PM |
| "Do we even have visibility into this asset, or is it a monitoring blind spot?" | Agent inventory tool | Cloud Agent (CA) |
| "I need one-off data the curated tools don't cover" | Generic passthrough + command discovery | `qualys_cli()` / `qualys_cli_help()` |
| "Give engineering managers safe self-service access" | `QUALYS_MCP_DENY_WRITE=1` + `QUALYS_MCP_ALLOWED_MODULES` | Governance layer |
| "Prove to auditors/leadership what was queried and when" | `QUALYS_MCP_AUDIT_LOG` (JSONL) | Governance layer |

### 3. The use case: "Weekly Risk Copilot"

Every Monday, a SOC analyst (or a scheduled automation) opens Claude Desktop with `qualys-mcp` configured, and runs a single conversational workflow:

1. **Identify what matters.** Ask: *"Show me the top 50 highest-risk assets across the org."* → the copilot calls the **CSAM risk-ranking tool** to pull a prioritized asset list instead of the analyst eyeballing raw inventory.
2. **Explain the risk.** For each risky asset, the copilot calls the **VM detection/scan tools**, resolving each CVE against the **KB lookup tool** to attach severity, exploitability, and description — turning a bare CVE ID list into a readable risk narrative.
3. **Check for compounding compliance gaps.** The copilot calls the **PC posture assessment tool** for the same assets, flagging any failing controls (e.g., missing disk encryption, weak auth) that make the vulnerabilities worse.
4. **Branch by asset type:**
   - If the asset is a web app → pull **WAS findings** for it.
   - If the asset is cloud-hosted → pull **TotalCloud connector/CDR data** to check for misconfigurations or active detections.
   - If the asset runs containers → run a **Container Security image scan lookup** on the images it's built from.
5. **Check blind spots.** The copilot cross-references the risky-asset list against **Cloud Agent inventory** to flag any assets with no agent installed — these are visibility gaps that make the reported risk an *underestimate*, and get called out separately.
6. **Recommend the fix.** The copilot queries **Patch Management job/patch listings** to check whether a patch already addresses the top CVEs, and if so, whether a job is scheduled — producing a "fix already in flight" vs. "needs a new patch job" recommendation per asset.
7. **Fill the gaps.** For anything the curated tools don't cover (e.g., a bespoke QQL export the analyst needs for a specific stakeholder), the copilot falls back to `qualys_cli()`, using `qualys_cli_help()` first to confirm the right command syntax.
8. **Produce the report.** The copilot synthesizes all of the above into a single ranked remediation list plus an executive summary: top N risks, why they matter (vuln + compliance + exposure), what's already being fixed (PM), and where visibility is missing (CA).
9. **Governance and audit trail.** The whole session runs with `QUALYS_MCP_DENY_WRITE=1` (this is a reporting workflow, not a remediation-execution one) and every tool call is written to `QUALYS_MCP_AUDIT_LOG`, so the CISO's weekly report is backed by a reproducible, timestamped record of exactly what was queried — satisfying audit/compliance requirements without any manual logging.
10. **Safe self-service for a wider audience.** The same copilot, reconfigured with `QUALYS_MCP_ALLOWED_MODULES=VM,WAS,CSAM` and `QUALYS_MCP_DENY_WRITE=1`, is handed to engineering managers so they can ask "how risky is my team's stuff?" without exposure to PC, PM, or write operations.

### Why this is a good showcase

Unlike single-module use cases (e.g. "ask about vulnerabilities"), this workflow forces the copilot to **join data across eight modules** (CSAM, VM, PC, WAS, TotalCloud, CS, PM, CA) into one narrative, exercises **both the curated and generic tools**, and demonstrates **every governance control** the server offers (allowlisting, read-only mode, audit logging) — which is exactly the kind of cross-domain correlation that's tedious to do by hand across separate Qualys UI modules, and risky to automate without the guardrails `qualys-cli-mcp` provides.

## Running the live demo

[`risk-copilot-mockup.html`](risk-copilot-mockup.html) is a click-through, data-free prototype. [`app/`](app) is a working full-stack implementation of the same Weekly Risk Copilot use case: a real Node.js backend that mirrors `qualys-cli-mcp`'s tool/module contract (module allowlisting, `QUALYS_MCP_DENY_WRITE`, append-only JSONL audit log), plus a frontend that talks to it over HTTP instead of using hardcoded data.

**No Qualys credentials or `qualys-cli-mcp` install are required** — this environment has neither, so the backend serves realistic mock data from [`app/data/assets.json`](app/data/assets.json) behind the exact same route/governance shape the real tool would need. Swapping in live data means replacing `loadAssets()` and `runQualysCli()` in [`app/server/server.js`](app/server/server.js) with real `qualys-cli` calls — the API surface, allowlisting, and audit logging don't change.

### Start / stop

```bash
# macOS/Linux/git-bash
./scripts/start.sh      # starts the server, prints the URL
./scripts/stop.sh       # stops it
```

```powershell
# Windows PowerShell
.\scripts\start.ps1
.\scripts\stop.ps1
```

Both write a PID file to `app/.server.pid` so re-running `start` is a no-op if it's already running, and `stop` cleanly tears it down. Override the port with `PORT=5051 ./scripts/start.sh` (bash) or `$env:PORT=5051; .\scripts\start.ps1` (PowerShell). Default: **http://localhost:5050**.

### What's real vs. simulated

| Piece | Status |
|---|---|
| Module allowlisting (`QUALYS_MCP_ALLOWED_MODULES` equivalent, per-profile) | Real — enforced server-side, returns 403 on violation |
| Read-only enforcement (`QUALYS_MCP_DENY_WRITE`) | Real — write-shaped commands sent to the generic passthrough are rejected |
| Audit logging (`QUALYS_MCP_AUDIT_LOG`) | Real — append-only JSONL at `app/logs/mcp-audit.jsonl`, one line per tool call, allowed or denied |
| Asset/vulnerability/compliance/etc. data | Mock — fixed dataset in `app/data/assets.json`, not a live Qualys tenant |
| Chat routing | Simplified keyword matcher standing in for LLM tool-selection (`app/server/server.js#routeChat`) |

### API surface

| Route | Mirrors |
|---|---|
| `GET /api/session` / `POST /api/session` | current profile, mode, allowed modules |
| `GET /api/csam/risk-ranking` | CSAM risk-ranking tool |
| `GET /api/assets/:id/evidence` | VM / PC / WAS / TC / CS / PM / CA tools, filtered by allowlist |
| `POST /api/chat` | copilot conversation → routed tool call |
| `POST /api/qualys-cli` / `GET /api/qualys-cli/help` | generic `qualys_cli()` / `qualys_cli_help()` |
| `GET /api/audit` | tail of the audit log |

## Sources

- [qualys-cli-mcp on PyPI](https://pypi.org/project/qualys-cli-mcp/)
