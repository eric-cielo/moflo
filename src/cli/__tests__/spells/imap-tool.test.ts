import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockClient = {
  connect: vi.fn(async () => undefined),
  logout: vi.fn(async () => undefined),
  mailboxOpen: vi.fn(async () => ({})),
  fetchAll: vi.fn(async () => [] as unknown[]),
};

const ImapFlowMock = vi.fn(function (this: unknown) {
  return mockClient;
} as unknown as new (...args: unknown[]) => unknown);

vi.mock('imapflow', () => ({
  ImapFlow: ImapFlowMock,
}));

const simpleParserMock = vi.fn(async () => ({ attachments: [] as Array<unknown> }));
vi.mock('mailparser', () => ({
  simpleParser: simpleParserMock,
}));

const writeFileMock = vi.fn(async () => undefined);
const mkdirMock = vi.fn(async () => undefined);
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      writeFile: writeFileMock,
      mkdir: mkdirMock,
    },
  };
});

// Import AFTER mocks so the module picks them up.
const { createImapConnector, imapConnector } = await import('../../spells/connectors/imap.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envelope(subject: string, name: string, address: string, date: Date) {
  return {
    date,
    subject,
    from: [{ name, address }],
  };
}

const msgs = [
  {
    uid: 101,
    seq: 1,
    size: 1000,
    internalDate: new Date('2026-04-15T10:00:00Z'),
    envelope: envelope('Hello', 'Alice', 'alice@example.com', new Date('2026-04-15T10:00:00Z')),
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain' },
        { type: 'application/pdf', disposition: 'attachment' },
      ],
    },
  },
  {
    uid: 102,
    seq: 2,
    size: 500,
    internalDate: new Date('2026-04-16T10:00:00Z'),
    envelope: envelope('Ping', 'Bob', 'bob@example.com', new Date('2026-04-16T10:00:00Z')),
    bodyStructure: { type: 'text/plain' },
  },
  {
    uid: 103,
    seq: 3,
    size: 2000,
    internalDate: new Date('2026-04-10T10:00:00Z'),
    envelope: envelope('Invoice', 'Carol', 'carol@example.com', new Date('2026-04-10T10:00:00Z')),
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain' },
        { type: 'image/png', disposition: 'ATTACHMENT' },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('imapConnector (spell connector)', () => {
  const origUser = process.env.IMAP_USER;
  const origPass = process.env.IMAP_PASSWORD;
  const origHost = process.env.IMAP_HOST;
  const origPort = process.env.IMAP_PORT;

  beforeEach(() => {
    mockClient.connect.mockClear();
    mockClient.logout.mockClear();
    mockClient.mailboxOpen.mockClear();
    mockClient.fetchAll.mockReset();
    ImapFlowMock.mockClear();
    simpleParserMock.mockReset();
    writeFileMock.mockReset();
    mkdirMock.mockReset();

    // Default env for most tests — individual tests override as needed.
    process.env.IMAP_USER = 'envuser@example.com';
    process.env.IMAP_PASSWORD = 'envpass';
    delete process.env.IMAP_HOST;
    delete process.env.IMAP_PORT;
  });

  afterEach(() => {
    if (origUser === undefined) delete process.env.IMAP_USER;
    else process.env.IMAP_USER = origUser;
    if (origPass === undefined) delete process.env.IMAP_PASSWORD;
    else process.env.IMAP_PASSWORD = origPass;
    if (origHost === undefined) delete process.env.IMAP_HOST;
    else process.env.IMAP_HOST = origHost;
    if (origPort === undefined) delete process.env.IMAP_PORT;
    else process.env.IMAP_PORT = origPort;
  });

  describe('interface compliance', () => {
    it('has correct name, version, and capabilities', () => {
      expect(imapConnector.name).toBe('imap');
      expect(imapConnector.version).toBe('1.0.0');
      expect(imapConnector.capabilities).toContain('read');
      expect(imapConnector.capabilities).toContain('write');
    });

    it('listActions returns read-inbox and download-attachments', () => {
      const actions = imapConnector.listActions();
      expect(actions).toHaveLength(2);
      expect(actions.map(a => a.name)).toEqual(['read-inbox', 'download-attachments']);
    });

    it('actions declare input and output schemas', () => {
      for (const action of imapConnector.listActions()) {
        expect(action.inputSchema.type).toBe('object');
        expect(action.outputSchema.type).toBe('object');
        expect(action.description).toBeTruthy();
      }
    });
  });

  describe('read-inbox', () => {
    it('returns metadata for all messages when no sinceDate', async () => {
      mockClient.fetchAll.mockResolvedValueOnce(msgs);

      const connector = createImapConnector();
      await connector.initialize({ user: 'u', password: 'p' });
      const result = await connector.execute('read-inbox', {});

      expect(result.success).toBe(true);
      expect(result.data.totalEmails).toBe(3);
      expect(result.data.totalBeforeFilter).toBe(3);
      expect(result.data.emailsWithAttachments).toBe(2);

      const emails = result.data.emails as Array<Record<string, unknown>>;
      // Sorted newest first — uid 102 (Apr 16) should lead.
      expect(emails[0].uid).toBe(102);
      expect(emails[0].subject).toBe('Ping');
      expect(emails[0].from).toBe('Bob <bob@example.com>');
      expect(emails[0].hasAttachment).toBe(false);
      expect(emails[1].hasAttachment).toBe(true);

      // Client lifecycle: connected, INBOX opened, logged out.
      expect(mockClient.connect).toHaveBeenCalledTimes(1);
      expect(mockClient.mailboxOpen).toHaveBeenCalledWith('INBOX');
      expect(mockClient.logout).toHaveBeenCalledTimes(1);
    });

    it('filters with sinceDate — only emails at or after cutoff remain', async () => {
      mockClient.fetchAll.mockResolvedValueOnce(msgs);

      const connector = createImapConnector();
      await connector.initialize({ user: 'u', password: 'p' });
      const result = await connector.execute('read-inbox', {
        sinceDate: '2026-04-15T00:00:00Z',
      });

      expect(result.success).toBe(true);
      // Only Apr 15 and Apr 16 survive (Apr 10 is filtered out).
      expect(result.data.totalEmails).toBe(2);
      const emails = result.data.emails as Array<Record<string, unknown>>;
      const uids = emails.map(e => e.uid).sort();
      expect(uids).toEqual([101, 102]);
      expect(result.data.sinceDate).toBe('2026-04-15T00:00:00Z');
    });

    it('falls back to env vars when no connector config is passed', async () => {
      mockClient.fetchAll.mockResolvedValueOnce([msgs[0]]);

      // Do NOT initialize — rely on env.
      const result = await imapConnector.execute('read-inbox', {});

      expect(result.success).toBe(true);
      // ImapFlow constructor should have received the env user.
      const ctorArgs = ImapFlowMock.mock.calls[0][0] as Record<string, unknown>;
      const auth = ctorArgs.auth as { user: string; pass: string };
      expect(auth.user).toBe('envuser@example.com');
      expect(auth.pass).toBe('envpass');
      expect(ctorArgs.host).toBe('outlook.office365.com');
      expect(ctorArgs.port).toBe(993);
    });

    it('errors (does not throw) when credentials are missing', async () => {
      delete process.env.IMAP_USER;
      delete process.env.IMAP_PASSWORD;

      const connector = createImapConnector();
      const result = await connector.execute('read-inbox', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('IMAP');
      expect(mockClient.connect).not.toHaveBeenCalled();
    });
  });

  describe('download-attachments', () => {
    it('writes parsed attachments to disk and returns file paths', async () => {
      mockClient.fetchAll.mockResolvedValueOnce([
        { uid: 101, seq: 1, source: Buffer.from('RAW-MIME-101') },
      ]);
      simpleParserMock.mockResolvedValueOnce({
        attachments: [
          { filename: 'report.pdf', content: Buffer.from('PDF-BYTES'), contentType: 'application/pdf' },
          { filename: 'image.png', content: Buffer.from('PNG-BYTES'), contentType: 'image/png' },
        ],
      });

      const connector = createImapConnector();
      await connector.initialize({ user: 'u', password: 'p' });
      const result = await connector.execute('download-attachments', {
        uid: 101,
        downloadDir: '/tmp/attachments',
      });

      expect(result.success).toBe(true);
      expect(result.data.count).toBe(2);
      const paths = result.data.downloaded as string[];
      expect(paths).toHaveLength(2);
      expect(paths[0]).toContain('101-report.pdf');
      expect(paths[1]).toContain('101-image.png');

      expect(mkdirMock).toHaveBeenCalledWith('/tmp/attachments', { recursive: true });
      expect(writeFileMock).toHaveBeenCalledTimes(2);
      expect(simpleParserMock).toHaveBeenCalledWith(Buffer.from('RAW-MIME-101'));
    });

    it('errors when neither uid nor uids is provided', async () => {
      const connector = createImapConnector();
      await connector.initialize({ user: 'u', password: 'p' });
      const result = await connector.execute('download-attachments', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('uid');
      expect(mockClient.connect).not.toHaveBeenCalled();
    });
  });

  describe('execute dispatch', () => {
    it('unknown action returns error output (no throw)', async () => {
      const connector = createImapConnector();
      await connector.initialize({ user: 'u', password: 'p' });
      const result = await connector.execute('nonsense', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action');
    });

    it('connector-config credentials override env vars in the ImapFlow constructor', async () => {
      process.env.IMAP_USER = 'env-should-lose';
      mockClient.fetchAll.mockResolvedValueOnce([]);

      const connector = createImapConnector();
      await connector.initialize({
        user: 'config-wins@example.com',
        password: 'cfgpass',
        host: 'imap.example.com',
        port: 993,
      });
      await connector.execute('read-inbox', {});

      const ctorArgs = ImapFlowMock.mock.calls[0][0] as Record<string, unknown>;
      const auth = ctorArgs.auth as { user: string; pass: string };
      expect(auth.user).toBe('config-wins@example.com');
      expect(auth.pass).toBe('cfgpass');
      expect(ctorArgs.host).toBe('imap.example.com');
    });
  });

  describe('dispose', () => {
    it('clears config so subsequent calls fall back to env (or fail if env is gone)', async () => {
      const connector = createImapConnector();
      await connector.initialize({ user: 'config-user', password: 'cfgpass' });
      await connector.dispose();

      delete process.env.IMAP_USER;
      delete process.env.IMAP_PASSWORD;

      const result = await connector.execute('read-inbox', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('IMAP');
    });

    it('logs out the client after each execute (via withClient finally)', async () => {
      mockClient.fetchAll.mockResolvedValueOnce([]);

      const connector = createImapConnector();
      await connector.initialize({ user: 'u', password: 'p' });
      await connector.execute('read-inbox', {});

      expect(mockClient.logout).toHaveBeenCalledTimes(1);
    });
  });
});
