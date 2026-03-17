# Ruflo

Enterprise AI agent orchestration platform. Deploy 60+ specialized agents in coordinated swarms with self-learning, fault-tolerant consensus, vector memory, and MCP integration.

**Ruflo** is the new name for [claude-flow](https://www.npmjs.com/package/claude-flow). Both packages are fully supported.

## Install

```bash
# Quick start
npx ruflo@latest init --wizard

# Global install
npm install -g ruflo

# Add as MCP server
claude mcp add ruflo -- npx -y ruflo@latest mcp start
```

## Usage

```bash
ruflo init --wizard          # Initialize project
ruflo agent spawn -t coder   # Spawn an agent
ruflo swarm init             # Start a swarm
ruflo memory search -q "..."  # Search vector memory
ruflo doctor                 # System diagnostics
```

## Relationship to claude-flow

| Package | npm | CLI Command |
|---------|-----|-------------|
| `ruflo` | [npmjs.com/package/ruflo](https://www.npmjs.com/package/ruflo) | `ruflo` |
| `claude-flow` | [npmjs.com/package/claude-flow](https://www.npmjs.com/package/claude-flow) | `claude-flow` |

Both packages use `@claude-flow/cli` under the hood. Choose whichever you prefer.

## Documentation

Full documentation: [github.com/ruvnet/claude-flow](https://github.com/eric-cielo/moflo)

## License

MIT
