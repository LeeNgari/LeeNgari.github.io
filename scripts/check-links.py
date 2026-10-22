"""Check local links, anchors, and CSS font references."""

from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent
pages = ["index.html", "cv.html", "404.html"]
missing = []
checked = 0


def check_ref(page: str, ref: str, ids: set[str]):
    global checked
    if ref.startswith(("http://", "https://", "mailto:", "tel:", "data:")):
        return
    if ref.startswith("#"):
        checked += 1
        if ref[1:] not in ids:
            missing.append((page, ref, "missing anchor"))
        return
    path = ref.split("#")[0].split("?")[0]
    if not path:
        return
    checked += 1
    target = root / path.lstrip("/")
    if not target.exists():
        missing.append((page, ref, "missing file"))


for page in pages:
    text = (root / page).read_text(encoding="utf-8")
    ids = set(re.findall(r'\bid="([^"]+)"', text))
    for ref in re.findall(r'(?:href|src)="([^"]+)"', text):
        check_ref(page, ref, ids)
    # Inline CSS (cv.html) URLs are root-relative.
    for url in re.findall(r'url\(["\']?([^"\')]+)', text):
        if not url.startswith(("data:", "http")):
            checked += 1
            if not (root / url).exists():
                missing.append((page, url, "missing font/file"))

css = (root / "assets" / "styles.css").read_text(encoding="utf-8")
for url in re.findall(r'url\(["\']?([^"\')]+)', css):
    if not url.startswith(("data:", "http")):
        checked += 1
        if not (root / "assets" / url).exists():
            missing.append(("assets/styles.css", url, "missing font/file"))

if missing:
    print(f"{len(missing)} broken reference(s):")
    for page, ref, reason in missing:
        print(f"  {page}: {ref} ({reason})")
    raise SystemExit(1)

print(f"OK: {checked} local references resolved across {len(pages)} pages and styles.css")
