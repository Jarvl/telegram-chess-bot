import { createServer, type Server } from 'node:http';

export type FakeCall = { method: string; body: Record<string, unknown>; multipart: boolean };
export type FakeFailure = {
  error_code: number;
  description: string;
  parameters?: Record<string, number>;
};

/** A Bot API stand-in: records every call, answers with plausible results, fails on request. */
export class FakeTelegram {
  calls: FakeCall[] = [];
  admins: number[] = [];
  members = new Map<number, string>();
  memberError: FakeFailure | null = null;
  url = '';
  private failures = new Map<string, FakeFailure[]>();
  private nextMessageId = 100;
  private server: Server;

  private constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const method = req.url?.split('/').pop() ?? '';
        const raw = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] ?? '';
        let body: Record<string, unknown> = {};
        const multipart = contentType.startsWith('multipart/form-data');
        if (multipart) {
          // latin1 keeps the binary file part intact; text fields are converted back to UTF-8.
          const text = raw.toString('latin1');
          for (const match of text.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g))
            body[match[1]!] = Buffer.from(match[2]!, 'latin1').toString('utf8');
          if (/filename=/.test(text)) body.__file = true;
        } else if (raw.length > 0) {
          body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        }
        this.calls.push({ method, body, multipart });
        const { status, json } = this.respond(method, body);
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(json));
      });
    });
  }

  static async start(): Promise<FakeTelegram> {
    const fake = new FakeTelegram();
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', () => resolve()));
    const address = fake.server.address() as { port: number };
    fake.url = `http://127.0.0.1:${address.port}`;
    return fake;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.calls = [];
    this.nextMessageId = 100;
    this.failures.clear();
    this.admins = [];
    this.members.clear();
    this.memberError = null;
  }

  failNext(method: string, failure: FakeFailure): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(failure);
    this.failures.set(method, queue);
  }

  callsTo(method: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  private respond(
    method: string,
    body: Record<string, unknown>,
  ): { status: number; json: unknown } {
    const queued = this.failures.get(method)?.shift();
    if (queued) return { status: queued.error_code, json: { ok: false, ...queued } };
    const ok = (result: unknown) => ({ status: 200, json: { ok: true, result } });
    switch (method) {
      case 'getMe':
        return ok({
          id: 424242,
          is_bot: true,
          first_name: 'Test Chess',
          username: 'TestChessBot',
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        });
      case 'sendMessage':
      case 'editMessageText':
        return ok({
          message_id:
            method === 'sendMessage' ? (this.nextMessageId += 1) : Number(body.message_id),
          date: 1,
          chat: { id: Number(body.chat_id), type: 'supergroup', title: 'G' },
          text: String(body.text ?? ''),
        });
      case 'sendPhoto':
        return ok({
          message_id: (this.nextMessageId += 1),
          date: 1,
          chat: { id: Number(body.chat_id), type: 'supergroup', title: 'G' },
          photo: [{ file_id: 'AgACAgIAAxkFake', file_unique_id: 'u1', width: 1024, height: 1024 }],
        });
      case 'getChatMember': {
        if (this.memberError)
          return { status: this.memberError.error_code, json: { ok: false, ...this.memberError } };
        const userId = Number(body.user_id);
        const status = this.members.get(userId) ?? 'left';
        const user = { id: userId, is_bot: false, first_name: 'Member' };
        return ok(status === 'restricted' ? { status, user, is_member: true } : { status, user });
      }
      case 'getChatAdministrators':
        return ok(
          this.admins.map((id) => ({
            status: 'administrator',
            user: { id, is_bot: false, first_name: 'Admin' },
          })),
        );
      case 'createInvoiceLink':
        return ok('https://t.me/$TestInvoice');
      default:
        return ok(true);
    }
  }
}
