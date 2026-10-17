import type { Project } from './types';

/** Snapshot-based undo/redo. Projects are immutable, so snapshots share structure. */
export class History {
  private past: Project[] = [];
  private future: Project[] = [];
  constructor(private limit = 200) {}

  push(prev: Project) {
    this.past.push(prev);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: Project): Project | undefined {
    const prev = this.past.pop();
    if (prev) this.future.push(current);
    return prev;
  }

  redo(current: Project): Project | undefined {
    const next = this.future.pop();
    if (next) this.past.push(current);
    return next;
  }

  clear() {
    this.past = [];
    this.future = [];
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}
