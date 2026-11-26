/** Whether two Riot IDs are the same account as typed ("Name#TAG", any case, spaces around ignored). Matches the backend's check. */
export const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Riot names and tags can contain spaces (e.g. "CLOUDEY#X 3"); only one "#" and something on each side. */
export const validRiotId = (id: string) => /^[^#]*\S[^#]*#[^#]*\S[^#]*$/.test(id.trim());
