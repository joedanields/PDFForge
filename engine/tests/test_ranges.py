"""Page-range parser (utils/ranges.py); mirrored by app/src/lib/pageRanges.ts."""

from __future__ import annotations

import pytest

from protocol import EngineError
from utils.ranges import PageRange, format_ranges, parse_page_set, parse_ranges


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("all", [(1, 10)]),
        ("", [(1, 10)]),
        ("1-3, 4-7, 8", [(1, 3), (4, 7), (8, 8)]),
        ("  2 ,5- 6 ", [(2, 2), (5, 6)]),
        ("8-", [(8, 10)]),
        ("-3", [(1, 3)]),
        ("5-6,1-2", [(5, 6), (1, 2)]),
        ("3,3", [(3, 3), (3, 3)]),
    ],
)
def test_parse_valid(text: str, expected: list[tuple[int, int]]) -> None:
    assert parse_ranges(text, 10) == [PageRange(a, b) for a, b in expected]


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("11", "doesn't exist"),
        ("5-12", "doesn't exist"),
        ("0", "start at 1"),
        ("7-3", "runs backwards"),
        ("a-b", "not a page"),
        ("1;2", "not a page"),
        (",", "No pages"),
    ],
)
def test_parse_invalid(text: str, message: str) -> None:
    with pytest.raises(EngineError) as info:
        parse_ranges(text, 10)
    assert info.value.code == "INVALID_INPUT"
    assert message in info.value.message


def test_page_set_is_sorted_unique_zero_based() -> None:
    assert parse_page_set("5-6,1-2,2", 10) == [0, 1, 4, 5]


def test_format_ranges() -> None:
    assert format_ranges([1, 2, 3, 5, 7, 8]) == "1-3,5,7-8"
    assert format_ranges([4]) == "4"
    assert format_ranges([]) == ""
    assert parse_page_set(format_ranges([9, 1, 2, 3]), 10) == [0, 1, 2, 8]


def test_labels() -> None:
    assert PageRange(2, 2).label() == "2"
    assert PageRange(2, 5).label() == "2-5"
