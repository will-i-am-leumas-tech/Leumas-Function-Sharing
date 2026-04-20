# @mesh callable
from typing import Optional


def add(a: int, b: int) -> int:
    """Add two numbers.

    Args:
        a (int): First value.
        b (int): Second value.

    Returns:
        Sum of both values.
    """
    return a + b


def compound_interest(principal: float, rate: float, years: int, contribution: Optional[float] = None) -> float:
    """Estimate compound interest with an optional yearly contribution."""
    total = principal
    for _ in range(years):
        total = total * (1 + rate)
        if contribution is not None:
            total += contribution
    return round(total, 2)
