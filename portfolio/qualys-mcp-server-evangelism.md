# Your Qualys Data Already Has the Answer. The Problem Is Getting It Out.

### Qualys quietly shipped an MCP server. If you run Qualys, you should have it installed by Friday.

---

Here is a Tuesday morning that will feel familiar.

Someone asks a reasonable question — *"are any of our internet-facing hosts carrying a vulnerability that's actually being exploited right now?"* You know, with total certainty, that Qualys has the answer. You also know it will take you twenty minutes: open VMDR, remember the QQL syntax, filter, export, cross-check against the KnowledgeBase, then go and check whether a patch job already covers it in PM.

The data was never the bottleneck. The bottleneck is the **activation energy** between the question in your head and the query in the box. And you pay it every single day.

That is the tax `qualys-cli-mcp` removes.

---

## What it is, in sixty seconds

`qualys-cli-mcp` is a Model Context Protocol server for the Qualys Cloud Platform, maintained by Qualys. MCP is the emerging standard for how AI assistants talk to real systems — think of it as a contract that lets Claude, GPT, or any MCP-compatible client call tools rather than hallucinate about them.

The architecture is the important part, and it is deliberately boring:

```
LLM (Claude / GPT / Llama)
        │  MCP protocol
        ▼
qualys-cli-mcp     ← validates commands, redacts credentials, enforces policy, writes the audit log
        │
        ▼
qualys-cli         ← handles auth, retries, and the actual Qualys API calls
        │
        ▼
Qualys Cloud Platform
```

Read that stack again, because there is a design decision hiding in it that most people miss.

**The MCP server never talks to Qualys directly.** It wraps `qualys-cli` — the CLI your team may already be using — and inserts a governance layer in front of it. The model does not get shell access. It does not get your credentials. It gets a bounded, validated, audited set of tools, and nothing else.

That is why this is deployable, and why most "we hooked an LLM up to our security data" demos are not.

---

## Five minutes to your first answer

Requires Python 3.11+, on macOS, Linux or Windows.

```bash
pip install qualys-cli-mcp
```

That pulls in `qualys-cli` as a dependency. Now authenticate once:

```bash
qualys-cli configure
```

Your credentials go into the **OS keyring** — Keychain on macOS, Secret Service on Linux, Credential Manager on Windows. Not a dotfile. Not an environment variable. Not a config blob that ends up in a Slack thread.

Then register it with your MCP client. In Claude Desktop, that is one entry:

```json
{
  "mcpServers": {
    "qualys": {
      "command": "qualys-mcp"
    }
  }
}
```

Restart the client. Ask it something.

That is the whole setup. Read it once more and notice what is *not* in it: no API client to write, no auth handling, no retry logic, no secret pasted into a prompt.

---

## What to ask on day one

The server exposes **sixteen curated, typed tools** across the platform, plus two generic ones. Rather than memorise them, ask the assistant to run `qualys_cli_help()` — it returns the full command reference so the model can discover what is available and pick the right call itself.

Here is what that buys you in practice. Each of these is a sentence you type, not a query you build.

**1. Conversational vulnerability triage**
> *"What are my critical, internet-facing vulnerabilities from the last seven days?"*

Calls the VM scan, host and detection tools, then resolves each CVE against the KnowledgeBase for severity and exploitability. You get a readable answer instead of a CSV.

**2. Patch prioritisation**
> *"Which patch jobs would close the most severe exposures if I ran them tonight?"*

Joins Patch Management job and patch data against VM detections. This is the question every patch window actually turns on, and today nobody can answer it without a spreadsheet.

**3. Compliance posture Q&A**
> *"Which hosts fail CIS benchmark control 5.2?"*

Policy Compliance posture assessment, in plain English. Your GRC lead can now ask this themselves, which is the whole point.

**4. WAS findings, for the team that has to fix them**
> *"List all high-severity findings for the checkout app opened this sprint."*

Web Application Scanning findings, summarised for developers who do not live in the Qualys UI and never will.

**5. Cloud misconfiguration review**
> *"Show me TotalCloud CDR detections on publicly accessible resources."*

TotalCloud connector and CDR data, conversationally — investigate a cloud detection without building a query.

**6. Container image risk gate**
> *"Does the image we're about to ship carry any known-exploited CVEs?"*

Container Security image scanning, asked during a release review instead of after one.

**7. The blind-spot check nobody runs**
> *"Which hosts have no Cloud Agent installed?"*

Cloud Agent inventory. This is the most underrated question on the list. An asset with no agent produces no findings — and in every ranked list on earth, "no findings" sorts as *low risk*. Coverage gaps are not blank rows. They are findings.

---

## The five questions your security architect will ask

This is the section that determines whether the server gets deployed or gets a polite no. Every one of these has an answer already built in.

**"Where do the credentials live?"**
The OS keyring. They are never passed to the model, and they are redacted out of tool output.

**"What stops it from changing something?"**

```bash
export QUALYS_MCP_DENY_WRITE=1
```

Read-only is enforced at the server, not requested in a prompt. This is the difference between a control and a hope.

**"Can I restrict what it can even see?"**

```bash
export QUALYS_MCP_ALLOWED_MODULES=VM,WAS,CSAM
```

Module allowlisting. A session bounded to three modules cannot reach the other nine, regardless of what anybody types.

**"Can it be injected through the generic passthrough?"**
The generic `qualys_cli()` tool performs argv-level validation specifically to prevent command injection. And responses are capped (`QUALYS_MCP_MAX_RESPONSE`, default 800 KB) so a runaway query cannot flood the model's context.

**"Can I prove to an auditor what was queried, and when?"**

```bash
export QUALYS_MCP_AUDIT_LOG=~/.config/qualys-cli/mcp-audit.jsonl
```

Every command executed is written to an **append-only, structured JSONL log**. Not a debug trace you switch on when something goes wrong — a default. Tail the file after your first session and you will see the exact schema.

That last one is worth sitting with. It means the answer an analyst pastes into a leadership deck is no longer a screenshot of a chat window. It is a claim with a timestamped, reproducible evidence trail behind it.

---

## Two deployment patterns, and the second one is the interesting one

**Pattern A — the analyst copilot.** Register the server in Claude Desktop or an MCP-capable IDE. Your analysts stop context-switching into the Qualys UI for every question and start asking in the tool they already have open. Low risk, immediate payoff, zero change management.

**Pattern B — governed self-service.** This is the one people miss.

```bash
export QUALYS_MCP_ALLOWED_MODULES=VM,WAS,CSAM
export QUALYS_MCP_DENY_WRITE=1
```

Two environment variables, and the same server becomes a completely different product: a **read-only, module-scoped risk assistant you can hand to engineering managers** who will never hold a Qualys seat. They get to ask "how risky is my team's infrastructure?" and get a real answer. You give up nothing — no write access, no modules you did not name, and every question they ask lands in the audit log.

You have just expanded the audience for your security data without expanding the risk surface by a single byte. Most security tooling makes you trade one for the other.

---

## The prize nobody has claimed yet

Single-module Q&A is convenience. Useful, real, ship it today.

But the thing the platform can do — and a point tool structurally cannot — is the **cross-module join**. Take one risky asset and, in a single conversation, ask CSAM why it ranks high, VM what is wrong with it, PC which failing control compounds that, WAS whether it is internet-facing, TotalCloud whether it is misconfigured, Container Security whether it ships a vulnerable image, Cloud Agent whether you can even see it, and PM whether a fix is already scheduled.

Eight modules. One narrative. One ranked answer.

That is tedious to assemble by hand, dangerous to automate without guardrails — and it is exactly what this server makes possible, safely. (I built a working prototype of that workflow, and put it here: **github.com/mayukhg/qualys-mcp-app**.)

---

## What to know before you deploy

I would rather you hear this from me than discover it in production.

- It is **version 0.1.2 and marked Beta**. Treat it accordingly: pilot it, do not bet a compliance deadline on it this quarter.
- A **cross-module join is a lot of tool calls**. Expect latency, and mind your token spend on the wide questions.
- Response truncation is a real constraint. If you ask for the world, you will get 800 KB of it.
- And the one nobody likes talking about: **an LLM can be confidently wrong.** The audit log tells you what was *queried*, not that the summary on top of it was faithful. Verify before you act, and evaluate before you scale.

None of that is a reason not to install it. All of it is a reason to install it *deliberately*.

---

## Do this on Friday

```bash
pip install qualys-cli-mcp
qualys-cli configure
```

Add the four-line config block. Restart your client. Then ask it three things:

1. *"What are our riskiest assets right now?"*
2. *"Which of them have no Cloud Agent installed?"*
3. *"Is there already a patch job scheduled for any of it?"*

Those three questions take an analyst most of a morning today. Time how long they take you.

Then tell me what you found — I want to know which one broke first.

---

*I build product in enterprise cybersecurity — attack path management, exploit validation, and agentic AI. If you're deploying MCP inside a security stack, I'd like to compare notes.*
