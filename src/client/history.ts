import type { Intent } from "../protocol";
import type { Signals } from "./signals";

/**
 * One thing the user would expect a single press of undo to take back — which is rarely one
 * write. Renaming a row while reweighing its split is one step; so is adding a record and
 * filling it in.
 */
export interface HistoryStep {
  readonly forward: readonly Intent[];
  readonly inverse: readonly Intent[];
}

/** Deep enough for a session's worth of edits, shallow enough not to hold a week of records. */
const DEPTH = 100;

/**
 * Undo and redo over writes that have already been sent.
 *
 * Undoing isn't rolling back — the server may well have applied the write already, and on a third
 * party's data (a calendar, a mailbox) it certainly has. So an undo is a new write in the opposite
 * direction, worked out at the moment the original was made, when the previous values were still
 * on screen. That also makes it survive a reload of the other tab, and a server that reordered
 * things behind us.
 *
 * A step whose writes can't be inverted — a server-owned action with no `invert` — clears the
 * stack rather than pretending: half an undo is worse than none.
 */
export class History {
  #undo: HistoryStep[] = [];
  #redo: HistoryStep[] = [];
  readonly #canUndo;
  readonly #canRedo;

  constructor(signals: Signals) {
    this.#canUndo = signals.state(false);
    this.#canRedo = signals.state(false);
  }

  get canUndo() {
    return this.#canUndo.value;
  }

  get canRedo() {
    return this.#canRedo.value;
  }

  /** Records a step, or forgets everything before it if it can't be taken back. */
  push(forward: readonly Intent[], inverse: readonly (Intent | null)[]) {
    if (forward.length === 0) return;
    this.#redo = [];
    if (inverse.some((intent) => intent === null)) {
      this.#undo = [];
      this.#signal();
      return;
    }
    // Inverses undo the step backwards: the last write made is the first one taken back.
    this.#undo.push({ forward, inverse: (inverse as Intent[]).slice().reverse() });
    if (this.#undo.length > DEPTH) this.#undo.shift();
    this.#signal();
  }

  /** The writes that take the last step back, or nothing if there's no step to take back. */
  undo(): readonly Intent[] {
    const step = this.#undo.pop();
    if (!step) return [];
    this.#redo.push(step);
    this.#signal();
    return step.inverse;
  }

  redo(): readonly Intent[] {
    const step = this.#redo.pop();
    if (!step) return [];
    this.#undo.push(step);
    this.#signal();
    return step.forward;
  }

  clear() {
    this.#undo = [];
    this.#redo = [];
    this.#signal();
  }

  #signal() {
    this.#canUndo.value = this.#undo.length > 0;
    this.#canRedo.value = this.#redo.length > 0;
  }
}
