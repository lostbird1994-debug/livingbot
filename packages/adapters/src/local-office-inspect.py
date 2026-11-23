"""Read-only package features used to refuse unsupported destructive round trips."""
import json
from pathlib import Path
import sys
import zipfile

path = Path(sys.argv[1])
result = {"macros": False, "external_workbook_links": False, "embedded_objects": False}
if zipfile.is_zipfile(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        result["macros"] = any(name.lower().endswith("vbaproject.bin") for name in names)
        result["external_workbook_links"] = any(name.startswith("xl/externalLinks/") for name in names)
        result["embedded_objects"] = any("/embeddings/" in name for name in names)
print(json.dumps(result))
