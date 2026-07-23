/**
 * Bank Loan card (RULES §2.1).
 *
 *  - Creation costs $25 to the bank (RULES §1.1.2); principal is then minted
 *    from the infinite bank to the borrower.
 *  - Borrowing limit: a player's total outstanding bank principal may never
 *    exceed the total mortgage value of their UNMORTGAGED properties (§2.1.2).
 *  - Interest = 25% of the ORIGINAL principal, due every GO while any principal
 *    remains, calculated on the original amount, not the balance (§2.1.4).
 *  - Partial repayment allowed on the borrower's turn; the full 25% interest
 *    still accrues each GO until the principal hits zero (§2.1.5).
 *  - Failure to pay interest -> forced liquidation, then bankruptcy (§2.1.6),
 *    at waterfall priority 1 (§8.1).
 *
 * Money conservation: principal out (bank->borrower) at creation is matched by
 * repayments (borrower->bank); interest (borrower->bank) and the $25 fee
 * (borrower->bank) flow to the bank. All movement goes through MoneyTransferred,
 * so the smoke-test invariant stays balanced.
 */
import {
  type CardModule, type Card, type EngineContext, type BankruptcyClaim,
  type ValidationResult, valid, invalid,
} from "../CardModule.js";
import type { GameEvent, PlayerId } from "../../core/events.js";
import type { GameState } from "../../core/state.js";
import { mortgageValue } from "../../board/tiles.js";
import { INTEREST_RATE, CARD_COST } from "../../core/constants.js";

export interface LoanState {
  readonly principal: number;       // ORIGINAL principal (fixed; drives interest)
  readonly outstanding: number;     // remaining principal to repay
}

export interface CreateLoanParams {
  borrower: PlayerId;
  amount: number;
}

/** Mortgage value of a player's unmortgaged properties (the secured borrowing base). */
export function borrowingBase(state: GameState, player: PlayerId): number {
  let total = 0;
  for (const [t, prop] of Object.entries(state.properties)) {
    if (prop.owner !== player || prop.mortgaged) continue;
    total += mortgageValue(Number(t));
  }
  return total;
}

/** Sum of outstanding principal across a player's bank loans. */
export function outstandingPrincipal(state: GameState, player: PlayerId): number {
  return state.cards
    .filter((c) => c.kind === "loan" && c.subject === player)
    .reduce((a, c) => a + (c.state as LoanState).outstanding, 0);
}

function isCreateParams(p: unknown): p is CreateLoanParams {
  return (
    typeof p === "object" && p !== null &&
    typeof (p as CreateLoanParams).borrower === "string" &&
    typeof (p as CreateLoanParams).amount === "number"
  );
}

export class LoanModule implements CardModule<LoanState> {
  readonly kind = "loan" as const;
  readonly priority = 1;

  validateCreate(params: unknown, state: GameState): ValidationResult {
    if (!isCreateParams(params)) return invalid("malformed loan params");
    const { borrower, amount } = params;
    const p = state.players[borrower];
    if (!p) return invalid("unknown borrower");
    if (p.bankrupt) return invalid("bankrupt player cannot borrow");
    if (!Number.isInteger(amount) || amount <= 0) return invalid("loan amount must be a positive integer");
    if (p.cash < CARD_COST) return invalid(`need $${CARD_COST} to create a loan card`);
    const base = borrowingBase(state, borrower);
    const already = outstandingPrincipal(state, borrower);
    if (already + amount > base) {
      return invalid(
        `borrowing limit exceeded: $${already + amount} > $${base} (mortgage value of unmortgaged properties)`,
      );
    }
    return valid;
  }

  onCreate(params: unknown, ctx: EngineContext): GameEvent[] {
    const { borrower, amount } = params as CreateLoanParams;
    const id = ctx.nextCardId("loan");
    return [
      // $25 creation fee to the bank
      ctx.transfer(borrower, "bank", CARD_COST, "cardCreation", "loan card"),
      // the loan card comes into existence
      {
        type: "CardCreated",
        card: { id, kind: "loan", owner: "bank", subject: borrower, state: { principal: amount, outstanding: amount } },
      },
      // principal minted from the infinite bank to the borrower
      ctx.transfer("bank", borrower, amount, "loanPrincipal", `loan ${id}`),
    ];
  }

  /** RULES §7 step 2 + §2.1.4: charge 25% of ORIGINAL principal at every GO while principal remains. */
  onPassGo(card: Card<LoanState>, passer: PlayerId, ctx: EngineContext): GameEvent[] {
    if (card.subject !== passer) return [];
    if (card.state.outstanding <= 0) return [];
    const interest = Math.round(card.state.principal * INTEREST_RATE);
    if (interest <= 0) return [];
    return [
      { type: "InterestCharged", loanId: card.id, amount: interest },
      ctx.transfer(passer, card.owner, interest, "loanInterest", `loan ${card.id} interest`),
    ];
  }

  /** RULES §2.1.7 / §8.1: bank claims at priority 1 when the borrower goes bankrupt. */
  onBankruptcy(card: Card<LoanState>, bankrupt: PlayerId, _ctx: EngineContext): BankruptcyClaim | null {
    if (card.subject !== bankrupt || card.state.outstanding <= 0) return null;
    return { cardId: card.id, creditor: card.owner, priority: this.priority };
  }
}
