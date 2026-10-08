/**
 * One way to ask Claude something: the `claude` CLI in print mode, on Tory's
 * subscription, as jobpipe does.
 *
 * Every prompt referpipe sends carries text scraped from strangers' websites,
 * and a page can say "ignore your instructions and ...". So every call runs
 * with no tools at all (`--tools ""`) and no MCP servers
 * (`--strict-mcp-config` with no config): the model can only answer.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function ask(prompt: string, opts: { model?: string; timeoutMs?: number } = {}): Promise<string> {
  const args = ['-p', prompt, '--tools', '', '--strict-mcp-config', '--permission-mode', 'default'];
  if (opts.model) args.push('--model', opts.model);
  const pending = run('claude', args, { timeout: opts.timeoutMs ?? 180_000, maxBuffer: 8 * 1024 * 1024 });
  pending.child.stdin?.end(); // otherwise the CLI waits 3s for stdin on every call
  return (await pending).stdout;
}

/** Pulls the first balanced JSON object out of a model's reply. (From jobpipe.) */
export function extractJson(text: string): Record<string, any> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** Scraped text, fenced so the model reads it as data about a business, never as instructions. */
export function untrusted(label: string, text: string): string {
  const clean = text.replace(/<\/?untrusted[^>]*>/gi, '');
  return `<untrusted source="${label}">\n${clean}\n</untrusted>`;
}
