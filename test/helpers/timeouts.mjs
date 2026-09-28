/** SQLite busy_timeout configured by SqliteStore (PRAGMA busy_timeout):
 *  shared so a store constant change updates every busy-wait assertion. */
export const BUSY_TIMEOUT_MS = 5000;
/** Floor proving a busy wait really happened: the full timeout minus margin. */
export const BUSY_WAIT_FLOOR_MS = BUSY_TIMEOUT_MS - 1000;
