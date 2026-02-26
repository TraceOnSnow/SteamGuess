import re
from datetime import datetime
from pathlib import Path
import json


def extract_appids(html_text: str) -> list[str]:
	matches = re.findall(r'data-appid="(\d+)"', html_text)
	# 去重并保持原顺序
	return list(dict.fromkeys(matches))


def infer_date_from_filename(file_path: Path) -> str:
	m = re.search(r"(\d{8})", file_path.name)
	if m:
		return m.group(1)
	return datetime.now().strftime("%Y%m%d")


def main() -> None:
    project_root = Path(__file__).resolve().parent.parent
    input_file = project_root / "data/raw/steamDB/20260225.html"

    html = input_file.read_text(encoding="utf-8", errors="ignore")
    appids = extract_appids(html)

    yyyymmdd = infer_date_from_filename(input_file)
    output_dir = project_root / "data/processed"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / f"appids_db_{yyyymmdd}.json"

    data = {"appids": appids}
    output_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
	main()
