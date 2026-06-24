Read a UTF-8 text file or a supported image. Text lines are prefixed `LINE#HASH│content` — copy those anchors verbatim into `edit` or `insert`.

Use `offset` and `limit` to page through. Default cap: {{DEFAULT_MAX_LINES}} lines or {{DEFAULT_MAX_BYTES}}; when truncated, the tail of the output tells you the next `offset`.

Set `raw: true` to skip LINE#HASH prefixing and return plain text. Don't use if you plan to edit this file — saves tokens on exploration, documentation, and reference reads.
