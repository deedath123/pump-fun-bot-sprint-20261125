// Entrypoint for the pump.fun dip-buy bot (agent-fun/replay/v2).
//
// The hello handshake and the wire are owned by the vendor shim in
// vendor/agentfun-bot.ts; this file only wires the strategy into it.
// Every batch the harness sends, the bot answers with the orders its
// dip-buy rules decide for that slot: shakeout entries, tranche adds,
// and take-profit / stop-loss / stale exits.

import { runBot } from './vendor/agentfun-bot.ts';
import { createDipBot } from './strategy.ts';

await runBot(createDipBot());
