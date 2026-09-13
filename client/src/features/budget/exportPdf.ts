/**
 * PDF reports, monthly and annual.
 *
 * Drawn directly rather than screenshotting the DOM: a rasterised page prints
 * blurry, cannot be searched or copied, and carries the app's dark theme onto
 * paper. Drawing means real text, real vectors, and a white ground — while
 * keeping the on-screen structure, so the report reads as the same document.
 *
 * jsPDF is ~350kb, so this module is only reached through a dynamic import.
 */
import type { MonthReport, YearReport } from './reportData';

type JsPdf = import('jspdf').jsPDF;

/** A4 portrait, in mm — jsPDF's default unit here. */
const PAGE = { width: 210, height: 297 };
const MARGIN = 14;
/** Three cards across, matching the screen's widest layout. */
const COLUMNS = 3;
const GUTTER = 5;
const CARD_WIDTH = (PAGE.width - MARGIN * 2 - GUTTER * (COLUMNS - 1)) / COLUMNS;

const INK = { r: 26, g: 26, b: 26 };
const MUTED = { r: 118, g: 118, b: 118 };
const FAINT = { r: 200, g: 200, b: 200 };

function rgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

/** Grouped thousands, no currency code — the code is stated once per page. */
function num(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export async function exportMonthToPdf(report: MonthReport): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }) as JsPdf;

  drawHeader(
    doc,
    'Monthly expenses',
    report.monthLabel,
    report.currency,
    report.generatedAt,
  );

  let y = 38;
  y = drawKpis(doc, report, y);

  // ---- Cards -------------------------------------------------------------
  // Measured before drawing so a card is never split across a page break.
  let column = 0;
  let rowTop = y + 4;
  let rowTallest = 0;

  for (const card of report.cards) {
    const height = measureCard(card);

    if (column === 0 && rowTop + height > PAGE.height - MARGIN - 8) {
      doc.addPage();
      drawPageFrame(doc, report.currency);
      rowTop = MARGIN + 10;
      rowTallest = 0;
    }

    const x = MARGIN + column * (CARD_WIDTH + GUTTER);
    drawCard(doc, card, x, rowTop);
    rowTallest = Math.max(rowTallest, height);
    column++;

    if (column === COLUMNS) {
      column = 0;
      rowTop += rowTallest + GUTTER;
      rowTallest = 0;
    }
  }

  if (column !== 0) rowTop += rowTallest + GUTTER;

  // ---- Where it went -----------------------------------------------------
  if (report.categories.length > 0) {
    // Measure what is actually about to be drawn. A fixed reservation broke
    // the page for a three-row table that would have fitted, leaving most of
    // a page blank.
    const needed = 12 + report.categories.length * 6;
    if (rowTop + needed > PAGE.height - MARGIN - 6) {
      doc.addPage();
      drawPageFrame(doc, report.currency);
      rowTop = MARGIN + 10;
    }
    rowTop = drawCategoryTable(doc, report, rowTop + 4);
  }

  // ---- One-offs ----------------------------------------------------------
  if (report.oneOffs.length > 0) {
    const needed = 12 + report.oneOffs.length * 5;
    if (rowTop + needed > PAGE.height - MARGIN - 6) {
      doc.addPage();
      drawPageFrame(doc, report.currency);
      rowTop = MARGIN + 10;
    }
    drawSectionTitle(doc, 'One-off entries', MARGIN, rowTop + 6);
    let y2 = rowTop + 12;
    doc.setFontSize(9);
    for (const entry of report.oneOffs) {
      doc.setTextColor(INK.r, INK.g, INK.b);
      doc.text(
        `${entry.label} · ${new Date(entry.date).toLocaleDateString()}`,
        MARGIN,
        y2,
      );
      const sign = entry.kind === 'income' ? '+' : '−';
      doc.text(`${sign}${num(entry.amount)}`, PAGE.width - MARGIN, y2, {
        align: 'right',
      });
      y2 += 5;
    }
  }

  stampPageNumbers(doc);
  return doc.output('blob');
}

function drawHeader(
  doc: JsPdf,
  title: string,
  subject: string,
  currency: string,
  generatedAt: number,
): void {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(INK.r, INK.g, INK.b);
  doc.text(title, MARGIN, MARGIN + 6);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(MUTED.r, MUTED.g, MUTED.b);
  doc.text(subject, MARGIN, MARGIN + 13);

  doc.setFontSize(8);
  doc.text(
    `Generated ${new Date(generatedAt).toLocaleString()} · amounts in ${currency}`,
    PAGE.width - MARGIN,
    MARGIN + 6,
    { align: 'right' },
  );

  doc.setDrawColor(FAINT.r, FAINT.g, FAINT.b);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, MARGIN + 17, PAGE.width - MARGIN, MARGIN + 17);
}

/** Minimal running header for continuation pages. */
function drawPageFrame(doc: JsPdf, currency: string): void {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(MUTED.r, MUTED.g, MUTED.b);
  doc.text(`AminFinance · amounts in ${currency}`, MARGIN, MARGIN);
  doc.setDrawColor(FAINT.r, FAINT.g, FAINT.b);
  doc.line(MARGIN, MARGIN + 2, PAGE.width - MARGIN, MARGIN + 2);
}

function drawKpis(doc: JsPdf, report: MonthReport, top: number): number {
  const tiles: Array<[string, string, string]> = [
    ['Income', num(report.summary.income), '#1baf7a'],
    ['Spent', num(report.summary.expenses), '#e34948'],
    ['Saved', num(report.summary.saved), '#2a78d6'],
    [
      'Savings rate',
      report.summary.savingsRate === null
        ? '—'
        : `${report.summary.savingsRate.toFixed(1)}%`,
      '#eda100',
    ],
  ];

  const width = (PAGE.width - MARGIN * 2 - 3 * 4) / 4;

  tiles.forEach(([label, value, hex], i) => {
    const x = MARGIN + i * (width + 4);
    const [r, g, b] = rgb(hex);

    doc.setFillColor(250, 250, 250);
    doc.roundedRect(x, top, width, 18, 1.5, 1.5, 'F');
    // A thin accent spine, echoing the coloured card headers on screen.
    doc.setFillColor(r, g, b);
    doc.rect(x, top, 1, 18, 'F');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(MUTED.r, MUTED.g, MUTED.b);
    doc.text(label.toUpperCase(), x + 4, top + 6);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(r, g, b);
    doc.text(value, x + 4, top + 14);
  });

  let y = top + 22;

  if (report.summary.deductions > 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(MUTED.r, MUTED.g, MUTED.b);
    doc.text(
      `Income is take-home: gross ${num(report.summary.grossIncome)} less ${num(report.summary.deductions)} withheld.`,
      MARGIN,
      y,
    );
    y += 4;
  }

  return y;
}

const CARD_HEADER_H = 9;
const CARD_ROW_H = 5;
const CARD_PAD = 3;

function measureCard(card: MonthReport['cards'][number]): number {
  const deductionRows = card.withheld > 0 ? 2 : 0;
  return (
    CARD_HEADER_H +
    CARD_PAD +
    card.rows.length * CARD_ROW_H +
    deductionRows * CARD_ROW_H +
    CARD_ROW_H + // total row
    CARD_PAD
  );
}

function drawCard(
  doc: JsPdf,
  card: MonthReport['cards'][number],
  x: number,
  top: number,
): void {
  const [r, g, b] = rgb(card.group.hex);
  const height = measureCard(card);

  doc.setDrawColor(230, 230, 230);
  doc.setLineWidth(0.2);
  doc.roundedRect(x, top, CARD_WIDTH, height, 1.5, 1.5, 'S');

  // Header band in the card's accent.
  doc.setFillColor(r, g, b);
  doc.roundedRect(x, top, CARD_WIDTH, CARD_HEADER_H, 1.5, 1.5, 'F');
  doc.rect(x, top + CARD_HEADER_H - 2, CARD_WIDTH, 2, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(255, 255, 255);
  doc.text(card.group.label, x + 3, top + 4.2);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.text(
    card.filledCount > 0
      ? `${card.filledCount} of ${card.itemCount} filled in`
      : card.group.hint,
    x + 3,
    top + 7.5,
  );

  let y = top + CARD_HEADER_H + CARD_PAD + 1;
  doc.setFontSize(7.5);

  for (const row of card.rows) {
    const filled = row.amount > 0;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(
      filled ? INK.r : 165,
      filled ? INK.g : 165,
      filled ? INK.b : 165,
    );
    const label = row.isDeduction ? `- ${row.label}` : row.label;
    doc.text(clip(doc, label, CARD_WIDTH - 22), x + 3, y);

    if (filled) {
      if (row.isDeduction) doc.setTextColor(227, 73, 72);
      doc.text(num(row.amount), x + CARD_WIDTH - 3, y, { align: 'right' });
    } else {
      doc.setTextColor(200, 200, 200);
      doc.text('—', x + CARD_WIDTH - 3, y, { align: 'right' });
    }
    y += CARD_ROW_H;
  }

  if (card.withheld > 0) {
    doc.setTextColor(MUTED.r, MUTED.g, MUTED.b);
    doc.text('Gross', x + 3, y);
    doc.text(num(card.gross), x + CARD_WIDTH - 3, y, { align: 'right' });
    y += CARD_ROW_H;

    doc.setTextColor(227, 73, 72);
    doc.text('Deducted', x + 3, y);
    doc.text(`-${num(card.withheld)}`, x + CARD_WIDTH - 3, y, { align: 'right' });
    y += CARD_ROW_H;
  }

  doc.setDrawColor(r, g, b);
  doc.setLineWidth(0.3);
  doc.line(x + 3, y - 3.2, x + CARD_WIDTH - 3, y - 3.2);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(INK.r, INK.g, INK.b);
  doc.text(card.withheld > 0 ? 'Take-home' : 'Total', x + 3, y);
  doc.setTextColor(r, g, b);
  doc.text(num(card.total), x + CARD_WIDTH - 3, y, { align: 'right' });
}

/** Truncate to fit a column, so a long label cannot run into the amount. */
function clip(doc: JsPdf, text: string, maxWidth: number): string {
  if (doc.getTextWidth(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && doc.getTextWidth(`${out}…`) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

function drawSectionTitle(doc: JsPdf, text: string, x: number, y: number): void {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(INK.r, INK.g, INK.b);
  doc.text(text, x, y);
}

function drawCategoryTable(doc: JsPdf, report: MonthReport, top: number): number {
  drawSectionTitle(doc, 'Where it went', MARGIN, top + 6);

  let y = top + 12;
  const barLeft = MARGIN + 62;
  const barWidth = PAGE.width - MARGIN - barLeft - 34;
  const max = Math.max(...report.categories.map((c) => c.amount), 1);

  doc.setFontSize(8);
  for (const category of report.categories) {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(INK.r, INK.g, INK.b);
    doc.text(clip(doc, category.label, 58), MARGIN, y);

    // Bars are scaled to the largest row, matching the on-screen breakdown.
    doc.setFillColor(235, 235, 235);
    doc.rect(barLeft, y - 2.6, barWidth, 2.6, 'F');
    doc.setFillColor(42, 120, 214);
    doc.rect(barLeft, y - 2.6, (category.amount / max) * barWidth, 2.6, 'F');

    doc.setTextColor(MUTED.r, MUTED.g, MUTED.b);
    doc.text(`${(category.share * 100).toFixed(1)}%`, barLeft + barWidth + 3, y);

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(INK.r, INK.g, INK.b);
    doc.text(num(category.amount), PAGE.width - MARGIN, y, { align: 'right' });
    y += 6;
  }

  return y;
}

export async function exportYearToPdf(report: YearReport): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }) as JsPdf;

  drawHeader(
    doc,
    'Annual summary',
    String(report.year),
    report.currency,
    report.generatedAt,
  );

  let y = 40;

  // ---- Year KPIs ---------------------------------------------------------
  const tiles: Array<[string, string, string]> = [
    ['Income', num(report.totals.income), '#1baf7a'],
    ['Spent', num(report.totals.expenses), '#e34948'],
    ['Saved', num(report.totals.saved), '#2a78d6'],
    [
      'Savings rate',
      report.totals.savingsRate === null
        ? '—'
        : `${report.totals.savingsRate.toFixed(1)}%`,
      '#eda100',
    ],
  ];
  const width = (PAGE.width - MARGIN * 2 - 3 * 4) / 4;
  tiles.forEach(([label, value, hex], i) => {
    const x = MARGIN + i * (width + 4);
    const [r, g, b] = rgb(hex);
    doc.setFillColor(250, 250, 250);
    doc.roundedRect(x, y, width, 18, 1.5, 1.5, 'F');
    doc.setFillColor(r, g, b);
    doc.rect(x, y, 1, 18, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(MUTED.r, MUTED.g, MUTED.b);
    doc.text(label.toUpperCase(), x + 4, y + 6);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(r, g, b);
    doc.text(value, x + 4, y + 14);
  });
  y += 22;

  if (report.totals.deductions > 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(MUTED.r, MUTED.g, MUTED.b);
    doc.text(
      `Take-home across ${report.totals.activeMonths} month(s) with data · gross ${num(report.totals.grossIncome)} less ${num(report.totals.deductions)} withheld.`,
      MARGIN,
      y,
    );
    y += 5;
  }

  // ---- Month-by-month chart ---------------------------------------------
  drawSectionTitle(doc, 'Income vs spending', MARGIN, y + 6);
  y += 10;
  y = drawYearChart(doc, report, y);

  // ---- Month table -------------------------------------------------------
  drawSectionTitle(doc, 'Month by month', MARGIN, y + 8);
  y += 13;

  const cols = [MARGIN, MARGIN + 52, MARGIN + 90, MARGIN + 128, PAGE.width - MARGIN];
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(MUTED.r, MUTED.g, MUTED.b);
  doc.text('Month', cols[0]!, y);
  doc.text('Income', cols[1]!, y, { align: 'right' });
  doc.text('Spent', cols[2]!, y, { align: 'right' });
  doc.text('Saved', cols[3]!, y, { align: 'right' });
  doc.text('Rate', cols[4]!, y, { align: 'right' });
  y += 1.5;
  doc.setDrawColor(FAINT.r, FAINT.g, FAINT.b);
  doc.line(MARGIN, y, PAGE.width - MARGIN, y);
  y += 4;

  doc.setFont('helvetica', 'normal');
  for (const month of report.months) {
    const empty = month.income === 0 && month.expenses === 0;
    doc.setTextColor(empty ? 175 : INK.r, empty ? 175 : INK.g, empty ? 175 : INK.b);
    doc.text(month.label, cols[0]!, y);
    doc.text(num(month.income), cols[1]!, y, { align: 'right' });
    doc.text(num(month.expenses), cols[2]!, y, { align: 'right' });
    doc.text(num(month.saved), cols[3]!, y, { align: 'right' });
    doc.text(
      month.savingsRate === null ? '—' : `${month.savingsRate.toFixed(1)}%`,
      cols[4]!,
      y,
      { align: 'right' },
    );
    y += 5.5;
  }

  doc.setDrawColor(FAINT.r, FAINT.g, FAINT.b);
  doc.line(MARGIN, y - 3.5, PAGE.width - MARGIN, y - 3.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(INK.r, INK.g, INK.b);
  doc.text('Year total', cols[0]!, y);
  doc.text(num(report.totals.income), cols[1]!, y, { align: 'right' });
  doc.text(num(report.totals.expenses), cols[2]!, y, { align: 'right' });
  doc.text(num(report.totals.saved), cols[3]!, y, { align: 'right' });
  doc.text(
    report.totals.savingsRate === null
      ? '—'
      : `${report.totals.savingsRate.toFixed(1)}%`,
    cols[4]!,
    y,
    { align: 'right' },
  );
  y += 10;

  // ---- By card + categories, on a fresh page if tight --------------------
  const cardBlock = 6 + report.cardTotals.length * 5.5;
  if (y + cardBlock > PAGE.height - MARGIN - 6) {
    doc.addPage();
    drawPageFrame(doc, report.currency);
    y = MARGIN + 12;
  }

  drawSectionTitle(doc, 'By card', MARGIN, y);
  y += 6;
  doc.setFontSize(8);
  for (const { group, total } of report.cardTotals) {
    const [r, g, b] = rgb(group.hex);
    doc.setFillColor(r, g, b);
    doc.rect(MARGIN, y - 2.4, 2, 2.4, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(INK.r, INK.g, INK.b);
    doc.text(group.label, MARGIN + 4, y);
    doc.setFont('helvetica', 'bold');
    doc.text(num(total), MARGIN + 80, y, { align: 'right' });
    y += 5.5;
  }

  if (report.categories.length > 0) {
    y += 4;
    const catBlock = 6 + report.categories.length * 6;
    if (y + catBlock > PAGE.height - MARGIN - 6) {
      doc.addPage();
      drawPageFrame(doc, report.currency);
      y = MARGIN + 12;
    }
    drawSectionTitle(doc, 'Where it went', MARGIN, y);
    y += 6;
    const max = Math.max(...report.categories.map((c) => c.amount), 1);
    const barLeft = MARGIN + 62;
    const barWidth = PAGE.width - MARGIN - barLeft - 34;
    doc.setFontSize(8);
    for (const category of report.categories) {
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(INK.r, INK.g, INK.b);
      doc.text(clip(doc, category.label, 58), MARGIN, y);
      doc.setFillColor(235, 235, 235);
      doc.rect(barLeft, y - 2.6, barWidth, 2.6, 'F');
      doc.setFillColor(42, 120, 214);
      doc.rect(barLeft, y - 2.6, (category.amount / max) * barWidth, 2.6, 'F');
      doc.setTextColor(MUTED.r, MUTED.g, MUTED.b);
      doc.text(`${(category.share * 100).toFixed(1)}%`, barLeft + barWidth + 3, y);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(INK.r, INK.g, INK.b);
      doc.text(num(category.amount), PAGE.width - MARGIN, y, { align: 'right' });
      y += 6;
    }
  }

  stampPageNumbers(doc);
  return doc.output('blob');
}

/** Paired income/spending bars, the same comparison the screen chart makes. */
function drawYearChart(doc: JsPdf, report: YearReport, top: number): number {
  const height = 34;
  const left = MARGIN + 18;
  const width = PAGE.width - MARGIN - left;
  const max = Math.max(
    ...report.months.map((m) => Math.max(m.income, m.expenses)),
    1,
  );
  const baseline = top + height;

  // Gridlines at 0, 50%, 100%.
  doc.setFontSize(6);
  doc.setDrawColor(238, 238, 238);
  doc.setLineWidth(0.2);
  for (const fraction of [0, 0.5, 1]) {
    const y = baseline - fraction * height;
    doc.line(left, y, left + width, y);
    doc.setTextColor(MUTED.r, MUTED.g, MUTED.b);
    doc.text(num(max * fraction), left - 2, y + 1, { align: 'right' });
  }

  const slot = width / 12;
  const barWidth = Math.min(3.2, (slot * 0.62) / 2);

  report.months.forEach((month, i) => {
    const centre = left + slot * i + slot / 2;
    const incomeH = (month.income / max) * height;
    const expenseH = (month.expenses / max) * height;

    doc.setFillColor(27, 175, 122);
    doc.rect(centre - barWidth - 0.4, baseline - incomeH, barWidth, incomeH, 'F');
    doc.setFillColor(227, 73, 72);
    doc.rect(centre + 0.4, baseline - expenseH, barWidth, expenseH, 'F');

    doc.setTextColor(MUTED.r, MUTED.g, MUTED.b);
    doc.text(month.label.slice(0, 3), centre, baseline + 3.5, { align: 'center' });
  });

  // Legend.
  const legendY = baseline + 8;
  doc.setFillColor(27, 175, 122);
  doc.rect(left, legendY - 2, 2.4, 2.4, 'F');
  doc.setTextColor(MUTED.r, MUTED.g, MUTED.b);
  doc.setFontSize(7);
  doc.text('Income', left + 4, legendY);
  doc.setFillColor(227, 73, 72);
  doc.rect(left + 20, legendY - 2, 2.4, 2.4, 'F');
  doc.text('Spending', left + 24, legendY);

  return legendY + 2;
}

function stampPageNumbers(doc: JsPdf): void {
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(MUTED.r, MUTED.g, MUTED.b);
    doc.text(`${i} of ${pages}`, PAGE.width - MARGIN, PAGE.height - 8, {
      align: 'right',
    });
  }
}
