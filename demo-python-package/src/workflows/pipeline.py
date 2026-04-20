# @mesh callable
from .rules import clean_label, score_record


class WorkflowReport:
    """Simple report object produced by a workflow."""

    def __init__(self, total: int):
        self.total = total


def transform_record(record: dict, include_score: bool = True) -> dict:
    """Normalize a workflow record."""
    output = {
        "id": record.get("id"),
        "label": clean_label(record.get("label", "")),
    }
    if include_score:
        output["score"] = score_record(record)
    return output


async def summarize_batch(records: list[dict]) -> dict:
    """Summarize a batch of workflow records."""
    transformed = [transform_record(record) for record in records]
    return {
        "count": len(transformed),
        "records": transformed,
        "top_score": max((item.get("score", 0) for item in transformed), default=0),
    }
