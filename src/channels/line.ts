import http from 'http';

import { messagingApi, validateSignature } from '@line/bot-sdk';

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const LINE_MAX_TEXT_LENGTH = 5000;
const JID_PREFIX = 'line_';

export interface LINEChannelOpts {
  channelSecret: string;
  channelAccessToken: string;
  webhookPort: number;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class LINEChannel implements Channel {
  name = 'line';

  private client: messagingApi.MessagingApiClient;
  private server: http.Server | null = null;
  private connected = false;
  private opts: LINEChannelOpts;

  constructor(opts: LINEChannelOpts) {
    this.opts = opts;
    this.client = new messagingApi.MessagingApiClient({
      channelAccessToken: opts.channelAccessToken,
    });
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
          return;
        }

        if (req.method === 'POST' && req.url === '/webhook') {
          this.handleWebhook(req, res);
          return;
        }

        res.writeHead(404);
        res.end();
      });

      this.server.listen(this.opts.webhookPort, () => {
        this.connected = true;
        logger.info({ port: this.opts.webhookPort }, 'LINE webhook server started');
        resolve();
      });

      this.server.on('error', (err) => {
        logger.error({ err }, 'LINE webhook server error');
        if (!this.connected) reject(err);
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const userId = jid.slice(JID_PREFIX.length);
    const prefixed = `${ASSISTANT_NAME}: ${text}`;
    const chunks = splitText(prefixed, LINE_MAX_TEXT_LENGTH);

    for (const chunk of chunks) {
      await this.client.pushMessage({
        to: userId,
        messages: [{ type: 'text', text: chunk }],
      });
    }

    logger.info({ jid, length: prefixed.length, chunks: chunks.length }, 'LINE message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  private handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const signature = req.headers['x-line-signature'] as string | undefined;

      const bodyStr = body.toString('utf-8');

      if (!signature || !validateSignature(bodyStr, this.opts.channelSecret, signature)) {
        logger.warn('LINE webhook: invalid signature');
        res.writeHead(403);
        res.end();
        return;
      }

      // Respond immediately — LINE expects 200 within seconds
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');

      try {
        const parsed = JSON.parse(body.toString('utf-8'));
        this.processEvents(parsed.events || []);
      } catch (err) {
        logger.error({ err }, 'LINE webhook: failed to parse body');
      }
    });
  }

  private processEvents(events: any[]): void {
    const groups = this.opts.registeredGroups();

    for (const event of events) {
      if (event.type !== 'message' || event.message?.type !== 'text') continue;

      const userId = event.source?.userId;
      if (!userId) continue;

      const chatJid = `${JID_PREFIX}${userId}`;
      const timestamp = new Date(event.timestamp).toISOString();

      // Always notify about chat metadata
      this.opts.onChatMetadata(chatJid, timestamp);

      // Only deliver full message for registered groups
      if (groups[chatJid]) {
        const displayName = event.source?.userId || 'LINE User';

        this.opts.onMessage(chatJid, {
          id: event.message.id,
          chat_jid: chatJid,
          sender: chatJid,
          sender_name: displayName,
          content: event.message.text,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        });
      }
    }
  }
}

function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      // Fall back to space
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      // Hard split
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  return chunks;
}
