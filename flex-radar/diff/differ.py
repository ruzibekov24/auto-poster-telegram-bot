"""Ikki matn snapshot orasidagi ma'noli farqni aniqlaydi."""

import difflib


def has_meaningful_diff(old_text: str, new_text: str, min_changed_lines: int = 1) -> tuple[bool, str]:
    """(o'zgardimi, diff_matni) qaytaradi. Diff faqat qo'shilgan qatorlarni ko'rsatadi."""
    if old_text == new_text:
        return False, ""

    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    diff_lines = list(difflib.unified_diff(old_lines, new_lines, lineterm="", n=1))

    added = [line for line in diff_lines if line.startswith("+") and not line.startswith("+++")]
    if len(added) < min_changed_lines:
        return False, ""

    # Juda uzun diff'ni AI promptiga yubormaslik uchun cheklaymiz
    diff_text = "\n".join(diff_lines[:200])
    return True, diff_text
