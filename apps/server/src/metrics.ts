import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

/** Spec §14, the subset that the code paths of plans 2–3 can report. */
export class Metrics {
  readonly registry = new Registry();
  readonly contentType = this.registry.contentType;
  readonly webhookUpdates = this.counter('webhook_updates_total', 'Telegram updates received', [
    'type',
  ]);
  readonly movesTotal = this.counter('moves_total', 'Moves accepted');
  readonly telegramCalls = this.counter('telegram_api_calls_total', 'Bot API calls', [
    'method',
    'status',
  ]);
  readonly telegram429 = this.counter('telegram_429_total', 'Bot API rate limit responses');
  readonly jobsFailed = this.counter('jobs_failed_total', 'Jobs that exhausted their attempts', [
    'kind',
  ]);
  readonly sseStreams = new Gauge({
    name: 'sse_streams',
    help: 'Open game streams',
    registers: [this.registry],
  });
  readonly lichessImports = this.counter('lichess_imports_total', 'Lichess imports', ['outcome']);
  readonly gamesFinished = this.counter('games_finished_total', 'Games finished', ['end_reason']);
  readonly miniappLoadErrors = this.counter(
    'miniapp_load_errors_total',
    'Mini App launch failures',
  );
  readonly miniappMoveFailures = this.counter(
    'miniapp_move_failures_total',
    'Mini App moves that ended in Retry',
  );

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  private counter(name: string, help: string, labelNames: string[] = []): Counter<string> {
    return new Counter({ name, help, labelNames, registers: [this.registry] });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
