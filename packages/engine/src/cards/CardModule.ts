/**
 * The card plugin interface (ARCHITECTURE.md §3).
 *
 * The engine core knows nothing about loans, insurance, corporations, or
 * rebates. It knows only that cards exist, and it dispatches lifecycle hooks
 * to whichever modules are registered. Each card type is a module implementing
 * this interface; card *instances* carry their own typed state.
 *
 * Modules never mutate GameState. They read it (via ctx / arguments) and return
 * GameEvent[]; the engine appends those events through the same choke point as
 * everything else, so the money-conservation invariant is preserved.
 */
import type { GameEvent, PlayerId, Account, PaymentReason } from "../core/events.js";
import type { GameState } from "../core/state.js";

export type CardKind = "loan" | "insurance" | "corporation" | "rebate";

export type CardId = string;

/** Who can own a card: a player, or the bank (e.g. a bank-issued loan). */
export type Owner = Account;

/** A live card instance in the game. `state` is the module-specific payload. */
export interface Card<TCardState = unknown> {
  readonly id: CardId;
  readonly kind: CardKind;
  readonly owner: Owner;      // holder of the card (the creditor, for loans)
  readonly subject: PlayerId; // the player the card acts upon (the borrower, for loans)
  readonly state: TCardState;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export const valid: ValidationResult = { ok: true };
export const invalid = (error: string): ValidationResult => ({ ok: false, error });

/**
 * Context handed to modules. Read-only view of the world plus small helpers to
 * mint event objects. Modules push events onto the array they return; the
 * engine is responsible for appending + folding them.
 */
export interface EngineContext {
  readonly state: GameState;
  /** Allocate a deterministic, replay-stable card id. */
  nextCardId(kind: CardKind): CardId;
  /** Build a MoneyTransferred event (does not append it). */
  transfer(from: Account, to: Account, amount: number, reason: PaymentReason, memo?: string): GameEvent;
}

/** A pending obligation the engine is about to charge a player (for onPaymentDue). */
export interface PendingPayment {
  from: PlayerId;
  to: Account;
  amount: number;
  reason: PaymentReason;
}

/** How a module wants to modify a pending payment (insurance uses this in M3). */
export interface PaymentModifier {
  events: GameEvent[];
  newAmount: number;
}

/** A claim a module registers against a bankrupt player's estate. */
export interface BankruptcyClaim {
  cardId: CardId;
  creditor: Account;
  priority: number;
}

export interface CardModule<TCardState = unknown> {
  readonly kind: CardKind;

  /** Bankruptcy waterfall position (RULES §8.1): loan=1, insurance=2, rebate=3, corporation=4. */
  readonly priority: number;

  // --- Creation ---
  validateCreate(params: unknown, state: GameState): ValidationResult;
  onCreate(params: unknown, ctx: EngineContext): GameEvent[];

  // --- Lifecycle hooks (implement only the ones this card cares about) ---
  onPassGo?(card: Card<TCardState>, passer: PlayerId, ctx: EngineContext): GameEvent[];
  onLandOnTile?(card: Card<TCardState>, lander: PlayerId, tile: number, ctx: EngineContext): GameEvent[];
  onPaymentDue?(card: Card<TCardState>, payment: PendingPayment, ctx: EngineContext): PaymentModifier | null;
  onBankruptcy?(card: Card<TCardState>, bankrupt: PlayerId, ctx: EngineContext): BankruptcyClaim | null;
  onTransfer?(card: Card<TCardState>, from: Owner, to: Owner, ctx: EngineContext): GameEvent[];
}
