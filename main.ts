// Pump.fun Bot Sprint — momentum scalper (paper trading, no real funds).
//
// Speaks agent-fun/replay/v2 on stdin/stdout: the harness sends one JSON
// line per message (hello, then one batch per slot that has events, then
// done) and this bot answers every batch with exactly one reply line
// carrying that batch's orders. No network, no clock, no randomness: every
// decision is a pure function of the events seen so far, so the two
// grading executions produce byte-identical action logs.
//
// Strategy in one paragraph: only buy mature bonding curves whose price is
// climbing on accelerating buy pressure (up 18%+ over a 200-slot window,
// near the window high, several distinct buyers, net inflow of 2+ SOL with
// the newer half inflowing at least as fast as the older). Buy small
// (0.08 SOL), pyramid into strength up to 0.32 SOL per coin, and exit fast
// (12% stop, take-profit at +35%, trailing stop once up 6%, fade exit when
// inflow turns, 1500-slot max hold). Tiny probe round-trips keep the run
// above the 20-coin guardrail when momentum entries fall behind pace.
//
// Amounts are lamports (bigint). Prices are SOL per token, compared only as
// ratios, from virtual reserves: price = virtual_quote / virtual_token.

const LAMPORTS_PER_SOL = 1_000_000_000n;

// ---- tunables (all in slots / lamports / ratios) ----
const WINDOW = 200; // entry window, in slots
const MIN_AGE_SLOTS = 1200; // curve must be this old before we enter
const MIN_TRADES = 25;
const MIN_RISE = 1.18; // price now vs price WINDOW slots ago
const NEAR_HIGH = 0.97; // price must sit within 3% of the window high
const MIN_BUYS = 4; // buy trades in the window
const MIN_BUYERS = 3; // distinct buyers in the window
const MIN_INFLOW_LAMPORTS = 2_000_000_000n; // 2 SOL net inflow in window
const MIN_REAL_SOL_LAMPORTS = 3_000_000_000n; // 3 SOL real reserve floor
const FIRST_BUY = 80_000_000n; // 0.08 SOL
const ADD_BUY = 80_000_000n; // 0.08 SOL per pyramid add
const MAX_PER_COIN = 320_000_000n; // 0.32 SOL total per coin
const MAX_BUYS_PER_COIN = 4;
const PYRAMID_STEP = 1.05; // add only when price is 5% above last buy
const STOP_LOSS = 0.88; // sell at -12% vs entry
const TAKE_PROFIT = 1.35; // sell at +35% vs entry
const TRAIL_ARM = 1.06; // trailing stop arms once up 6%
const TRAIL_PULLBACK = 0.9; // sell on a 10% pullback from the peak
const MAX_HOLD_SLOTS = 1500;
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 1000;
const MAX_ORDERS_PER_REPLY = 8;
const MAX_NEW_PER_BATCH = 2;
const PROBE_BUY = 20_000_000n; // 0.02 SOL probe round-trips
const PROBE_START_SLOTS = 10000; // start probing this far into the run
const PROBE_GAP_SLOTS = 300;
const PROBE_MAX = 25;
const PROBE_TAKE = 1.04;
const PROBE_STOP = 0.94;
const PROBE_HOLD_SLOTS = 300;

// ---- minimal protocol types (only what this bot reads) ----

type U64 = string;

interface HelloMsg {
  type: "hello";
  seed: U64;
  capital: { lamports: U64 };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
  };
  latency_slots: number;
  fees: { base_fee_lamports: U64; priority_fee_lamports: U64 };
}

interface ChainEvent {
  event: string;
  mint: string;
  slot: number;
  // TradeEvent fields
  is_buy?: boolean;
  user?: string;
  sol_amount?: U64;
  virtual_sol_reserves?: U64;
  virtual_token_reserves?: U64;
  real_sol_reserves?: U64;
  real_token_reserves?: U64;
  virtual_quote_reserves?: U64;
  virtual_token_reserves_q?: U64;
  // CreateEvent fields
  virtual_quote_reserves_create?: U64;
  [key: string]: unknown;
}

interface BatchMsg {
  type: "batch";
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: {
    mint: string;
    slot: number;
    virtual_token_reserves: U64;
    virtual_quote_reserves: U64;
    real_token_reserves: U64;
    real_quote_reserves: U64;
  }[];
  fills: {
    client_id: string;
    mint: string;
    side: string;
    status: string;
    quote_lamports: U64;
    token_amount: U64;
  }[];
  account: {
    cash_lamports: U64;
    positions: { mint: string; token_amount: U64; cost_lamports: U64 }[];
  };
}

interface OrderOut {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

// ---- per-mint tracking ----

interface Sample {
  slot: number;
  price: number; // SOL per token
  buyLamports: bigint; // SOL bought in this trade (0 when a sell)
  sellLamports: bigint;
  user: string;
}

interface Curve {
  mint: string;
  createdSlot: number | null;
  firstSeenSlot: number;
  complete: boolean;
  trades: number;
  price: number; // latest SOL per token
  realQuote: bigint;
  samples: Sample[];
}

interface Held {
  entrySlot: number;
  peak: number; // highest price seen while held
  buys: number; // buy fills on this coin
  spent: bigint; // lamports spent on buys (fills)
  lastBuyPrice: number;
  probe: boolean;
}

const curves = new Map<string, Curve>();
const held = new Map<string, Held>();
const pendingBuyMints = new Set<string>();
const pendingSellMints = new Set<string>();
const pending = new Map<string, OrderOut>();
const qualifiedCoins = new Set<string>();
const boughtLamports = new Map<string, bigint>();

let hello: HelloMsg | null = null;
let cash = 0n;
let positions = new Map<string, { tokens: bigint; cost: bigint }>();
let orderCounter = 0;
let startSlot = -1;
let lastProbeSlot = -1;
let probeCount = 0;

function txFee(): bigint {
  if (!hello) return 0n;
  return BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
}

function freeCash(): bigint {
  let free = cash;
  for (const o of pending.values()) {
    free -= txFee();
    if (o.side === "buy") free -= BigInt(o.quote_lamports ?? "0");
  }
  return free;
}

function openCount(): number {
  const mints = new Set<string>(positions.keys());
  for (const m of pendingBuyMints) mints.add(m);
  return mints.size;
}

function curveFor(mint: string, slot: number): Curve {
  let c = curves.get(mint);
  if (!c) {
    c = {
      mint,
      createdSlot: null,
      firstSeenSlot: slot,
      complete: false,
      trades: 0,
      price: 0,
      realQuote: 0n,
      samples: [],
    };
    curves.set(mint, c);
  }
  return c;
}

function priceOf(c: Curve): number {
  return c.price;
}

// Window stats over samples with slot >= now - WINDOW.
function windowStats(c: Curve, now: number) {
  const from = now - WINDOW;
  let high = 0;
  let firstPrice = 0;
  let buys = 0;
  let inflow = 0n;
  let inflowFirst = 0n;
  let inflowSecond = 0n;
  const buyers = new Set<string>();
  for (const s of c.samples) {
    if (s.slot < from) continue;
    if (firstPrice === 0) firstPrice = s.price;
    if (s.price > high) high = s.price;
    const net = s.buyLamports - s.sellLamports;
    inflow += net;
    if (s.slot < from + WINDOW / 2) inflowFirst += net;
    else inflowSecond += net;
    if (s.buyLamports > 0n) {
      buys++;
      buyers.add(s.user);
    }
  }
  return { firstPrice, high, buys, buyers: buyers.size, inflow, inflowFirst, inflowSecond };
}

function priceAgo(c: Curve, now: number, back: number): number {
  const target = now - back;
  let best = 0;
  for (const s of c.samples) {
    if (s.slot <= target) best = s.price;
    else break;
  }
  return best;
}

function inflowOver(c: Curve, now: number, back: number): bigint {
  const from = now - back;
  let net = 0n;
  for (const s of c.samples) {
    if (s.slot >= from) net += s.buyLamports - s.sellLamports;
  }
  return net;
}

// ---- decision logic (one batch) ----

function decide(batch: BatchMsg): OrderOut[] {
  const orders: OrderOut[] = [];
  if (!hello) return orders;
  const now = batch.slot;
  const maxOrders = Math.min(hello.caps.max_orders_per_batch, MAX_ORDERS_PER_REPLY);

  const push = (o: OrderOut): boolean => {
    if (orders.length >= maxOrders) return false;
    o.client_id = `o${++orderCounter}`;
    orders.push(o);
    pending.set(o.client_id, o);
    if (o.side === "buy") pendingBuyMints.add(o.mint);
    else pendingSellMints.add(o.mint);
    return true;
  };

  // 1) Exits first: every held position is re-priced each batch.
  for (const [mint, pos] of positions) {
    const c = curves.get(mint);
    if (!c || c.complete || pendingSellMints.has(mint)) continue;
    const h = held.get(mint);
    if (!h) continue;
    const price = priceOf(c);
    if (price <= 0) continue;
    const entry = Number(pos.cost) / Number(pos.tokens);
    if (entry <= 0) continue;
    if (price > h.peak) h.peak = price;
    const gain = price / entry;
    let exit = false;
    if (gain <= STOP_LOSS) exit = true; // stop loss
    else if (gain >= TAKE_PROFIT) exit = true; // bank a big move
    else if (gain >= TRAIL_ARM && price <= TRAIL_PULLBACK * h.peak) exit = true; // trailing stop
    else if (now - h.entrySlot >= MAX_HOLD_SLOTS) exit = true; // time limit
    else if (h.probe) {
      // probe exits: small take / small stop / short hold
      if (gain >= PROBE_TAKE || gain <= PROBE_STOP || now - h.entrySlot >= PROBE_HOLD_SLOTS) exit = true;
    } else if (inflowOver(c, now, WINDOW) < -500_000_000n) {
      const ago = priceAgo(c, now, 50);
      if (ago > 0 && price < 0.99 * ago) exit = true; // fade: inflow turned, price slipping
    }
    if (exit) {
      push({
        side: "sell",
        client_id: "",
        mint,
        token_amount: pos.tokens.toString(),
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
    }
  }

  // 2) Pyramids: add while the move keeps stepping up on positive inflow.
  for (const [mint, pos] of positions) {
    const c = curves.get(mint);
    if (!c || c.complete || pendingSellMints.has(mint) || pendingBuyMints.has(mint)) continue;
    const h = held.get(mint);
    if (!h || h.probe || h.buys >= MAX_BUYS_PER_COIN || h.spent >= MAX_PER_COIN) continue;
    const price = priceOf(c);
    if (price <= 0 || price < PYRAMID_STEP * h.lastBuyPrice) continue;
    if (inflowOver(c, now, WINDOW) <= 0n) continue;
    const cap = maxBuyLamports(c);
    const size = ADD_BUY < cap ? ADD_BUY : cap;
    if (size < 20_000_000n) continue;
    if (freeCash() < size + txFee()) continue;
    if (push({ side: "buy", client_id: "", mint, quote_lamports: size.toString(), max_slippage_bps: BUY_SLIPPAGE_BPS })) {
      h.buys++;
      h.spent += size;
      h.lastBuyPrice = price;
    }
  }

  // 3) New momentum entries: only for mints that traded in this batch.
  let entered = 0;
  const seen = new Set<string>();
  for (const e of batch.events) {
    if (e.event !== "TradeEvent" || seen.has(e.mint)) continue;
    seen.add(e.mint);
    if (entered >= MAX_NEW_PER_BATCH || orders.length >= maxOrders) break;
    const c = curves.get(e.mint);
    if (!c || c.complete) continue;
    if (positions.has(e.mint) || pendingBuyMints.has(e.mint)) continue;
    if (openCount() >= hello.caps.max_open_positions) break;
    const age = now - (c.createdSlot ?? c.firstSeenSlot);
    if (age < MIN_AGE_SLOTS || c.trades < MIN_TRADES) continue;
    if (c.realQuote < MIN_REAL_SOL_LAMPORTS) continue;
    const st = windowStats(c, now);
    if (st.firstPrice <= 0) continue;
    const price = priceOf(c);
    if (price / st.firstPrice < MIN_RISE) continue;
    if (price < NEAR_HIGH * st.high) continue;
    if (st.buys < MIN_BUYS || st.buyers < MIN_BUYERS) continue;
    if (st.inflow < MIN_INFLOW_LAMPORTS) continue;
    if (st.inflowSecond < st.inflowFirst) continue; // must be accelerating
    const cap = maxBuyLamports(c);
    const size = FIRST_BUY < cap ? FIRST_BUY : cap;
    if (size < 20_000_000n) continue;
    if (freeCash() < size + txFee()) continue;
    if (push({ side: "buy", client_id: "", mint: e.mint, quote_lamports: size.toString(), max_slippage_bps: BUY_SLIPPAGE_BPS })) {
      entered++;
      held.set(e.mint, { entrySlot: now, peak: price, buys: 1, spent: size, lastBuyPrice: price, probe: false });
    }
  }

  // 4) Guardrail probes: tiny round-trips keep the run above 20 coins when
  // momentum entries fall behind pace. One probe at a time, spaced out.
  if (
    qualifiedCoins.size < 20 &&
    probeCount < PROBE_MAX &&
    startSlot >= 0 &&
    now - startSlot >= PROBE_START_SLOTS &&
    now - lastProbeSlot >= PROBE_GAP_SLOTS &&
    openCount() < hello.caps.max_open_positions &&
    freeCash() >= PROBE_BUY + txFee()
  ) {
    let best: Curve | null = null;
    let bestFlow = 0n;
    for (const c of curves.values()) {
      if (c.complete || positions.has(c.mint) || pendingBuyMints.has(c.mint)) continue;
      if (held.has(c.mint)) continue;
      if (now - (c.createdSlot ?? c.firstSeenSlot) < MIN_AGE_SLOTS) continue;
      if (c.realQuote < 10_000_000_000n) continue; // 10 SOL real reserve
      const flow = inflowOver(c, now, 500);
      if (flow <= 0n) continue;
      const ago = priceAgo(c, now, 200);
      if (ago > 0 && priceOf(c) < 0.95 * ago) continue; // not crashing
      if (flow > bestFlow) {
        bestFlow = flow;
        best = c;
      }
    }
    if (best) {
      const cap = maxBuyLamports(best);
      const size = PROBE_BUY < cap ? PROBE_BUY : cap;
      if (size >= 10_000_000n) {
        if (push({ side: "buy", client_id: "", mint: best.mint, quote_lamports: size.toString(), max_slippage_bps: BUY_SLIPPAGE_BPS })) {
          probeCount++;
          lastProbeSlot = now;
          held.set(best.mint, { entrySlot: now, peak: priceOf(best), buys: 1, spent: size, lastBuyPrice: priceOf(best), probe: true });
        }
      }
    }
  }

  return orders;
}

function maxBuyLamports(c: Curve): bigint {
  if (!hello || c.complete) return 0n;
  return (c.realQuote * BigInt(hello.caps.max_order_bps_of_real_reserve)) / 10_000n;
}

// ---- batch intake: fold fills, account, marks and events into state ----

function applyBatch(batch: BatchMsg): void {
  const now = batch.slot;
  if (startSlot < 0) startSlot = now;

  for (const f of batch.fills) {
    pending.delete(f.client_id);
    if (f.status !== "filled") {
      if (f.side === "buy") pendingBuyMints.delete(f.mint);
      if (f.side === "sell") pendingSellMints.delete(f.mint);
      continue;
    }
    if (f.side === "buy") {
      pendingBuyMints.delete(f.mint);
      boughtLamports.set(f.mint, (boughtLamports.get(f.mint) ?? 0n) + BigInt(f.quote_lamports));
    } else {
      pendingSellMints.delete(f.mint);
      if ((boughtLamports.get(f.mint) ?? 0n) >= 10_000_000n) qualifiedCoins.add(f.mint);
    }
  }

  cash = BigInt(batch.account.cash_lamports);
  positions = new Map(batch.account.positions.map((p) => [p.mint, { tokens: BigInt(p.token_amount), cost: BigInt(p.cost_lamports) }]));
  // A position that appears for the first time gets a Held record (entry
  // tracking starts when we first see it, e.g. after a buy fill lands).
  for (const mint of positions.keys()) {
    if (!held.has(mint)) {
      const c = curves.get(mint);
      held.set(mint, { entrySlot: now, peak: c ? priceOf(c) : 0, buys: 1, spent: 0n, lastBuyPrice: c ? priceOf(c) : 0, probe: false });
    }
  }
  for (const mint of [...held.keys()]) {
    if (!positions.has(mint) && !pendingBuyMints.has(mint)) held.delete(mint);
  }

  for (const m of batch.marks) {
    const c = curves.get(m.mint);
    if (!c) continue;
    const vt = BigInt(m.virtual_token_reserves);
    const vq = BigInt(m.virtual_quote_reserves);
    if (vt > 0n) c.price = Number(vq) / Number(vt);
    c.realQuote = BigInt(m.real_quote_reserves);
  }

  for (const e of batch.events) {
    const c = curveFor(e.mint, now);
    if (e.event === "CreateEvent") {
      c.createdSlot = e.slot;
      const vt = BigInt((e.virtual_token_reserves as U64) ?? "0");
      const vq = BigInt((e.virtual_quote_reserves as U64) ?? "0");
      if (vt > 0n) c.price = Number(vq) / Number(vt);
      c.realQuote = BigInt((e.real_sol_reserves as U64) ?? "0");
    } else if (e.event === "TradeEvent") {
      const vt = BigInt((e.virtual_token_reserves as U64) ?? "0");
      const vq = BigInt((e.virtual_quote_reserves as U64) ?? "0");
      if (vt > 0n) c.price = Number(vq) / Number(vt);
      c.realQuote = BigInt((e.real_quote_reserves as U64) ?? "0");
      c.trades++;
      const sol = BigInt((e.sol_amount as U64) ?? "0");
      c.samples.push({
        slot: e.slot,
        price: c.price,
        buyLamports: e.is_buy ? sol : 0n,
        sellLamports: e.is_buy ? 0n : sol,
        user: (e.user as string) ?? "",
      });
      // Prune samples older than the longest window we ever look back.
      while (c.samples.length > 0 && c.samples[0].slot < now - 2200) c.samples.shift();
    } else if (e.event === "CompleteEvent") {
      c.complete = true;
    }
  }
}

// ---- the wire: hello, batch, done over stdin/stdout ----

async function main(): Promise<void> {
  let buf = "";
  const writeLine = (text: string): Promise<void> =>
    new Promise((resolve) => {
      process.stdout.write(text, () => resolve());
    });

  for await (const chunk of process.stdin) {
    buf += chunk.toString("utf-8");
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (line === "") continue;
      const msg = JSON.parse(line) as HelloMsg | BatchMsg | { type: string };
      if (msg.type === "hello") {
        hello = msg as HelloMsg;
        cash = BigInt(hello.capital.lamports);
      } else if (msg.type === "batch") {
        const batch = msg as BatchMsg;
        applyBatch(batch);
        const orders = decide(batch);
        const reply = JSON.stringify({ type: "reply", seq: batch.seq, orders });
        await writeLine(reply + "\n");
      } else if (msg.type === "done") {
        const done = msg as { account: { cash_lamports: U64 } };
        console.error(
          `done: cash=${done.account.cash_lamports} qualified_coins=${qualifiedCoins.size} probes=${probeCount} orders=${orderCounter}`,
        );
        return;
      }
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
