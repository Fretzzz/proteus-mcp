/**
 * Headless simulation through PROSPICE.EXE (a console stub around PROSPICE.DLL!simulate).
 *
 *   PROSPICE.EXE <file.SDF>   with environment MODELS=<DATA\MODELS> RESULTS=<dir>
 * It prints a log with "#I:", "#W:", "#E:", "#F:" prefixes and writes <PARTITION>.PDF
 * ("LISA PARTITION DATA FILE", not Adobe PDF) into RESULTS.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Installation } from './install.js';

export interface SimMessage {
  level: 'info' | 'warning' | 'error' | 'fatal' | 'text';
  text: string;
}

export interface SimResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  messages: SimMessage[];
  resultFiles: string[];
  workDir: string;
  sdfPath: string;
}

const LEVELS: Record<string, SimMessage['level']> = { I: 'info', W: 'warning', E: 'error', F: 'fatal' };

export function parseSimLog(text: string): SimMessage[] {
  const out: SimMessage[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const m = line.match(/^#([IWEF]):(.*)$/);
    out.push(m ? { level: LEVELS[m[1]], text: m[2].trim() } : { level: 'text', text: line });
  }
  return out;
}

export async function runProspice(inst: Installation, sdfText: string, opts: { timeoutMs?: number; workDir?: string } = {}): Promise<SimResult> {
  const workDir = opts.workDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'proteus-mcp-sim-')));
  await fs.mkdir(workDir, { recursive: true });
  const sdfPath = path.join(workDir, 'DESIGN.SDF');
  await fs.writeFile(sdfPath, sdfText, 'latin1');
  const started = Date.now();
  let timedOut = false;
  const chunks: Buffer[] = [];
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(inst.prospice, [sdfPath], {
      cwd: workDir,
      env: { ...process.env, MODELS: inst.models, RESULTS: workDir },
      windowsHide: true,
    });
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => chunks.push(d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? 60000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const files = (await fs.readdir(workDir)).filter((f) => f !== 'DESIGN.SDF').map((f) => path.join(workDir, f));
  return {
    exitCode,
    timedOut,
    durationMs: Date.now() - started,
    messages: parseSimLog(Buffer.concat(chunks).toString('latin1')),
    resultFiles: files,
    workDir,
    sdfPath,
  };
}
