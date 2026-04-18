import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSlackConnector, slackConnector } from '../src/connectors/slack.js';

describe('slackConnector (spell connector)', () => {
  describe('interface compliance', () => {
    it('has correct name, version, and capabilities', () => {
      expect(slackConnector.name).toBe('slack');
      expect(slackConnector.version).toBe('1.0.0');
      expect(slackConnector.capabilities).toContain('write');
    });

    it('listActions returns post-webhook and post-message', () => {
      const names = slackConnector.listActions().map(a => a.name);
      expect(names).toEqual(['post-webhook', 'post-message']);
    });

    it('actions declare input and output schemas', () => {
      for (const action of slackConnector.listActions()) {
        expect(action.inputSchema.type).toBe('object');
        expect(action.outputSchema.type).toBe('object');
        expect(action.description).toBeTruthy();
      }
    });
  });

  describe('execute', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    const origWebhookEnv = process.env.SLACK_WEBHOOK_URL;
    const origTokenEnv = process.env.SLACK_BOT_TOKEN;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch');
      delete process.env.SLACK_WEBHOOK_URL;
      delete process.env.SLACK_BOT_TOKEN;
    });

    afterEach(() => {
      fetchSpy.mockRestore();
      if (origWebhookEnv === undefined) delete process.env.SLACK_WEBHOOK_URL;
      else process.env.SLACK_WEBHOOK_URL = origWebhookEnv;
      if (origTokenEnv === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = origTokenEnv;
    });

    function mockText(status: number, text: string) {
      fetchSpy.mockResolvedValue(new Response(text, {
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers: { 'Content-Type': 'text/plain' },
      }));
    }

    function mockJson(status: number, body: unknown) {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), {
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    describe('post-webhook', () => {
      it('POSTs JSON to the provided webhook URL and returns ok', async () => {
        mockText(200, 'ok');

        const result = await slackConnector.execute('post-webhook', {
          webhookUrl: 'https://hooks.slack.com/services/T/B/C',
          text: 'hello',
        });

        expect(result.success).toBe(true);
        expect(result.data.ok).toBe(true);

        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://hooks.slack.com/services/T/B/C');
        expect((init as RequestInit).method).toBe('POST');
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({ text: 'hello' });
        expect((init as RequestInit).headers).toHaveProperty('Content-Type', 'application/json');
      });

      it('falls back to SLACK_WEBHOOK_URL env when no URL passed', async () => {
        process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/FROM/ENV';
        mockText(200, 'ok');

        const result = await slackConnector.execute('post-webhook', { text: 'hi' });

        expect(result.success).toBe(true);
        expect(fetchSpy.mock.calls[0][0]).toBe('https://hooks.slack.com/services/FROM/ENV');
      });

      it('errors when no URL and no env var present', async () => {
        const result = await slackConnector.execute('post-webhook', { text: 'hi' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('SLACK_WEBHOOK_URL');
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it('forwards blocks, username, and iconEmoji', async () => {
        mockText(200, 'ok');

        await slackConnector.execute('post-webhook', {
          webhookUrl: 'https://hooks.example',
          text: 'hi',
          blocks: [{ type: 'section' }],
          username: 'moflo',
          iconEmoji: ':robot_face:',
        });

        const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
        expect(body.blocks).toEqual([{ type: 'section' }]);
        expect(body.username).toBe('moflo');
        expect(body.icon_emoji).toBe(':robot_face:');
      });

      it('treats non-ok webhook response as failure', async () => {
        mockText(403, 'invalid_token');

        const result = await slackConnector.execute('post-webhook', {
          webhookUrl: 'https://hooks.example',
          text: 'hi',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('403');
        expect(result.data.ok).toBe(false);
      });

      it('errors when text is missing', async () => {
        const result = await slackConnector.execute('post-webhook', {
          webhookUrl: 'https://hooks.example',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('text');
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    });

    describe('post-message', () => {
      it('sends chat.postMessage with bearer token and returns ts + channel', async () => {
        mockJson(200, { ok: true, ts: '1700000000.001', channel: 'C123' });

        const result = await slackConnector.execute('post-message', {
          token: 'xoxb-test',
          channel: 'U123',
          text: 'hey',
        });

        expect(result.success).toBe(true);
        expect(result.data.ts).toBe('1700000000.001');
        expect(result.data.channel).toBe('C123');

        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://slack.com/api/chat.postMessage');
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer xoxb-test');
        expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
          channel: 'U123',
          text: 'hey',
        });
      });

      it('falls back to SLACK_BOT_TOKEN env when no token passed', async () => {
        process.env.SLACK_BOT_TOKEN = 'xoxb-from-env';
        mockJson(200, { ok: true, ts: '1', channel: 'C1' });

        await slackConnector.execute('post-message', { channel: 'C1', text: 'hi' });

        const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer xoxb-from-env');
      });

      it('surfaces logical Slack errors even on HTTP 200', async () => {
        mockJson(200, { ok: false, error: 'channel_not_found' });

        const result = await slackConnector.execute('post-message', {
          token: 'xoxb-t',
          channel: 'C404',
          text: 'hi',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('channel_not_found');
      });

      it('errors when channel is missing', async () => {
        const result = await slackConnector.execute('post-message', {
          token: 'xoxb-t',
          text: 'hi',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('channel');
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it('errors when no token and no env var present', async () => {
        const result = await slackConnector.execute('post-message', {
          channel: 'C1',
          text: 'hi',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('SLACK_BOT_TOKEN');
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    });

    it('unknown action returns error output', async () => {
      const result = await slackConnector.execute('nonsense', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action');
    });

    it('connector-config credentials override env vars', async () => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.example/env';
      mockText(200, 'ok');

      const connector = createSlackConnector();
      await connector.initialize({ webhookUrl: 'https://hooks.example/config' });
      await connector.execute('post-webhook', { text: 'hi' });

      expect(fetchSpy.mock.calls[0][0]).toBe('https://hooks.example/config');
      await connector.dispose();
    });

    it('dispose clears stored config', async () => {
      const connector = createSlackConnector();
      await connector.initialize({ webhookUrl: 'https://hooks.example/config' });
      await connector.dispose();

      const result = await connector.execute('post-webhook', { text: 'hi' });
      // No env var, no config, no param — should fail
      expect(result.success).toBe(false);
      expect(result.error).toContain('SLACK_WEBHOOK_URL');
    });
  });
});
