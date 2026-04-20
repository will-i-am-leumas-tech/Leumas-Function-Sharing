# @mesh callable
import csv
from io import StringIO


def parse_sales_csv(csv_text: str) -> list[dict]:
    """Parse sales rows from CSV text."""
    reader = csv.DictReader(StringIO(csv_text))
    return [
        {
            "region": row["region"],
            "revenue": float(row["revenue"]),
            "units": int(row["units"]),
        }
        for row in reader
    ]


def summarize_sales(rows: list[dict]) -> dict:
    """Summarize revenue and units by region."""
    by_region = {}
    for row in rows:
        region = row["region"]
        current = by_region.setdefault(region, {"revenue": 0.0, "units": 0})
        current["revenue"] += float(row["revenue"])
        current["units"] += int(row["units"])
    return {
        "regions": by_region,
        "total_revenue": round(sum(item["revenue"] for item in by_region.values()), 2),
        "total_units": sum(item["units"] for item in by_region.values()),
    }
