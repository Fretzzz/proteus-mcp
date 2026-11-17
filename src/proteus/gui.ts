/**
 * Launching the Proteus GUI.
 *
 * PDS.EXE accepts a project path (".pdsprj" is appended if missing), and "-P:<ini>" with an
 * IDE-integration INI whose [PROTEUS] section takes DESIGNFILE, PROGRAM, CLOCK, DEVICE,
 * FAMILY, NEWDESIGN, AUTORUN, VDMPORT (found in PDS.EXE's argument handling).
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Installation } from './install.js';

export async function openInProteus(inst: Installation, project: string): Promise<number | undefined> {
  const child = spawn(inst.exe, [path.resolve(project)], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return child.pid;
}

/**
 * Launch through an integration INI. AUTORUN=1 asks Proteus to start the simulation once the
 * design is loaded; PROGRAM overrides the firmware loaded into the processor.
 */
export async function launchWithIni(
  inst: Installation,
  opts: { designFile: string; program?: string; clock?: string; autorun?: boolean },
): Promise<{ pid: number | undefined; ini: string }> {
  const lines = ['[PROTEUS]', `DESIGNFILE=${path.resolve(opts.designFile)}`];
  if (opts.program) lines.push(`PROGRAM=${path.resolve(opts.program)}`);
  if (opts.clock) lines.push(`CLOCK=${opts.clock}`);
  lines.push(`AUTORUN=${opts.autorun ? 1 : 0}`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proteus-mcp-ini-'));
  const ini = path.join(dir, 'proteus-mcp.ini');
  await fs.writeFile(ini, lines.join('\r\n') + '\r\n', 'latin1');
  const child = spawn(inst.exe, [`-P:${ini}`], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { pid: child.pid, ini };
}
