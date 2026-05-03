"""Generate demo-vault/sample.pdf — a one-page document with an equation,
a data table, and a small chart, used by the PDF marquee tutorial note."""

from pathlib import Path

from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.shapes import Drawing, String
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "demo-vault" / "sample.pdf"
    out.parent.mkdir(parents=True, exist_ok=True)

    doc = SimpleDocTemplate(
        str(out),
        pagesize=LETTER,
        leftMargin=0.9 * inch,
        rightMargin=0.9 * inch,
        topMargin=0.9 * inch,
        bottomMargin=0.9 * inch,
        title="vault-chat marquee demo",
    )
    styles = getSampleStyleSheet()

    title_style = ParagraphStyle(
        "title",
        parent=styles["Heading1"],
        fontSize=20,
        leading=24,
        spaceAfter=10,
    )
    body_style = ParagraphStyle(
        "body",
        parent=styles["BodyText"],
        fontSize=11,
        leading=15,
        spaceAfter=10,
    )
    eq_style = ParagraphStyle(
        "eq",
        parent=styles["BodyText"],
        fontSize=18,
        leading=22,
        alignment=1,
        spaceBefore=8,
        spaceAfter=14,
        fontName="Helvetica",
    )
    section_style = ParagraphStyle(
        "section",
        parent=styles["Heading2"],
        fontSize=13,
        leading=16,
        spaceBefore=12,
        spaceAfter=6,
    )
    note_style = ParagraphStyle(
        "note",
        parent=styles["BodyText"],
        fontSize=10,
        leading=13,
        textColor=colors.HexColor("#666"),
        fontName="Helvetica-Oblique",
    )

    story = []
    story.append(Paragraph("Sample document", title_style))
    story.append(
        Paragraph(
            "This page exists to show off vault-chat's PDF marquee. "
            "Drag a rectangle around any region — the equation, the table, the chart — "
            "and ask the model about it. The model gets the pixels of what you boxed, "
            "which is why it works on rendered math, scanned pages, and handwriting.",
            body_style,
        )
    )

    story.append(Paragraph("A quadratic to solve", section_style))
    story.append(
        Paragraph(
            "Drag a box around the equation below and ask <i>solve for x</i>.",
            body_style,
        )
    )
    story.append(Paragraph("2x<super>2</super> + 5x &minus; 3 = 0", eq_style))

    story.append(Paragraph("Quarterly revenue, 2021&ndash;2024", section_style))
    story.append(
        Paragraph(
            "Drag a box around the table and ask <i>what was the average year-over-year "
            "growth?</i> &mdash; or box just the chart and ask <i>what trend does this show?</i>",
            body_style,
        )
    )

    table_data = [
        ["Year", "Revenue ($M)", "YoY growth"],
        ["2021", "1.2", "—"],
        ["2022", "1.8", "+50%"],
        ["2023", "2.4", "+33%"],
        ["2024", "4.1", "+71%"],
    ]
    tbl = Table(table_data, colWidths=[1.2 * inch, 1.6 * inch, 1.4 * inch])
    tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef2ff")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 11),
                ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                ("BOTTOMPADDING", (0, 0), (-1, 0), 8),
                ("TOPPADDING", (0, 0), (-1, 0), 8),
                ("BOTTOMPADDING", (0, 1), (-1, -1), 6),
                ("TOPPADDING", (0, 1), (-1, -1), 6),
                ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor("#999")),
                ("LINEBELOW", (0, -1), (-1, -1), 0.4, colors.HexColor("#ddd")),
                (
                    "ROWBACKGROUNDS",
                    (0, 1),
                    (-1, -1),
                    [colors.white, colors.HexColor("#fafafa")],
                ),
            ]
        )
    )
    story.append(tbl)

    story.append(Spacer(1, 0.25 * inch))

    drawing = Drawing(360, 170)
    chart = VerticalBarChart()
    chart.x = 50
    chart.y = 30
    chart.width = 290
    chart.height = 120
    chart.data = [[1.2, 1.8, 2.4, 4.1]]
    chart.categoryAxis.categoryNames = ["2021", "2022", "2023", "2024"]
    chart.valueAxis.valueMin = 0
    chart.valueAxis.valueMax = 5
    chart.valueAxis.valueStep = 1
    chart.bars[0].fillColor = colors.HexColor("#6366f1")
    chart.bars[0].strokeColor = None
    chart.barWidth = 16
    chart.barSpacing = 8
    chart.categoryAxis.labels.fontSize = 10
    chart.valueAxis.labels.fontSize = 9
    drawing.add(chart)
    drawing.add(
        String(
            50,
            155,
            "Revenue ($M)",
            fontSize=10,
            fillColor=colors.HexColor("#444"),
            fontName="Helvetica-Bold",
        )
    )
    story.append(drawing)

    story.append(Spacer(1, 0.15 * inch))
    story.append(
        Paragraph(
            "&larr; the 2024 jump is suspicious &mdash; double-check the underlying numbers before citing.",
            note_style,
        )
    )

    doc.build(story)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
