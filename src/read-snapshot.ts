/**
 * Last-read snapshot storage for 3-way merge fallback.
 *
 * A single snapshot is kept in memory (the most recent non-raw `read`).
 * It is consulted when an `edit` finds stale anchors against the current
 * file. If the anchors match the snapshot, the edits are replayed on the
 * snapshot and the resulting patch is merged onto the live file.
 *
 * Snapshots do NOT survive session switches, reloads, or restarts.
 */

import type { HashlineFile } from "./hashline";

export interface ReadSnapshot {
  path: string;
  file: HashlineFile;
}

let lastReadSnapshot: ReadSnapshot | undefined;

export function setReadSnapshot(path: string, file: HashlineFile): void {
  lastReadSnapshot = { path, file };
}

export function getReadSnapshot(path: string): ReadSnapshot | undefined {
  if (!lastReadSnapshot || lastReadSnapshot.path !== path) {
    return undefined;
  }
  return lastReadSnapshot;
}


/** For testing: replace the internal state. */
export function _setReadSnapshotState(s: ReadSnapshot | undefined): void {
  lastReadSnapshot = s;
}
