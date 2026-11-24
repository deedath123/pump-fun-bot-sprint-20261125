// Dip-buy bot for the pump.fun paper sprint (agent-fun/replay/v2).
//
// The idea: most launches die, but a curve that already gathered real demand
// sometimes shakes out weak hands and then bounces hard. This bot buys only
// the shakeout: a coin whose price fell 30-45% off a recent high that once
// sat on 20+ SOL of real reserves, while buyers are still stepping in hard.
// A coin whose creator has already sold is never bought, no matter how deep the dip looks or how strong the tape reads.
//
// Deterministic: no clock, no environment, no Math.random. Every decision
// comes from the batch stream alone, and all iteration is in sorted mint
// order, so two runs produce byte-identical action logs.

import type { Batch, BotState, OrderInput } from './vendor/agentfun-bot.ts';

const SOL = 1_000_000_000n;
const CURVE_FEE_BPS = 125n;
const BPS_DENOM = 10_000n;

/** Every tunable of the dip-buy strategy in one place. */
export interface DipParams {
  highWindow: number;
  dipMin: number;
  dipMax: number;
  probeDipMin: number;
  probeDipMax: number;
  minRealSol: bigint;
  minHighRealSol: bigint;
  strongRealSol: bigint;
  flowTrades: number;
  minBuys: number;
  lastMustBeBuy: boolean;
  minNetFlow: bigint;
  tranche: bigint;
  maxPosition: bigint;
  probeTranche: bigint;
  probeMaxPosition: bigint;
  maxProbeOpen: number;
  minBuy: bigint;
  addBand: number;
  takeProfit: number;
  stopLoss: number;
  maxHoldSlots: number;
  cooldownSlots: number;
  buySlippageBps: number;
  sellSlippageBps: number;
  maxEntriesPerBatch: number;
  maxOpen: number;
  skipDevSold: boolean;
  firstTranche: bigint;
  sellSplits: number;
}

export const DEFAULT_PARAMS: DipParams = {
  highWindow: 1500,
  dipMin: 0.3,
  dipMax: 0.45,
  probeDipMin: 0.2,
  probeDipMax: 0.6,
  minRealSol: 3n * SOL,
  minHighRealSol: 20n * SOL,
  strongRealSol: 15n * SOL,
  flowTrades: 6,
  minBuys: 5,
  lastMustBeBuy: true,
  minNetFlow: 0n,
  tranche: 350_000_000n,
  maxPosition: 2_500_000_000n,
  probeTranche: 80_000_000n,
  probeMaxPosition: 150_000_000n,
  maxProbeOpen: 3,
  minBuy: 8_000_000n,
  addBand: 0.3,
  takeProfit: 0.4,
  stopLoss: 0.25,
  maxHoldSlots: 450,
  cooldownSlots: 200,
  buySlippageBps: 500,
  sellSlippageBps: 3000,
  maxEntriesPerBatch: 2,
  maxOpen: 5,
  skipDevSold: true,
  firstTranche: 50_000_000n,
  sellSplits: 2,
};

interface Tick {
  slot: number;
  price: number;
  realSol: bigint;
  isBuy: boolean;
  sol: bigint;
}

type Tier = 'strong' | 'probe';

interface CoinState {
  creator: string | null;
  devSold: boolean;
  complete: boolean;
  tape: Tick[];
  firstPrice: number | null;
  firstSlot: number | null;
  spent: bigint;
  tier: Tier | null;
  blockedUntil: number;
  selling: boolean;
}

interface PendingInfo {
  mint: string;
  side: 'buy' | 'sell';
  quote: bigint;
}

/** Build the bot: onBatch(state, batch) returns this batch's orders. */
export function createDipBot(params: DipParams = DEFAULT_PARAMS) {
  const coins = new Map<string, CoinState>();
  const pending = new Map<string, PendingInfo>();
  let orderSeq = 0;

  function coinFor(mint: string): CoinState {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        creator: null,
        devSold: false,
        complete: false,
        tape: [],
        firstPrice: null,
        firstSlot: null,
        spent: 0n,
        tier: null,
        blockedUntil: 0,
        selling: false,
      };
      coins.set(mint, c);
    }
    return c;
  }

  function priceOf(vq: bigint, vt: bigint): number {
    if (vt === 0n) return 0;
    return Number(vq) / Number(vt);
  }

  /** Tokens sold at the current virtual reserves, after the 125 bps curve fee. */
  function quoteOut(tokens: bigint, vq: bigint, vt: bigint): bigint {
    if (tokens === 0n || vq === 0n || vt === 0n) return 0n;
    const gross = (tokens * vq) / (vt + tokens);
    return gross - (gross * CURVE_FEE_BPS) / BPS_DENOM;
  }

  function pendingBuy(mint: string): boolean {
    for (const p of pending.values()) if (p.mint === mint && p.side === 'buy') return true;
    return false;
  }

  function pendingSell(mint: string): boolean {
    for (const p of pending.values()) if (p.mint === mint && p.side === 'sell') return true;
    return false;
  }

  function nextId(kind: 'b' | 's'): string {
    orderSeq += 1;
    return `${kind}${orderSeq}`;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const now = state.slot;
      const txFee = state.txFeeLamports();
      const maxOrders = state.hello.caps.max_orders_per_batch;
      let freeCash = state.freeCashLamports();
      const touched = new Set<string>();

      // 1. Ingest this batch's events: creators, ticks, completions.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coinFor(e.mint).creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const c = coinFor(e.mint);
          touched.add(e.mint);
          if (c.creator === null) c.creator = e.creator;
          if (!e.is_buy && c.creator !== null && e.user === c.creator) c.devSold = true;
          c.tape.push({
            slot: e.slot,
            price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
            realSol: BigInt(e.real_quote_reserves),
            isBuy: e.is_buy,
            sol: BigInt(e.sol_amount),
          });
          if (c.tape.length > 400) c.tape.splice(0, c.tape.length - 400);
        } else {
          const c = coinFor(e.mint);
          c.complete = true;
          touched.add(e.mint);
        }
      }

      // 2. Process fills: resolve pending orders, forget failed entries,
      // cool down mints whose position fully closed.
      for (const f of batch.fills) {
        const info = pending.get(f.client_id);
        if (info !== undefined) {
          pending.delete(f.client_id);
          const c = coins.get(info.mint);
          if (c !== undefined) {
            if (info.side === 'buy' && f.status !== 'filled') {
              c.spent -= info.quote;
              if (c.spent < 0n) c.spent = 0n;
              if (!state.positions.has(info.mint) && !pendingBuy(info.mint) && c.spent === 0n) {
                c.firstPrice = null;
                c.firstSlot = null;
                c.tier = null;
              }
            }
            if (info.side === 'sell' && !pendingSell(info.mint)) c.selling = false;
          }
        }
        if (f.side === 'sell') {
          const c = coins.get(f.mint);
          if (c !== undefined) {
            if (!state.positions.has(f.mint)) {
              c.spent = 0n;
              c.firstPrice = null;
              c.firstSlot = null;
              c.tier = null;
              c.blockedUntil = now + params.cooldownSlots;
              c.selling = false;
            } else if (!pendingSell(f.mint)) {
              c.selling = false;
            }
          }
        }
      }

      // Latest reserves per mint: batch marks first, curve state otherwise.
      const marks = new Map<string, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, {
          vq: BigInt(m.virtual_quote_reserves),
          vt: BigInt(m.virtual_token_reserves),
        });
      }
      const reservesOf = (mint: string): { vq: bigint; vt: bigint } | null => {
        const mark = marks.get(mint);
        if (mark !== undefined) return mark;
        const curve = state.curves.get(mint);
        if (curve === undefined) return null;
        return { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
      };

      // 3. Exits and adds on held positions, in sorted mint order.
      const held = [...state.positions.keys()].sort();
      for (const mint of held) {
        if (orders.length >= maxOrders) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const c = coins.get(mint);
        if (c === undefined) continue;
        if (c.selling || pendingSell(mint)) continue;
        const res = reservesOf(mint);
        if (res === null) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        const value = quoteOut(pos.token_amount, res.vq, res.vt);
        const cost = pos.cost_lamports;
        const takeProfit = value * 100n >= cost * BigInt(Math.round((1 + params.takeProfit) * 100));
        const stopLoss = value * 100n <= cost * BigInt(Math.round((1 - params.stopLoss) * 100));
        const stale = c.firstSlot !== null && now - c.firstSlot >= params.maxHoldSlots;
        if (takeProfit || stopLoss || stale) {
          // Exit: sell the whole position, split into equal sells in one reply.
          const splits = params.sellSplits;
          const base = pos.token_amount / BigInt(splits);
          const parts: bigint[] = [];
          if (base === 0n) {
            parts.push(pos.token_amount);
          } else {
            for (let i = 0; i < splits; i++) {
              parts.push(i < splits - 1 ? base : pos.token_amount - base * BigInt(splits - 1));
            }
          }
          for (const amount of parts) {
            if (orders.length >= maxOrders) break;
            if (amount <= 0n) continue;
            const id = nextId('s');
            orders.push({
              side: 'sell',
              client_id: id,
              mint,
              token_amount: amount.toString(),
              max_slippage_bps: params.sellSlippageBps,
            });
            pending.set(id, { mint, side: 'sell', quote: 0n });
            freeCash -= txFee;
          }
          c.selling = true;
          continue;
        }
        // Otherwise consider adding a tranche while price stays near entry.
        if (pendingBuy(mint)) continue;
        if (c.firstPrice === null || c.tier === null) continue;
        const price = priceOf(res.vq, res.vt);
        if (Math.abs(price / c.firstPrice - 1) > params.addBand) continue;
        const tranche = c.tier === 'strong' ? params.tranche : params.probeTranche;
        const maxPos = c.tier === 'strong' ? params.maxPosition : params.probeMaxPosition;
        const cap = (state.maxBuyLamports(mint) * 97n) / 100n;
        let amount = tranche;
        const room = maxPos - c.spent;
        if (room < amount) amount = room;
        if (cap < amount) amount = cap;
        if (amount < params.minBuy) continue;
        if (amount + txFee > freeCash) continue;
        const id = nextId('b');
        orders.push({
          side: 'buy',
          client_id: id,
          mint,
          quote_lamports: amount.toString(),
          max_slippage_bps: params.buySlippageBps,
        });
        pending.set(id, { mint, side: 'buy', quote: amount });
        c.spent += amount;
        freeCash -= amount + txFee;
      }

      // 4. New entries on coins that traded this batch, sorted mint order.
      let entries = 0;
      const candidates = [...touched].sort();
      for (const mint of candidates) {
        if (entries >= params.maxEntriesPerBatch) break;
        if (orders.length >= maxOrders) break;
        if (state.positions.has(mint) || pendingBuy(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const c = coins.get(mint);
        if (c === undefined || c.complete) continue;
        if (now < c.blockedUntil) continue;
        if (params.skipDevSold && c.devSold) continue;
        if (state.committedPositionCount() + entries >= params.maxOpen) break;
        if (c.tape.length < params.flowTrades) continue;
        const last = c.tape[c.tape.length - 1];
        if (last.realSol < params.minRealSol) continue;
        const strong = last.realSol >= params.strongRealSol;
        if (!strong) {
          // Probe tier: at most maxProbeOpen probe positions at once.
          let probes = 0;
          for (const m of state.positions.keys()) {
            const pc = coins.get(m);
            if (pc !== undefined && pc.tier === 'probe') probes += 1;
          }
          for (const p of pending.values()) {
            if (p.side !== 'buy') continue;
            const pc = coins.get(p.mint);
            if (pc !== undefined && pc.tier === 'probe') probes += 1;
          }
          if (probes >= params.maxProbeOpen) continue;
        }
        // Recent high within the window, and the reserves behind that high.
        const windowStart = now - params.highWindow;
        let high = 0;
        let highReal = 0n;
        let highFound = false;
        for (const t of c.tape) {
          if (t.slot < windowStart) continue;
          if (!highFound || t.price > high) {
            high = t.price;
            highReal = t.realSol;
            highFound = true;
          }
        }
        if (!highFound || high <= 0 || highReal < params.minHighRealSol) continue;
        const dip = 1 - last.price / high;
        const dipMin = strong ? params.dipMin : params.probeDipMin;
        const dipMax = strong ? params.dipMax : params.probeDipMax;
        if (dip < dipMin || dip > dipMax) continue;
        // Flow: buyers still stepping in hard over the last few trades.
        const recent = c.tape.slice(-params.flowTrades);
        let buys = 0;
        let net = 0n;
        for (const t of recent) {
          if (t.isBuy) {
            buys += 1;
            net += t.sol;
          } else {
            net -= t.sol;
          }
        }
        if (buys < params.minBuys) continue;
        if (params.lastMustBeBuy && !recent[recent.length - 1].isBuy) continue;
        if (net < params.minNetFlow) continue;
        const cap = (state.maxBuyLamports(mint) * 97n) / 100n;
        let amount = params.firstTranche;
        if (cap < amount) amount = cap;
        if (amount < params.minBuy) continue;
        if (amount + txFee > freeCash) continue;
        const id = nextId('b');
        orders.push({
          side: 'buy',
          client_id: id,
          mint,
          quote_lamports: amount.toString(),
          max_slippage_bps: params.buySlippageBps,
        });
        pending.set(id, { mint, side: 'buy', quote: amount });
        c.firstPrice = last.price;
        c.firstSlot = now;
        c.spent = amount;
        c.tier = strong ? 'strong' : 'probe';
        freeCash -= amount + txFee;
        entries += 1;
      }

      return orders;
    },
  };
}
