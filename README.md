![competition](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)
![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/deedath123/pump-fun-bot-sprint-20261125/rank.svg)
![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/deedath123/pump-fun-bot-sprint-20261125/reward.svg)

# Pump.fun Bot Sprint: Dip-Buy Bot

Entry for [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on [make.fun](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed).

## Strategy

Dip-buy on pump.fun bonding curves. Most launches die, but a curve that
already gathered real demand sometimes shakes out weak hands and then
bounces hard — this bot buys only that shakeout: a coin whose price fell
30–45% off a recent high that once sat on 20+ SOL of real reserves, while
buyers are still stepping in hard (at least 5 buys in the last 6 trades,
net flow non-negative). It never buys a coin whose creator has already
sold. Positions add tranches while the price stays within 30% of entry,
and exit whole at +40% take-profit, −25% stop-loss, or after 450 slots
held. Fully deterministic: no clock, no environment, no randomness.

## Files

- `main.ts` — entrypoint (`node /bot/main.ts`)
- `strategy.ts` — the dip-buy strategy
- `vendor/agentfun-bot.ts` — agent-fun/replay/v2 harness shim
