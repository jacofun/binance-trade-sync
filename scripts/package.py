"""Package local code and installed dependencies; never deploy or include .env."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
if not (root / "node_modules/ali-oss").is_dir():
    raise SystemExit("Run npm ci --omit=dev --ignore-scripts first.")
dest = root / "dist/binance-trade-sync.zip"
dest.parent.mkdir(exist_ok=True)
paths = [root / name for name in ("index.js", "package.json", "package-lock.json")]
paths += sorted((root / "src").rglob("*.js"))
paths += sorted(p for p in (root / "node_modules").rglob("*") if p.is_file())
paths = [p for p in paths if not any(part in {".git", ".github"} or part.startswith(".env")
                                    for part in p.relative_to(root).parts)]
with ZipFile(dest, "w", ZIP_DEFLATED) as archive:
    for path in paths:
        archive.write(path, path.relative_to(root).as_posix())
with ZipFile(dest) as archive:
    assert {"index.js", "package.json", "src/sync.js"} <= set(archive.namelist())
    assert not any(Path(name).name.startswith(".env") for name in archive.namelist())
print(dest)
