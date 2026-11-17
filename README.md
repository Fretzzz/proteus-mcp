# proteus-mcp

An MCP server for **Labcenter Proteus 8**. It lets Claude (or any MCP client) read, query and
edit Proteus schematic projects (`.pdsprj`), reconstruct netlists, generate BOMs, search the
part libraries, handle embedded firmware, run Proteus' headless simulator and open designs in
the Proteus GUI.

Proteus has no public automation API, and its project format is a proprietary binary. This
server is built on a reverse-engineered model of that format, documented in
[`docs/FORMAT.md`](docs/FORMAT.md). It was validated on all 634 sample projects that ship with
Proteus, and Proteus 8.13 itself loads the files it writes.

## Tools

| Tool | What it does |
|---|---|
| `proteus_installation` | Find the local Proteus install (version, BIN/DATA, simulator, samples) |
| `list_projects` | Find `.pdsprj` files in a folder, or in the bundled samples |
| `project_overview` | Sheets, counts, archive contents, firmware, metadata, warnings |
| `list_components` | Parts with ref, value, device, package, position, rotation, properties |
| `get_component` | One part in full: every pin with its name, number and net |
| `get_netlist` | Connectivity as JSON, text or Proteus SDF |
| `trace_net` | What a pin (`U1.P3.2`, `U1.12`) or net (`VCC`) connects to |
| `get_bom` | Bill of materials (JSON/CSV, grouped or per part) |
| `check_design` | Missing or unreadable MCU firmware, duplicate refs, dangling nets, unconnected pins |
| `set_component_properties` | Set/add/remove part properties (e.g. `PROGRAM`, `CLOCK`) |
| `set_component_value` | Change a part's value (`10k` → `4k7`) |
| `rename_component` | Change a reference designator |
| `list_firmware` | Firmware projects embedded by VSM Studio / Visual Designer |
| `read_project_file` / `write_project_file` | Read or write files inside the archive (e.g. `FIRMWARE/…/main.ino`) |
| `search_library` | Search ~500k devices across the installed libraries |
| `export_sdf` | Write the design as an SDF netlist |
| `simulate` | Headless PROSPICE validation run: the netlist is accepted, models load and firmware reads |
| `open_in_proteus` | Open the project in the GUI (optionally auto-run via PDS.EXE's integration INI) |
| `inspect_records` | Low-level record view for further reverse engineering |

## Install

Requires Node.js 18.17+ and (for the GUI, simulator and library tools) Proteus 8 on Windows.
The read/edit tools work on any OS.

```bash
git clone https://github.com/Fretzzz/proteus-mcp.git
```

```bash
cd proteus-mcp && npm install && npm run build
```

### Claude Code

```bash
claude mcp add proteus -- node C:/path/to/proteus-mcp/dist/index.js
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "proteus": {
      "command": "node",
      "args": ["C:\\path\\to\\proteus-mcp\\dist\\index.js"]
    }
  }
}
```

If Proteus lives somewhere unusual, set `PROTEUS_HOME` to the folder that contains
`BIN\PDS.EXE`.

## Editing safely

* **Close the project in Proteus before editing it.** Proteus overwrites the file when it saves.
* Every write copies the original to `<project>.pdsprj.bak` first (`backup: false` disables
  this), or you can write elsewhere with `outputPath`.
* `ROOT.DSN` stores absolute file pointers, so a length change must relocate them. The editor
  proves that every pointer is understood before it writes, then re-parses the result and
  checks connectivity is unchanged. If anything is unaccounted for, it refuses with an error
  rather than risk corrupting the file. (On the 634 samples, 554 such edits succeeded,
  78 were refused, and none broke a file.)
* Property text keeps its exact original newline layout. Padding it makes Proteus hang on load.

## Limitations

* Bus wires are reported but bus members are not expanded into individual nets.
* `simulate` produces Proteus' binary "LISA partition" results but does not decode them yet.
  Without graphs or probes, PROSPICE only validates the design. For interactive simulation use
  `open_in_proteus` with `autorun`.
* PCB layouts (`ROOT.LYT`) are detected but not decoded. Placing new parts and drawing wires
  is not supported yet.
* Format knowledge comes from Proteus 8.13 files. Other 8.x releases are likely compatible
  (older files with a 13-byte component header are handled automatically).

## Development

```bash
npm test
```

```bash
npm run corpus
```

```bash
node tools/unexplained-pointers.mjs "C:/Program Files (x86)/Labcenter Electronics/Proteus 8 Professional/DATA/SAMPLES"
```

* `npm test` runs unit tests, plus integration tests against a local Proteus sample if one
  is installed.
* `npm run corpus` parses and edit-tests every bundled sample.
* `tools/unexplained-pointers.mjs` lists the record types that remain undecoded.

`tools/dump-entry.mjs <project> <entry> <hexOffset> <hexLength>` hex-dumps part of any
archive entry.

## How it was reverse engineered

1. **Container.** `.pdsprj` is a ZIP. `ROOT.DSN` is a custom binary format that begins with
   the text `ISIS SCHEMATIC FILE`.
2. **Diffing.** Proteus' own automatic backups of one design, saved at each step, were
   compared byte by byte to see which bytes each change touched.
3. **Pointers.** Values in component pin tables were tested against record positions in the
   file. They turned out to be absolute offsets of wire records, which unlocked both
   connectivity and safe editing.
4. **Generalising.** All 634 bundled samples were parsed repeatedly. Every unexplained
   pointer or unparsed record was classified until the remaining ones were rare. This found
   the old 13-byte component header, probe and generator records, junction nodes and the
   three ways property text is stored.
5. **Ground truth.** The reconstructed netlist was matched against a hand-checked wiring
   table. Edited files were opened in Proteus 8.13 and inspected in its own dialogs. This is
   how the newline-padding hang was found and fixed.
6. **Binaries.** Static analysis of `PDS.EXE`, `PROSPICE.DLL` and the other binaries found
   the command-line and INI interfaces, the headless simulator and the SDF netlist format.

Proteus is a trademark of Labcenter Electronics Ltd. This project is not affiliated with
Labcenter. It works with files you own, for interoperability, and ships no Labcenter code,
libraries or sample designs.
