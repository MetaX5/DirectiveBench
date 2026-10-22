"""Reads a JSON array of Markdown documents on stdin and prints, per document, the headings and
GFM tables that cmark-gfm (GitHub's Markdown parser) finds, as a JSON array of
{"headings": [text], "tables": [[header cells, row cells, ...]]}.

Development tool for scripts/cmark-gfm-corpus.mjs; needs `pip install cmarkgfm==2025.10.22`.
Raw HTML is rendered as cmark-gfm's safe placeholder comment, which the text extraction drops.
"""

import json
import re
import sys
from html.parser import HTMLParser

import cmarkgfm


class Blocks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.headings, self.tables = [], []
        self.heading = self.row = self.cell = None

    def handle_starttag(self, tag, attrs):
        if re.fullmatch(r"h[1-6]", tag):
            self.heading = ""
        elif tag == "table":
            self.tables.append([])
        elif tag == "tr":
            self.row = []
        elif tag in ("td", "th"):
            self.cell = ""

    def handle_endtag(self, tag):
        if re.fullmatch(r"h[1-6]", tag) and self.heading is not None:
            self.headings.append(" ".join(self.heading.split()))
            self.heading = None
        elif tag in ("td", "th") and self.cell is not None:
            self.row.append(self.cell.strip())
            self.cell = None
        elif tag == "tr":
            self.tables[-1].append(self.row)

    def handle_data(self, data):
        if self.heading is not None:
            self.heading += data
        if self.cell is not None:
            self.cell += data


def blocks(document):
    parser = Blocks()
    parser.feed(cmarkgfm.github_flavored_markdown_to_html(document))
    return {"headings": parser.headings, "tables": parser.tables}


json.dump([blocks(document) for document in json.load(sys.stdin)], sys.stdout, ensure_ascii=False)
