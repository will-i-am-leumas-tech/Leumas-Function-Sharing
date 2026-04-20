def clean_label(value: str) -> str:
    return value.strip().replace("_", " ").title()


def score_record(record: dict) -> int:
    return int(record.get("priority", 0)) + len(record.get("tags", []))
