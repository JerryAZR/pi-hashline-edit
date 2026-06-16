Patch a text file by inserting new lines between existing ones. This tool
does NOT change or delete any existing lines — it only adds new content.

Each entry is an insertion operation:
- `anchor`: a `LINE#HASH` anchor copied verbatim from a read output, e.g. `"5#A3"`. This is the target line.
- `direction`: `"after"` to insert after the anchor line, or `"before"` to insert before it.
- `lines`: the new content to insert (each array entry is one line).

The anchor line itself is preserved — `lines` are inserted after or before it.
Do not include the anchor line's content in `lines` unless intentional duplication.
