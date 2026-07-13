// Decoupled ask signal: any question UI fires this, the <NinjaPill> listens.
// Avoids threading context/props through every question view.
export const NINJA_ASK_EVENT = "ninja:ask";

export interface NinjaAskDetail {
  matchId: string;
  questionIndex: number;
  label: string; // e.g. "Q4 · DILR"
}

export function askNinja(detail: NinjaAskDetail) {
  window.dispatchEvent(new CustomEvent(NINJA_ASK_EVENT, { detail }));
}
