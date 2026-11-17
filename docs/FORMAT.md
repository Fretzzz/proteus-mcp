# Proteus 8 project format: reverse-engineering notes

These notes cover what `proteus-mcp` relies on. They were worked out from Proteus 8.13
(build 31525) files: a hand-built design, its automatic backups (which give clean diffs
between versions), and all 634 sample projects that ship with Proteus. The installed binaries
were analysed statically. No vendor documentation exists for any of this.

Claims are tagged **[V]** (verified: checked on real files or against Proteus itself) or
**[I]** (inferred: consistent with every file seen, but not proven).

Notation: `u8/u16/u32/i32` are little-endian integers. `pstr` is a u8 length followed by
that many Latin-1 bytes. `cstr` is NUL-terminated. All coordinates are in units of 10 nm,
so 0.1 inch = 254000 [V].

---

## 1. `.pdsprj` container [V]

A standard ZIP. Proteus reads archives written by any ordinary deflate ZIP writer
(verified by re-zipping a project with `fflate` and opening it in Proteus).

| Entry | Contents |
|---|---|
| `PROJECT.XML` | `<TIMESTAMP RELEASE FILEVER MODIFIED CREATED CUSTID/>` (Unix times), variants, script list |
| `ROOT.DSN` | the schematic (binary, §2) |
| `ROOT.CDB` | component database, a cache of parts and pin names (§3) |
| `ROOT.LYT` | PCB layout (present in 23 of 634 samples; not decoded) |
| `SCRIPTS/*.DAT` | `PWRRAILS.DAT` (power rail bindings), `REQUIRES.DAT` |
| `FIRMWARE.XML`, `FIRMWARE/<name>.XML`, `FIRMWARE/<name>/…` | VSM Studio / Visual Designer firmware projects (§5) |
| `PREVIEW/ROOT.SVG` | thumbnail |

## 2. `ROOT.DSN`

```
"ISIS SCHEMATIC FILE\x1a"           magic at offset 0                                   [V]
… dd/mm/yy creation and modification dates in the first 0x100 bytes                  [V]
"DESIGN CONFIGURATION DATA\x1a"     fonts, colours, graphic styles                     [V]
library section                      symbols ($PIN…, $TER…, $MKR…) and "{*DEVICE}" text  [V]
i32 trailerOffset                    absolute pointer, stored right before the 1st circuit [V]
repeat per sheet / sub-circuit:
  "ISIS CIRCUIT FILE\x1a" 00 01 00 01 00 01 00 <i32> <i32> 01 00 00 "OBJECT DATA\0"
  <object records…> ff                                                                [V]
trailer: sheet table (pstr name … i32 sectionOffset), SPICE options (ABSTOL, RELTOL…) [V]
```

Every design has at least two circuit sections: the root sheet (`CCT000`) and `__DEFAULT__`.
Multi-sheet and hierarchical designs have more (up to 14 in the samples) [V].

### 2.1 Absolute pointers (the key to safe editing) [V]

Connectivity is stored as **absolute file offsets of wire records**:

* each component pin → the wire attached to it (0 = unconnected)
* each terminal, generator and probe → its wire(s)
* each junction or connection node → up to 4 wires
* `trailerOffset`, plus sheet-table entries → circuit sections

So any change in length must rewrite every pointer to a later record. `src/format/edit.ts`
does this, and refuses to edit when an int32 equal to a pointer target appears anywhere it
cannot account for (outside every decoded record). Proteus 8.13 loads files edited this way:
a renamed part, a changed value and relocated properties were opened in Proteus and checked
in its own *Edit Component* dialog.

### 2.2 Text labels [V]

```
ff <u8 len> <len bytes text> <i32 x> <i32 y> <24 bytes: justification, height, width, flags…>
ff <u8 visible 0|1> <cstr font> <cstr LABEL-KIND> <4 bytes 00>
```

Label kinds seen: `COMPONENT ID`, `COMPONENT VALUE`, `SUBCKT NAME`, `SUBCKT ID`, `PROPERTIES`,
`TERMINAL LABEL`, `WIRE LABEL`, `VPROBE LABEL`, `IPROBE LABEL`, `GENERATOR LABEL`,
`TAPE LABEL`, `SCRIPT`, `DESCRIPTION`, `ACTIVE REGION`.

A label is found by anchoring on `\0KIND\0`, walking back over the font name to `ff vis`,
and then searching for the shortest `ff <len>` whose text ends exactly 32 bytes earlier.

### 2.3 Property text [V]

Lines of `{KEY=VALUE}`. The `PROPERTIES` label is followed by `i32 L`:

* label text empty and `L > 0`: the full text follows as an `L`-byte block (*block*)
* label text non-empty and `L == len(label text)`: the label holds the full text (*inline*)
* label text non-empty and `L != len`: the label shows the visible subset; the block holds
  the full text (*both*)

**The newline layout is significant.** Property text often ends in a run of `\n`. Padding a
shortened block with extra `\n` makes Proteus 8.13 hang at "Initializing project…" and fall
back to an autosave (seen in testing). Edits therefore keep the original layout
byte-for-byte and relocate pointers instead of padding.

### 2.4 Components [V]

```
labels: COMPONENT ID, COMPONENT VALUE, (SUBCKT NAME | 2nd hidden VALUE), PROPERTIES [+ block]
u16 pinCount
pstr deviceName                      (Latin-1, e.g. "1° ORD : LP_F")
i32 x, i32 y
i32 rotation                         tenths of a degree (900 = 90°)
i32 objectIndex                      matches ROOT.CDB records
i32 flags1
[i32 flags2]                         present in current files (17-byte header), absent in older (13)
u8
pinCount × i32 wireOffset            in symbol pin order (= ROOT.CDB pin-list order)
```

The header size is detected per component: the size whose pin refs all land on wire records
wins. Otherwise the file's majority is used [V].

### 2.5 Wires and buses [V]

```
<u8 tag> 1d 00 00 00 <style 20 bytes> 02 7f "WIRE\0" | "BUS WIRE\0"
u16 hasLabel                 1 → a WIRE LABEL label follows (names the net)
[label]
u16 n
n × (i32 x, i32 y)           polyline
```

The pointer to a wire is the offset of its tag byte (the start of the 25-byte style header).

### 2.6 Terminals, generators, probes [V]

Terminals: `<tag> <i32 x> <i32 y> <i32 rot> pstr "$TERxxx" <6 bytes> TERMINAL LABEL <i32 wireOffset>`
with symbols `$TERPOWER`, `$TERGROUND`, `$TERINPUT`, `$TEROUTPUT`, `$TERBIDIR`,
`$TERDEFAULT`, `$TERBUS`, `$TERCHASSIS`, `$TERDYNAMIC`, `$TERNC`. An unlabelled power
terminal is net `VCC` and an unlabelled ground terminal is `GND` [I, consistent with Proteus'
own SDF output].

Generators (`$PWLINGEN`, `$DCLOCK`, `$DIGGEN`, …) and probes (`$VPROBE`, `$IPROBE`, tape):
`<X LABEL> PROPERTIES [block] <2 flag bytes> <i32 wire> <i32 wire>`. The second slot is set
when the probe sits on a wire and splits it.

### 2.7 Junctions / connection nodes [V]

`01 <i32 x> <i32 y> <4 × i32 wireOffset>`: unused slots are 0, and 1 to 4 refs are used.
Together with pin and terminal refs these fully describe connectivity. Working out joins
from geometry instead gives wrong merges (e.g. VDD shorted to VSS), so it is off by default.

### 2.8 Hidden power pins [V]

Pins such as `VCC` and `GND` on many ICs are hidden and have no wire. They join the net of
the same name. The netlist marks them `implicit`.

## 3. `ROOT.CDB` [V]

```
u32 7, u32 1, u32 1, u32 0, pstr "ROOT", …
pin lists : <u32 objectIndex> <pstr ref> <u32 n> n × (<pstr pinName> <pstr pinNumber>)
parts     : <pstr ref> <pstr value> <pstr device> <pstr package> <u32 len> <property text>
```

No absolute offsets. The ref is empty for unreferenced parts and virtual instruments. Pin
order matches the DSN pin table.

## 4. Device libraries [V]

* `DATA\LIBRARY\*.LIB`: `"DEVICE LIBRARY\x1a"`, `u32@0x18` device count, directory at
  0x20 of 0x50-byte entries (name padded with NULs, then size/timestamp/offset words).
* `DATA\Library Indexing\<hash>#<LIB>.IDX`: `"DEVICE LIBRARY INDEX\x1a"`, `u32@0x24`
  count, entries from 0x28: `u32 stamp`, 6 × cstr (category, ?, sub-category, manufacturer,
  ?, description), `u32`. The order matches the library directory.

## 5. Firmware [V]

`FIRMWARE.XML`: `<FIRMWARE FAMILY COMPILER TYPE><PROJECTS><STRING>name…`.
`FIRMWARE/<name>.XML`: `<PROJECT NAME TYPE CONFIGURATION BUILDPATH><FILES><FILE GROUP NAME/>…`.
Sources sit under `FIRMWARE/<name>/` and build output under `FIRMWARE/<name>/Debug/`.

## 6. Program interfaces (from static analysis of `BIN\`)

* `PDS.EXE "<project>"` opens a project. `PDS.EXE -P:<ini>` reads an integration INI with
  section `[PROTEUS]` keys `DESIGNFILE PROGRAM CLOCK DEVICE FAMILY NEWDESIGN AUTORUN VDMPORT`.
  The keys are [V]; the effect of `AUTORUN` is [I].
* `PROSPICE.EXE <file.SDF>` and `CONSOLE.EXE` (byte-identical) run the simulator headless
  through `PROSPICE.DLL!simulate`. Set `MODELS=<DATA\MODELS>` and `RESULTS=<dir>`. The log
  goes to stdout with `#I:` `#W:` `#E:` `#F:` prefixes. Output is `<PARTITION>.PDF`, a
  "LISA PARTITION DATA FILE" (not Adobe PDF; not decoded) [V].
* SDF ("ISIS SCHEMATIC DESCRIPTION FORMAT 8.0") is a text netlist with sections
  `*PROPERTIES`, `*MODELDEFS`, `*PARTLIST` (`REF,DEVICE,VALUE,KEY=VAL…`) and `*NETLIST`
  (`NAME,count` then `REF,<PS|IP|OP|IO|PP>,PIN`; terminal markers `GT IT OT BT PR`).
  Every pin a model owns must appear, so unconnected pins become one-node nets [V].
* The only COM class is `PDS.ImportServer` (`PDS.EXE -activex`). It imports library parts and
  cannot reach designs [V].
* Lua (`LUA.DLL`) is used only by the scripted-component model `VSMLUA.DLL`. Python
  (`Tools\Python`, `PYPROC.exe`) is the Raspberry Pi model for Visual Designer [V].

## 7. Coverage on the 634 shipped samples

| Metric | Result |
|---|---|
| projects opened | 634 / 634 |
| components / wires / terminals / junctions | 9 485 / 43 558 / 23 789 / 8 530 |
| projects with any parser or netlist warning | 75 |
| relocating edits verified by re-parse | 554 |
| edits refused by the pointer-safety check | 78 (files containing records not yet decoded) |
| edits that broke a file | 0 |

Reproduce with `npm run corpus`. Use `tools/unexplained-pointers.mjs <folder>` to list the
remaining undecoded pointer-bearing records, the next things to reverse engineer.
