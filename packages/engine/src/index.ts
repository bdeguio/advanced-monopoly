export { Game, computeRent, type Command, type Result } from "./core/engine.js";
export type { GameEvent, PlayerId, Account, PaymentReason, Phase, CardSnapshot } from "./core/events.js";
export {
  project, reduce, currentPlayer, alivePlayers, deckCardAt,
  type GameState, type PlayerState, type PropertyState, type AuctionState, type DebtState,
} from "./core/state.js";
export {
  TILES, GO_POS, JAIL_POS, GO_SALARY, JAIL_FINE, BOARD_SIZE,
  HOUSE_SUPPLY, HOTEL_SUPPLY, PURCHASABLE, RAILROAD_TILES, UTILITY_TILES,
  mortgageValue, groupTiles, type Tile, type ColorGroup,
} from "./board/tiles.js";
export { CHANCE_DECK, CHEST_DECK, type DeckCard } from "./board/cards.js";

// M2: card plugin layer
export { CardRegistry, cardsOfKind, GO_ORDER } from "./cards/registry.js";
export type {
  CardModule, Card, CardId, CardKind, Owner, EngineContext,
  ValidationResult, PendingPayment, PaymentModifier, BankruptcyClaim,
} from "./cards/CardModule.js";
export {
  LoanModule, borrowingBase, outstandingPrincipal,
  type LoanState, type CreateLoanParams,
} from "./cards/loan/module.js";
export { CARD_COST, INTEREST_RATE } from "./core/constants.js";
export { Game, computeRent, type Command, type Result } from "./core/engine.js";
export type { GameEvent, PlayerId, Account, PaymentReason, Phase } from "./core/events.js";
export {
  project, reduce, currentPlayer, alivePlayers, deckCardAt,
  type GameState, type PlayerState, type PropertyState, type AuctionState, type DebtState,
} from "./core/state.js";
export {
  TILES, GO_POS, JAIL_POS, GO_SALARY, JAIL_FINE, BOARD_SIZE,
  HOUSE_SUPPLY, HOTEL_SUPPLY, PURCHASABLE, RAILROAD_TILES, UTILITY_TILES,
  mortgageValue, groupTiles, type Tile, type ColorGroup,
} from "./board/tiles.js";
export { CHANCE_DECK, CHEST_DECK, type DeckCard } from "./board/cards.js";
