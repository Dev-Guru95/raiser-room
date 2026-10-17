#!/usr/bin/env python3
"""
Generate the RaiseRoom Transfer Sheet — a free, fillable PDF.

    python3 tools/transfer_sheet.py out/RaiseRoom_Transfer-Sheet.pdf

The field names come from tools/fields.json, which is generated from
src/domain/transfer-sheet.js. Never hard-code a field name in here: the
JavaScript module is the single source of truth, and a field name typed twice
is a field name that will eventually be typed differently.

Form-field text uses Helvetica. That is not a brand choice — AcroForm input text
is rendered by the reader, not by us, and a non-standard font in a form field is
the most common reason a filled PDF opens with empty-looking boxes on somebody
else's machine. All printed type is the brand set.
"""

import json
import sys
from pathlib import Path

from reportlab.lib.colors import HexColor, Color
from reportlab.lib.pagesizes import LETTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

HERE = Path(__file__).resolve().parent
FIELDS = json.loads((HERE / "fields.json").read_text())
FONT_DIR = HERE / "fonts"

# TekAIDA brand. Blade Purple is the page accent — it is NOT the logo purple and
# the two must never be used interchangeably.
ONYX = HexColor("#000000")
WHITE = HexColor("#FFFFFF")
BLADE = HexColor("#7E3FF2")
STEEL = HexColor("#B0B0B0")
RULE = HexColor("#E2E2E2")

PAGE_W, PAGE_H = LETTER
MARGIN = 54.0
COL_W = PAGE_W - (2 * MARGIN)

DISPLAY = "Cinzel-Bold"
SERIF = "Lora"
SERIF_B = "Lora-Bold"
SERIF_I = "Lora-Italic"
SANS = "Raleway"
SANS_B = "Raleway-Bold"
SANS_L = "Raleway-Light"
MONO = "SourceCodePro"

FORM_FONT = "Helvetica"


def register_fonts() -> None:
    for name, filename in [
        (DISPLAY, "Cinzel-Bold.ttf"),
        (SERIF, "Lora.ttf"),
        (SERIF_B, "Lora-Bold.ttf"),
        (SERIF_I, "Lora-Italic.ttf"),
        (SANS, "Raleway-Regular.ttf"),
        (SANS_B, "Raleway-Bold.ttf"),
        (SANS_L, "Raleway-Light.ttf"),
        (MONO, "SourceCodePro-Regular.ttf"),
    ]:
        path = FONT_DIR / filename
        if not path.exists():
            raise SystemExit(f"missing font: {path}")
        pdfmetrics.registerFont(TTFont(name, str(path)))


# ───────────────────────────────────────────────────────────── text helpers ──

def wrap(text: str, font: str, size: float, width: float) -> list[str]:
    """Greedy wrap by measured width. No hyphenation — a broken word reads worse."""
    words = str(text).split()
    lines: list[str] = []
    line = ""
    for word in words:
        trial = f"{line} {word}".strip()
        if pdfmetrics.stringWidth(trial, font, size) <= width:
            line = trial
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def para(c, text, x, y, width, font=SERIF, size=9.5, leading=13.5, colour=ONYX):
    c.setFont(font, size)
    c.setFillColor(colour)
    for line in wrap(text, font, size, width):
        c.drawString(x, y, line)
        y -= leading
    return y


def rule(c, x, y, width, colour=RULE, thickness=0.6):
    c.setStrokeColor(colour)
    c.setLineWidth(thickness)
    c.line(x, y, x + width, y)


def footer(c, page_no: int, total: int) -> None:
    c.setFont(SANS_L, 7.5)
    c.setFillColor(STEEL)
    c.drawString(MARGIN, 30, "RaiseRoom Transfer Sheet · TekAIDA Consulting LLC")
    c.drawRightString(PAGE_W - MARGIN, 30, f"{page_no} / {total}")


def section(c, y, number, title, blurb=None):
    c.setFont(MONO, 8)
    c.setFillColor(BLADE)
    c.drawString(MARGIN, y, number.upper())
    y -= 17
    c.setFont(DISPLAY, 15)
    c.setFillColor(ONYX)
    c.drawString(MARGIN, y, title)
    y -= 9
    rule(c, MARGIN, y, COL_W, BLADE, 1.1)
    y -= 18
    if blurb:
        y = para(c, blurb, MARGIN, y, COL_W, SERIF, 9, 13, HexColor("#3A3A3A")) - 6
    return y


# ───────────────────────────────────────────────────────────────── form bits ──

def textfield(c, name, x, y, w, h, *, tooltip="", size=9.5, value=""):
    c.acroForm.textfield(
        name=name,
        tooltip=tooltip or name,
        x=x, y=y, width=w, height=h,
        value=value,
        fontName=FORM_FONT, fontSize=size,
        textColor=ONYX, fillColor=HexColor("#F7F5FF"),
        borderColor=HexColor("#C9B9F5"), borderWidth=0.7,
        borderStyle="solid", forceBorder=True,
        relative=False,
    )


def hidden_version(c, value: str) -> None:
    """
    The edition marker.

    Printed small rather than truly hidden: a reader that strips form fields
    would otherwise take the edition with it, and then a sheet of unknown
    vintage arrives with nothing to identify it. Visible means recoverable.
    Placed on the white footer band so it can actually be read.
    """
    c.acroForm.textfield(
        name=FIELDS["meta"]["version"],
        tooltip="Sheet edition — leave this alone",
        x=PAGE_W - MARGIN - 150, y=26, width=48, height=12,
        value=value,
        fontName=FORM_FONT, fontSize=7,
        textColor=STEEL, fillColor=WHITE,
        borderColor=WHITE, borderWidth=0,
        borderStyle="solid", forceBorder=False,
        relative=False,
    )
    c.setFont(SANS_L, 7)
    c.setFillColor(STEEL)
    c.drawRightString(PAGE_W - MARGIN - 152, 30, "edition")


# ────────────────────────────────────────────────────────────────── the pages ──

BOTTOM_LIMIT = 54.0   # nothing is drawn below this; the footer lives at y=30


def page_cover(c, total) -> None:
    c.setFillColor(ONYX)
    c.rect(0, PAGE_H - 232, PAGE_W, 232, stroke=0, fill=1)

    c.setFont(MONO, 8.5)
    c.setFillColor(BLADE)
    c.drawString(MARGIN, PAGE_H - 74, "FREE · NO ACCOUNT REQUIRED")

    c.setFont(DISPLAY, 31)
    c.setFillColor(WHITE)
    c.drawString(MARGIN, PAGE_H - 116, "The Transfer Sheet")

    c.setFont(SERIF, 12.5)
    c.setFillColor(HexColor("#D8D8D8"))
    y = PAGE_H - 142
    for line in wrap(
        "Carry your completed Before They Ask workbook into RaiseRoom without "
        "retyping any of it.", SERIF, 12.5, COL_W - 30,
    ):
        c.drawString(MARGIN, y, line)
        y -= 17

    c.setFont(SANS_L, 9)
    c.setFillColor(STEEL)
    c.drawString(MARGIN, PAGE_H - 206, f"Edition {FIELDS['version']}   ·   TekAIDA Consulting LLC")

    y = PAGE_H - 272
    y = section(c, y, "How to use it", "Fill it in on screen")

    y = para(
        c,
        "Open this file in any PDF reader and type into the boxes. Every box is a form field, so your "
        "answers are stored as text inside the file — not as marks on an image. When you upload it, "
        "RaiseRoom reads the characters you typed, exactly as you typed them.",
        MARGIN, y, COL_W,
    ) - 10

    y = para(
        c,
        "You do not have to fill all of it. Anything you leave blank stays blank — a blank box means "
        "“not answered yet”, never zero, and it will not count against your readiness score.",
        MARGIN, y, COL_W,
    ) - 18

    # The honest limitation, stated where it will be read rather than buried.
    box_top = y
    c.setFillColor(HexColor("#FAF8FF"))
    c.rect(MARGIN, box_top - 96, COL_W, 96, stroke=0, fill=1)
    c.setStrokeColor(BLADE)
    c.setLineWidth(2)
    c.line(MARGIN, box_top - 96, MARGIN, box_top)

    ty = box_top - 20
    c.setFont(SANS_B, 9.5)
    c.setFillColor(ONYX)
    c.drawString(MARGIN + 14, ty, "Please do not print this, write on it, and scan it back")
    ty -= 15
    para(
        c,
        "We will store a scan for you as a reference document, but we will not read figures off it. "
        "Handwriting recognition is least reliable on digits and decimal points — the one thing this "
        "sheet is made of. A concentration figure misread from 68 to 6.8 would enter your records "
        "looking perfectly clean, and you would find out in a meeting. Typing is the safe route.",
        MARGIN + 14, ty, COL_W - 28, SERIF, 8.5, 12, HexColor("#3A3A3A"),
    )

    y = box_top - 118
    y = section(c, y, "Optional", "Your workbook receipt")
    y = para(
        c,
        "If you bought Before They Ask, put the receipt reference here and your $147 credit is applied "
        "to your first annual subscription. Leave it blank if you have not bought it — the rest of the "
        "sheet still works.",
        MARGIN, y, COL_W,
    ) - 22

    textfield(c, FIELDS["meta"]["receipt"], MARGIN, y - 4, 290, 22,
              tooltip="Workbook receipt reference (optional)")
    c.setFont(SANS_L, 7.5)
    c.setFillColor(STEEL)
    c.drawString(MARGIN + 300, y + 3, "Receipt reference")

    hidden_version(c, FIELDS["version"])
    footer(c, 1, total)


def draw_scale(c, y):
    """The 0–5 scale, so the sheet stands alone if the workbook is not to hand."""
    height = len(FIELDS["scale"]) * 11 + 10
    c.setFillColor(HexColor("#F6F6F6"))
    c.rect(MARGIN, y - height, COL_W, height, stroke=0, fill=1)
    sy = y - 14
    for item in FIELDS["scale"]:
        c.setFont(MONO, 8)
        c.setFillColor(BLADE)
        c.drawString(MARGIN + 12, sy, str(item["score"]))
        c.setFont(SANS_L, 8)
        c.setFillColor(HexColor("#3A3A3A"))
        c.drawString(MARGIN + 26, sy, item["means"])
        sy -= 11
    return y - height - 18


def domain_header_height() -> float:
    return 22.0


def criterion_height(crit) -> float:
    lines = wrap(crit["text"], SERIF, 8.5, COL_W - 86)
    return max(22.0, len(lines) * 11.5) + 7


def draw_domain_header(c, y, d):
    c.setFont(SANS_B, 10)
    c.setFillColor(ONYX)
    c.drawString(MARGIN, y, f"Domain {d['n']} · {d['name']}")
    c.setFont(MONO, 7.5)
    c.setFillColor(STEEL)
    c.drawRightString(PAGE_W - MARGIN, y, f"weight ×{d['weight']}")
    y -= 6
    rule(c, MARGIN, y, COL_W)
    return y - 16


def draw_criterion(c, y, crit):
    lines = wrap(crit["text"], SERIF, 8.5, COL_W - 86)

    c.setFont(MONO, 8.5)
    c.setFillColor(BLADE)
    c.drawString(MARGIN, y, crit["ref"])

    c.setFont(SERIF, 8.5)
    c.setFillColor(HexColor("#2A2A2A"))
    ly = y
    for line in lines:
        c.drawString(MARGIN + 30, ly, line)
        ly -= 11.5

    textfield(c, crit["field"], PAGE_W - MARGIN - 34, y - 5, 34, 19,
              tooltip=f"Criterion {crit['ref']} — score 0 to 5", size=10)

    return y - criterion_height(crit)


def plan_score_pages(c):
    """
    Work out which criteria land on which page, by measuring rather than by a
    fixed split.

    The first version of this put four domains on each of two pages, which fit
    until the criterion wording was a line longer than assumed and the last two
    rows ran off the bottom of the page underneath the footer. Measuring means
    the sheet re-flows instead of silently losing boxes if the catalogue is ever
    edited — and the catalogue is meant to be edited.
    """
    pages: list[list[tuple]] = []
    current: list[tuple] = []

    # Page 1 of the scores carries the heading and the scale block.
    y = PAGE_H - MARGIN - 8 - 62          # section() consumes ~62pt with a blurb
    y = y - (len(FIELDS["scale"]) * 11 + 10) - 18
    first_page = True

    for d in FIELDS["domains"]:
        # Never leave a domain heading stranded at the foot of a page.
        if y - domain_header_height() - criterion_height(d["criteria"][0]) < BOTTOM_LIMIT:
            pages.append(current)
            current = []
            first_page = False
            y = PAGE_H - MARGIN - 8 - 44   # continuation heading, no blurb

        current.append(("domain", d))
        y -= domain_header_height()

        for crit in d["criteria"]:
            if y - criterion_height(crit) < BOTTOM_LIMIT:
                pages.append(current)
                current = []
                first_page = False
                y = PAGE_H - MARGIN - 8 - 44
                current.append(("domain", d))      # repeat the heading after a break
                y -= domain_header_height()
            current.append(("criterion", crit))
            y -= criterion_height(crit)

        y -= 10

    if current:
        pages.append(current)
    return pages


def page_scores(c, items, page_no, total, first) -> None:
    y = PAGE_H - MARGIN - 8

    if first:
        y = section(
            c, y, "Worksheet 1", "Your 32 scores",
            "Copy the score you gave each criterion. The scale is 0 to 5, whole numbers only. "
            "Leave a box empty if you have not scored it yet.",
        )
        y = draw_scale(c, y)
    else:
        y = section(c, y, "Worksheet 1, continued", "Your 32 scores")

    for kind, payload in items:
        if kind == "domain":
            y = draw_domain_header(c, y, payload)
        else:
            y = draw_criterion(c, y, payload)

    footer(c, page_no, total)


def field_row(c, y, label, name, *, width=170, hint=None, height=22):
    c.setFont(SANS, 9)
    c.setFillColor(ONYX)
    c.drawString(MARGIN, y + 6, label)
    textfield(c, name, MARGIN + 280, y, width, height, tooltip=hint or label)
    if hint:
        c.setFont(SANS_L, 7.5)
        c.setFillColor(STEEL)
        c.drawString(MARGIN + 280 + width + 8, y + 7, hint)
    return y - (height + 12)


def page_figures(c, page_no, total) -> None:
    by_field = {f["field"]: f for f in FIELDS["fact_fields"]}
    y = PAGE_H - MARGIN - 8

    y = section(
        c, y, "Worksheet 3", "The normalisation bridge",
        "Reported profit, and what the business actually earns once one-off and owner-specific items "
        "are taken out. Figures in whole units — no currency symbols needed.",
    )
    y = field_row(c, y - 4, "Reported profit", "norm_reported_profit", hint="e.g. 420000")
    y = field_row(c, y, "Normalised earnings", "norm_normalised_earnings", hint="e.g. 610000")
    y = field_row(c, y, "Period this covers", "norm_period", hint="e.g. FY2025")

    y -= 14
    y = section(
        c, y, "Worksheet 4", "Customer concentration",
        "Share of revenue, as a percentage between 0 and 100. The two-year-ago figure is what makes the "
        "trend visible, which is the part a counterparty asks about.",
    )
    y = field_row(c, y - 4, "Top 1 customer, share of revenue", "conc_top1", width=90, hint="%")
    y = field_row(c, y, "Top 3 customers, share of revenue", "conc_top3", width=90, hint="%")
    y = field_row(c, y, "Top 5 customers, share of revenue", "conc_top5", width=90, hint="%")
    y = field_row(c, y, "Top 1 customer, two years ago", "conc_top1_prior", width=90, hint="%")
    c.setFont(SANS_L, 7.5)
    c.setFillColor(STEEL)
    c.drawString(MARGIN, y - 4, " / ".join(x.title() for x in FIELDS["direction_choices"]))
    y = field_row(c, y + 8, "Direction of travel", "conc_direction", width=170)
    y -= 6

    y -= 10
    para(
        c,
        "If the top-1 share has risen while revenue grew, growth is coming from one relationship. "
        "That is a different conversation from the same share on a larger base, and it is better to "
        "be the one who raises it.",
        MARGIN, y, COL_W, SERIF_I, 8.5, 12, HexColor("#555555"),
    )

    assert set(by_field) >= {
        "norm_reported_profit", "norm_normalised_earnings", "norm_period",
        "conc_top1", "conc_top3", "conc_top5", "conc_top1_prior", "conc_direction",
    }, "fields.json and this page have diverged"

    footer(c, page_no, total)


def page_people_and_assumptions(c, page_no, total) -> None:
    y = PAGE_H - MARGIN - 8

    y = section(
        c, y, "Worksheet 5", "Key-person dependency",
        "Who uniquely holds something this business depends on — a relationship, a piece of knowledge, "
        "an access right. Name the thing, not the job title. Both columns are needed: a name on its own "
        "records nothing.",
    )

    head_y = y
    c.setFont(SANS_B, 7.5)
    c.setFillColor(STEEL)
    c.drawString(MARGIN, head_y, "PERSON")
    c.drawString(MARGIN + 132, head_y, "WHAT THEY UNIQUELY HOLD")
    c.drawString(MARGIN + 374, head_y, "DEPUTY, IF ANY")
    y -= 26

    for row in FIELDS["key_person_fields"]:
        textfield(c, row["person"], MARGIN, y - 4, 124, 22, tooltip=f"Key person {row['row']} — name")
        textfield(c, row["holds"], MARGIN + 132, y - 4, 236, 22,
                  tooltip=f"Key person {row['row']} — what they uniquely hold")
        textfield(c, row["deputy"], MARGIN + 374, y - 4, 130, 22,
                  tooltip=f"Key person {row['row']} — deputy, if any")
        y -= 32

    y -= 10
    y = section(
        c, y, "Worksheet 9", "The three load-bearing assumptions",
        "The three things your plan most depends on. Write each one so that it could be shown to be "
        "wrong — an assumption nothing could disprove is a hope.",
    )

    y -= 12
    for i, name in enumerate(["assum_1", "assum_2", "assum_3"], start=1):
        c.setFont(MONO, 8.5)
        c.setFillColor(BLADE)
        c.drawString(MARGIN, y + 8, str(i))
        textfield(c, name, MARGIN + 20, y, COL_W - 20, 26, tooltip=f"Load-bearing assumption {i}")
        y -= 38

    y -= 16
    y = section(c, y, "Next", "What happens when you upload it")
    para(
        c,
        "Your scores become a readiness assessment with its band and its gap register, already in fix "
        "order. Your figures become facts in your own fact store, each marked as entered by you — "
        "because you typed them, and nothing has been parsed, inferred or guessed. Nothing is published, "
        "nothing is shared, and nothing leaves your organisation.",
        MARGIN, y, COL_W,
    )

    footer(c, page_no, total)


def build(out_path: Path) -> None:
    register_fonts()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    c = canvas.Canvas(str(out_path), pagesize=LETTER)
    c.setTitle(f"RaiseRoom Transfer Sheet (edition {FIELDS['version']})")
    c.setAuthor("TekAIDA Consulting LLC")
    c.setSubject("Carry a completed Before They Ask workbook into RaiseRoom")
    c.setCreator("RaiseRoom tools/transfer_sheet.py")

    score_pages = plan_score_pages(c)
    total = 1 + len(score_pages) + 2

    page_cover(c, total)
    c.showPage()

    for i, items in enumerate(score_pages):
        page_scores(c, items, 2 + i, total, first=(i == 0))
        c.showPage()

    page_figures(c, 2 + len(score_pages), total)
    c.showPage()
    page_people_and_assumptions(c, 3 + len(score_pages), total)
    c.showPage()

    c.save()


if __name__ == "__main__":
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "out/RaiseRoom_Transfer-Sheet.pdf")
    build(target)
    print(f"wrote {target}")
