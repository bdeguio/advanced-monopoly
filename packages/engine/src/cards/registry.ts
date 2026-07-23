/**
 * Card module registry + hook dispatch.
 *
 * The registry is the ONLY place the engine reaches into card behavior. It:
 *   - holds the set of registered CardModules keyed by kind,
 *   - dispatches lifecycle hooks over the live cards in creation order,
 *   - resolves the RULES §7 GO order-of-operations by iterating card kinds in
 *     waterfall/priority order (loans before everything else).
 *
 * Adding card type #5 = register one module here (or via register); no engine
 * core changes.
 */
import type { CardModule, EngineContext, Card, CardKind, BankruptcyClaim } from "./CardModule.js";
import type { GameEvent, PlayerId } from "../core/events.js";
import type { GameState } from "../core/state.js";
import { LoanModule } from "./loan/module.js";

/** Kinds in RULES §7 / §8.1 processing order. Loans always resolve first. */
export const GO_ORDER: readonly CardKind[] = ["loan", "insurance", "corporation", "rebate"];

export class CardRegistry {
  private modules = new Map<CardKind, CardModule>();

  constructor(modules: CardModule[] = [new LoanModule()]) {
    for (const m of modules) this.modules.set(m.kind, m);
  }

  register(module: CardModule): void {
    this.modules.set(module.kind, module);
  }

  get(kind: CardKind): CardModule | undefined {
    return this.modules.get(kind);
  }

  validateCreate(kind: CardKind, params: unknown, state: GameState) {
    const m = this.modules.get(kind);
    if (!m) return { ok: false, error: `unknown card kind ${kind}` };
    return m.validateCreate(params, state);
  }

  onCreate(kind: CardKind, params: unknown, ctx: EngineContext): GameEvent[] {
    const m = this.modules.get(kind);
    if (!m) throw new Error(`unknown card kind ${kind}`);
    return m.onCreate(params, ctx);
  }

  /**
   * RULES §7: resolve every card obligation triggered when `passer` passes GO,
   * in kind-priority order (loans first). Returns the events to append, in
   * order. The engine appends them one at a time so each fold can surface a
   * DebtRecorded and route into liquidation mid-sequence if needed.
   */
  collectPassGo(state: GameState, passer: PlayerId, ctx: EngineContext): GameEvent[] {
    const out: GameEvent[] = [];
    for (const kind of GO_ORDER) {
      const m = this.modules.get(kind);
      if (!m?.onPassGo) continue;
      for (const card of cardsOfKind(state, kind)) {
        if (card.subject !== passer) continue;
        out.push(...m.onPassGo(card, passer, ctx));
      }
    }
    return out;
  }

  /** RULES §8.1: claims against a bankrupt estate, sorted by waterfall priority. */
  collectBankruptcyClaims(state: GameState, bankrupt: PlayerId, ctx: EngineContext): BankruptcyClaim[] {
    const claims: BankruptcyClaim[] = [];
    for (const kind of GO_ORDER) {
      const m = this.modules.get(kind);
      if (!m?.onBankruptcy) continue;
      for (const card of cardsOfKind(state, kind)) {
        const claim = m.onBankruptcy(card, bankrupt, ctx);
        if (claim) claims.push(claim);
      }
    }
    return claims.sort((a, b) => a.priority - b.priority);
  }
}

/** All live cards of a kind, in creation order. */
export function cardsOfKind(state: GameState, kind: CardKind): Card[] {
  return state.cards.filter((c) => c.kind === kind);
}
