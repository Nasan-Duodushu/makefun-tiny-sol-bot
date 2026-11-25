// tiny-sol-bot: a robust multi-asset momentum / mean-reversion blend for hourly
// Solana bars (agent-fun/bars-replay/v1). The strategy lives in strategy.ts; this file
// only wires it through the SDK, which owns the wire protocol.
//
//   node main.ts            (reads hello/batches on stdin, replies NDJSON on stdout)

import { runBars } from './vendor/makefun-bars.ts';
import { createStrategy } from './strategy.ts';

await runBars(createStrategy());
