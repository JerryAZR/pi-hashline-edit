Undo the most recent hashline edit. No parameters.

Use this when an `edit` call corrupted a file and you want to revert it immediately without a full rewrite.

Limitations:
- Only the most recent edit can be undone. A second `undo` will fail.
- Undo is only available within 3 turns of the edit. After that, use `read` and `edit` to fix the file.
