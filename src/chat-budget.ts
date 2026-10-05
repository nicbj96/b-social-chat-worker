/** Plan §9 P186–190 / M42 startbudget: en almindelig discoverytur bruger
 * højst to modelkald og ét embeddingkald. Capsne er ærlige: they are exposed
 * in the turn's snapshot, and exceeding one is a named error the caller turns
 * into the deterministic fallback — never into a fake model answer.
 */
export const CHAT_TURN_BUDGET = { model_calls: 2, embedding_calls: 1 } as const;

export class TurnBudgetExceeded extends Error {
  constructor(public resource: "model_calls" | "embedding_calls", public cap: number) {
    super(`budget_exceeded_${resource}`);
  }
}

export interface TurnBudgetSnapshot {
  model_calls: number;
  embedding_calls: number;
  caps: { model_calls: number; embedding_calls: number };
}

export class TurnBudget {
  private model = 0;
  private embedding = 0;

  reserveModel(): void {
    if (this.model >= CHAT_TURN_BUDGET.model_calls) throw new TurnBudgetExceeded("model_calls", CHAT_TURN_BUDGET.model_calls);
    this.model += 1;
  }
  reserveEmbedding(): void {
    if (this.embedding >= CHAT_TURN_BUDGET.embedding_calls) throw new TurnBudgetExceeded("embedding_calls", CHAT_TURN_BUDGET.embedding_calls);
    this.embedding += 1;
  }
  snapshot(): TurnBudgetSnapshot {
    return { model_calls: this.model, embedding_calls: this.embedding, caps: { ...CHAT_TURN_BUDGET } };
  }
}
