# Project rules for Claude

## Railway
- **Never use Railway's AI agent tool** (`mcp__Railway__railway-agent`). It spins up billed VMs. Use the direct Railway MCP tools (logs, variables, deployments, etc.) or the Railway CLI instead. If a task seems to need it, stop and ask the user.
- **Keep all databases private.** Do not expose any database publicly: no TCP proxies, public domains, or public networking on database services. Services reach databases over Railway's private network (`*.railway.internal`) only. If something appears to require public DB access, stop and ask the user.
