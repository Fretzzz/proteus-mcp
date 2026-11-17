// End-to-end check over stdio. WARNING: runs the edit tools on the project you pass in (use a copy).
// Usage: node test/mcp-e2e.mjs path/to/copy.pdsprj
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const proj = process.argv[2];
const client = new Client({ name: 'e2e', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] }));
const tools = (await client.listTools()).tools;
console.log('TOOLS', tools.length, tools.map(t => t.name).join(', '));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const t = r.content[0].text; console.log(`\n== ${name}${r.isError ? ' (ERROR)' : ''}\n${t.length > 900 ? t.slice(0, 900) + ' …' : t}`); return t; };
await call('proteus_installation', {});
await call('project_overview', { path: proj });
await call('get_netlist', { path: proj, format: 'text' });
await call('trace_net', { path: proj, target: 'U1.P3.2' });
await call('get_bom', { path: proj, format: 'csv' });
await call('check_design', { path: proj });
await call('search_library', { query: 'at89c51' });
await call('search_library', { query: 'lcd 16x2', limit: 3 });
await call('set_component_properties', { path: proj, ref: 'U1', set: { CLOCK: '12MHz', PROGRAM: 'build/firmware_v2_release.hex' } });
await call('set_component_value', { path: proj, ref: 'R1', value: '220R' });
await call('rename_component', { path: proj, ref: 'EXIT', newRef: 'EXIT_SENSOR' });
await call('get_component', { path: proj, ref: 'U1' });
await call('get_netlist', { path: proj, format: 'text' });
await call('check_design', { path: proj });
await client.close();
