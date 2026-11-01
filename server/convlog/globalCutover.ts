/** One routing commit, written LAST by offline maintenance. No history/registry
 * mirror: original sources remain readable at their original paths. Runtime
 * never guesses a partial cohort is committed. Invalid commits fail closed. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
export const GLOBAL_CUTOVER = '_global-cutover.json';
export type GlobalCutover = { format: 'global-conversation-cutover-v1'; home: string; legacyRoots: string[]; retiredMainIds?: string[]; intent: string; intentSha256: string };
export function globalCutover(home: string): GlobalCutover | null {
 const path = join(home, '.vault-chat/events', GLOBAL_CUTOVER);
 let st;
 try { st = lstatSync(path); } catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
 if (!st.isFile() || st.nlink !== 1 || realpathSync(path) !== path) throw new Error('invalid-global-cutover-file');
 const m = JSON.parse(readFileSync(path, 'utf8')) as GlobalCutover;
 if (m.format !== 'global-conversation-cutover-v1' || m.home !== resolve(home) || !Array.isArray(m.legacyRoots) || m.legacyRoots.some(p => typeof p !== 'string' || resolve(p) !== p || p === m.home) || new Set(m.legacyRoots).size !== m.legacyRoots.length || (m.retiredMainIds!==undefined&&(!Array.isArray(m.retiredMainIds)||m.retiredMainIds.some(id=>typeof id!=='string'||id==='main'||!id))) || typeof m.intent !== 'string' || !/^[a-f0-9]{64}$/.test(m.intentSha256)) throw new Error('invalid-global-cutover');
 return m;
}
export function conversationVaults(home: string, roots: string[]): string[] {
 const cutover = globalCutover(home);
 return [...new Set([home, ...roots])].filter(p => !cutover?.legacyRoots.includes(p));
}
