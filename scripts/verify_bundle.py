#!/usr/bin/env python3
"""Verify initial handoff files. Extra later source files are not rejected."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import sys

def verify(root):
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        return ["manifest.json missing"]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        entries = manifest["files"]
        if not isinstance(entries, dict) or not entries:
            return ["invalid manifest files"]
    except (ValueError, KeyError, TypeError):
        return ["invalid manifest"]
    errors = []
    for name, digest in entries.items():
        if not isinstance(name, str):
            errors.append("unsafe manifest path")
            continue
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name:
            errors.append("unsafe manifest path")
            continue
        path = root / name
        try:
            path.resolve().relative_to(root.resolve())
        except ValueError:
            errors.append("path escapes package")
            continue
        if path.is_symlink() or not path.is_file():
            errors.append("missing/nonregular: " + name)
            continue
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != digest:
            errors.append("changed: " + name)
    return errors

def main():
    root = Path(__file__).resolve().parents[1]
    errors = verify(root)
    if errors:
        for item in errors:
            print(item, file=sys.stderr)
        print("Initial bundle differs. Later intentional edits also cause differences.",file=sys.stderr)
        return 1
    print("PASS: all initial manifest files match SHA-256.")
    print("This confirms file integrity, not product or cloud deployment readiness.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
