"""Rasmiy veb-manbalardan toza matn oladi (script/style/nav olib tashlanadi)."""

import httpx
from bs4 import BeautifulSoup

USER_AGENT = "Mozilla/5.0 (compatible; FLEXRadarBot/1.0; monitoring official FLEX sources)"


def fetch_text(url: str, timeout: int = 20) -> str:
    headers = {"User-Agent": USER_AGENT}
    with httpx.Client(follow_redirects=True, timeout=timeout, headers=headers) as client:
        response = client.get(url)
        response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "img"]):
        tag.decompose()

    text = soup.get_text(separator="\n")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return "\n".join(lines)
