// Snapshot-based undo for the editor. Each entry is the full editor state
// at a moment in time (level + composer draft + blueprint assignments +
// mode), serialized to a JSON string so deep-clone is implicit and Map
// values round-trip correctly. Capacity capped to keep memory bounded —
// 50 mutations of a small puzzle is well under a megabyte.

const DEFAULT_CAPACITY = 50;

export class UndoStack {
  constructor(capacity = DEFAULT_CAPACITY) {
    this._capacity = capacity;
    this._stack = [];
  }

  push(snapshot) {
    this._stack.push(snapshot);
    if (this._stack.length > this._capacity) this._stack.shift();
  }

  pop() {
    return this._stack.length > 0 ? this._stack.pop() : null;
  }

  clear() {
    this._stack.length = 0;
  }

  get size() {
    return this._stack.length;
  }
}
