import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "app"))

import scraper

if __name__ == "__main__":
    scraper.main()
