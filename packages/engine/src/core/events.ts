/**
 * The event vocabulary. The event log is the single source of truth;
 * GameState is a pure fold over this list. Events record facts, never intents.
 */
export type PlayerId = string;
export type Account = PlayerId | "bank";

export type Phase =
  | "awaitRoll"       // current player must roll (or resolve jail first)
  | "awaitPurchase"   // current player must Buy or DeclineBuy the tile they landed on
  | "auction"         // an auction is in progress
  | "awaitEnd"        // roll resolved; management actions allowed; EndTurn (or roll again on doubles)
  | "liquidation"     // one or more players owe more than their cash
  | "gameOver";

export type PaymentReason =
  | "salary" | "purchase" | "rent" | "tax" | "card"
  | "jailFine" | "houseBuild" | "houseSale" | "mortgage" | "unmortgage"
  | "auction" | "debtSettlement" | "bankruptcyTransfer";

export type GameEvent =
  | { type: "GameStarted"; players: { id: PlayerId; name: string }[]; seed: number; startingCash: number }
  | { type: "TurnStarted"; player: PlayerId; turn: number }
  | { type: "DiceRolled"; player: PlayerId; d1: number; d2: number }
  | { type: "SpeedingToJail"; player: PlayerId } // third consecutive doubles
  | { type: "TokenMoved"; player: PlayerId; from: number; to: number; passedGo: boolean }
  | { type: "MoneyTransferred"; from: Account; to: Account; amount: number; reason: PaymentReason; memo?: string }
  | { type: "PropertyPurchased"; player: PlayerId; tile: number; price: number }
  | { type: "PurchaseDeclined"; player: PlayerId; tile: number }
  | { type: "AuctionStarted"; tile: number; bidders: PlayerId[] }
  | { type: "BidPlaced"; player: PlayerId; amount: number }
  | { type: "AuctionPassed"; player: PlayerId }
  | { type: "AuctionWon"; player: PlayerId; tile: number; price: number }
  | { type: "AuctionAbandoned"; tile: number } // everyone passed
  | { type: "CardDrawn"; player: PlayerId; deck: "chance" | "chest"; cardId: string; text: string }
  | { type: "JailCardGranted"; player: PlayerId; deck: "chance" | "chest" }
  | { type: "JailCardUsed"; player: PlayerId; deck: "chance" | "chest" }
  | { type: "SentToJail"; player: PlayerId }
  | { type: "LeftJail"; player: PlayerId; via: "fine" | "card" | "doubles" | "forcedFine" }
  | { type: "JailTurnServed"; player: PlayerId; attempt: number }
  | { type: "HouseBuilt"; player: PlayerId; tile: number } // 5th build = hotel
  | { type: "HouseSold"; player: PlayerId; tile: number }
  | { type: "PropertyMortgaged"; player: PlayerId; tile: number }
  | { type: "PropertyUnmortgaged"; player: PlayerId; tile: number }
  | { type: "UtilityRolled"; player: PlayerId; d1: number; d2: number } // "pay 10x dice" card roll
  | { type: "PurchasePending"; player: PlayerId; tile: number }
  | { type: "PhaseSet"; phase: Phase } // routed to resumePhase while debts are outstanding
  | { type: "DebtRecorded"; debtor: PlayerId; creditor: Account; amount: number; reason: PaymentReason }
  | { type: "DebtSettled"; debtor: PlayerId; creditor: Account; amount: number }
  | { type: "PropertyTransferred"; tile: number; from: PlayerId; to: Account; mortgaged: boolean }
  | { type: "PlayerBankrupted"; player: PlayerId; creditor: Account }
  | { type: "TurnEnded"; player: PlayerId }
  | { type: "GameEnded"; winner: PlayerId };
