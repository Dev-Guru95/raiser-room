#!/usr/bin/env python3
"""
Read a filled Transfer Sheet and emit its field values as JSON.

    python3 tools/read_transfer_sheet.py filled.pdf > values.json

This is the only part of the Transfer Sheet route that touches PDF bytes, and it
does exactly one thing: pull the stored value out of each AcroForm field. There
is no model, no OCR and no inference. The value in the file is the string the
user typed, so reading it back is lossless.

What a value MEANS — whether "68%" is a valid percentage, whether "60-70" is a
number, whether a key-person row is complete — is decided in
src/domain/transfer-sheet.js, where it is tested. This script deliberately does
no interpretation beyond stripping whitespace.

Exit codes:
  0  fields were read (possibly none)
  2  the file is not a readable PDF, or is encrypted
  3  the file has no AcroForm at all — most likely a flattened or scanned copy
"""

import json
import sys
from pathlib import Path

from pypdf import PdfReader


def read_fields(path: Path) -> dict:
    try:
        reader = PdfReader(str(path))
    except Exception as exc:  # noqa: BLE001 — any parse failure is the same outcome here
        print(json.dumps({"error": "unreadable_pdf", "detail": str(exc)}), file=sys.stdout)
        raise SystemExit(2)

    if reader.is_encrypted:
        # Try the empty password; some files are "encrypted" with no password.
        try:
            if reader.decrypt("") == 0:
                raise ValueError("password required")
        except Exception:  # noqa: BLE001
            print(json.dumps({"error": "password_protected"}), file=sys.stdout)
            raise SystemExit(2)

    fields = reader.get_fields() or {}
    if not fields:
        print(json.dumps({
            "error": "no_form_fields",
            "detail": "This PDF has no form fields. A printed, handwritten or flattened copy cannot be "
                      "read — it is stored as a reference document instead.",
            "pages": len(reader.pages),
        }), file=sys.stdout)
        raise SystemExit(3)

    values = {}
    for name, field in fields.items():
        raw = field.get("/V")
        if raw is None:
            continue
        text = str(raw).strip()
        if text:
            # The leaf name is what the app's field table uses; a reader that
            # nests fields would otherwise hand back "page1.s_1_1".
            values[str(name).split(".")[-1]] = text

    return {"pages": len(reader.pages), "field_count": len(fields), "values": values}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: read_transfer_sheet.py <filled.pdf>")
    print(json.dumps(read_fields(Path(sys.argv[1])), indent=2))
