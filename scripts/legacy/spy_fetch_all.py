import json
import os
import time
from datetime import datetime
from urllib.request import urlopen


BASE_URL = "https://steamspy.com/api.php?request=all&page={page}"
OUTPUT_DIR = "data/raw/toplists"
PAGES = range(1, 21)  # page 0 - 20
ROUNDS = 1
INTERVAL_SECONDS = 120  # 2 minutes


def fetch_page(page: int) -> dict:
	url = BASE_URL.format(page=page)
	with urlopen(url, timeout=30) as resp:
		return json.loads(resp.read().decode("utf-8"))


def save_page(data: dict, page: int) -> str:
	ts = datetime.now().strftime("%Y%m%d_%H%M%S")
	os.makedirs(OUTPUT_DIR, exist_ok=True)
	path = os.path.join(os.path.join(OUTPUT_DIR,f"{ts}"), f"page{page}.json")
	with open(path, "w", encoding="utf-8") as f:
		json.dump(data, f, ensure_ascii=False)
	return path


def main() -> None:
	total_calls = ROUNDS * len(PAGES)
	call_idx = 0

	for round_idx in range(1, ROUNDS + 1):
		for page in PAGES:
			call_idx += 1
			data = fetch_page(page)
			out = save_page(data, page)
			print(f"[{call_idx}/{total_calls}] round={round_idx} page={page} saved: {out}")

			if call_idx < total_calls:
				time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
	main()
