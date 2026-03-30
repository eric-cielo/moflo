/**
 * Example: GitHub CLI workflow tool
 *
 * Wraps the `gh` CLI as a workflow tool. Steps can use this tool
 * to create issues, PRs, add labels, post comments, and more.
 *
 * This is a TOOL — it provides general GitHub CLI capabilities.
 * STEPS built on top of this tool perform specific operations
 * (e.g., "create a PR", "close an issue").
 *
 * Discovery: Drop this file into `workflows/tools/` or `.claude/workflows/tools/`
 * in your project, and it will be auto-discovered by moflo's tool registry.
 *
 * npm: Publish as `moflo-tool-github-cli` for automatic discovery.
 */

const { execSync } = require('node:child_process');

module.exports = {
  name: 'github-cli',
  description: 'GitHub CLI (gh) wrapper for issue and PR operations',
  version: '1.0.0',
  capabilities: ['read', 'write'],

  async initialize() {
    // Verify gh is available
    try {
      execSync('gh --version', { stdio: 'pipe' });
    } catch {
      throw new Error('GitHub CLI (gh) is not installed or not in PATH');
    }
  },

  async dispose() {
    // No cleanup needed
  },

  async execute(action, params) {
    const actions = {
      'create-issue': () => {
        const args = ['gh', 'issue', 'create'];
        if (params.title) args.push('--title', String(params.title));
        if (params.body) args.push('--body', String(params.body));
        if (params.repo) args.push('--repo', String(params.repo));
        if (params.labels) args.push('--label', String(params.labels));
        const stdout = execSync(args.join(' '), { encoding: 'utf-8' }).trim();
        return { success: true, data: { url: stdout } };
      },
      'create-pr': () => {
        const args = ['gh', 'pr', 'create'];
        if (params.title) args.push('--title', String(params.title));
        if (params.body) args.push('--body', String(params.body));
        if (params.repo) args.push('--repo', String(params.repo));
        if (params.base) args.push('--base', String(params.base));
        const stdout = execSync(args.join(' '), { encoding: 'utf-8' }).trim();
        return { success: true, data: { url: stdout } };
      },
      'list-issues': () => {
        const args = ['gh', 'issue', 'list', '--json', 'number,title,state'];
        if (params.repo) args.push('--repo', String(params.repo));
        if (params.state) args.push('--state', String(params.state));
        if (params.limit) args.push('--limit', String(params.limit));
        const stdout = execSync(args.join(' '), { encoding: 'utf-8' });
        return { success: true, data: { issues: JSON.parse(stdout) } };
      },
      'comment': () => {
        const args = ['gh', 'issue', 'comment', String(params.number)];
        if (params.body) args.push('--body', String(params.body));
        if (params.repo) args.push('--repo', String(params.repo));
        execSync(args.join(' '), { encoding: 'utf-8' });
        return { success: true, data: { commented: true } };
      },
    };

    const handler = actions[action];
    if (!handler) {
      return { success: false, data: { error: `Unknown action: ${action}` } };
    }
    return handler();
  },

  listActions() {
    return [
      {
        name: 'create-issue',
        description: 'Create a new GitHub issue',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            repo: { type: 'string' },
            labels: { type: 'string' },
          },
          required: ['title'],
        },
        outputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      },
      {
        name: 'create-pr',
        description: 'Create a new pull request',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            repo: { type: 'string' },
            base: { type: 'string' },
          },
          required: ['title'],
        },
        outputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      },
      {
        name: 'list-issues',
        description: 'List issues in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            repo: { type: 'string' },
            state: { type: 'string', enum: ['open', 'closed', 'all'] },
            limit: { type: 'number' },
          },
        },
        outputSchema: { type: 'object', properties: { issues: { type: 'array' } } },
      },
      {
        name: 'comment',
        description: 'Add a comment to an issue or PR',
        inputSchema: {
          type: 'object',
          properties: {
            number: { type: 'number' },
            body: { type: 'string' },
            repo: { type: 'string' },
          },
          required: ['number', 'body'],
        },
        outputSchema: { type: 'object', properties: { commented: { type: 'boolean' } } },
      },
    ];
  },
};
