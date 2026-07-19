// Decoupled ask signal: any question UI fires this, the <NinjaPill> listens.
// Avoids threading context/props through every question view.
export const NINJA_ASK_EVENT = "ninja:ask";

// Exactly one source: a finished match question, or an answered practice-drill
// question. The union (not two optional fields) is what stops a caller sending
// both and letting the server pick — /api/ninja/ask rejects that outright.
export type NinjaAskDetail = {
  questionIndex: number;
  label: string; // e.g. "Q4 · DILR"
} & (
  | { matchId: string; practiceSessionId?: never }
  | { practiceSessionId: string; matchId?: never }
);

export function askNinja(detail: NinjaAskDetail) {
  window.dispatchEvent(new CustomEvent(NINJA_ASK_EVENT, { detail }));
}
