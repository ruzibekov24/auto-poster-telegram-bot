"""Matndan 'shovqin'ni (sana, mualliflik huquqi qatori, soat va h.k.) tozalaydi —
shunda haqiqiy mazmuniy o'zgarishlar soxta signaldan ajratiladi."""

import re

_NOISE_PATTERNS = [
    re.compile(r"©\s*\d{4}.*"),
    re.compile(r"all rights reserved", re.IGNORECASE),
    re.compile(r"last (updated|modified).*", re.IGNORECASE),
    re.compile(r"\b\d{1,2}:\d{2}(:\d{2})?\b"),  # soat:daqiqa
]


def normalize(text: str) -> str:
    lines = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if any(pattern.search(line) for pattern in _NOISE_PATTERNS):
            continue
        lines.append(line)
    return "\n".join(lines)
