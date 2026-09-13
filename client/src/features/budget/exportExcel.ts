/**
 * Excel export.
 *
 * The sheet reproduces the on-screen layout: the same cards, in the same
 * three-column grid, in the same order, each with its accent header, its line
 * items, and its subtotal. Someone who knows the page should recognise the
 * workbook immediately rather than having to re-learn a flat table.
 *
 * ExcelJS is ~900kb, so this module is only ever reached through a dynamic
 * import from the export menu — it must never land in the initial bundle.
 */
import type { MonthReport, YearReport } from './reportData';
import { formatMonthShort } from '@/lib/calc/budget';

/** Card grid width, matching the page's `xl:grid-cols-3`. */
const COLUMNS = 3;
/** Spreadsheet columns per card: label + amount, then a spacer. */
const CARD_WIDTH = 2;
const GUTTER = 1;

type Workbook = import('exceljs').Workbook;
type Worksheet = import('exceljs').Worksheet;

/** `#2a78d6` → `FF2A78D6`, the ARGB form ExcelJS wants. */
function argb(hex: string): string {
  return `FF${hex.replace('#', '').toUpperCase()}`;
}

function currencyFormat(currency: string): string {
  // Escaped so a code like PKR is treated as a literal prefix, not as format
  // tokens — an unescaped "D" or "M" would be read as date placeholders.
  const prefix = currency.replace(/./g, (c) => `\\${c}`);
  return `${prefix}\\ #,##0;[Red]-${prefix}\\ #,##0`;
}

/** First spreadsheet column (1-based) for a card at grid position `index`. */
function cardOrigin(index: number): number {
  return (index % COLUMNS) * (CARD_WIDTH + GUTTER) + 1;
}

export async function exportMonthToExcel(report: MonthReport): Promise<Blob> {
  const ExcelJS = await import('exceljs');
  const workbook: Workbook = new ExcelJS.Workbook();
  workbook.creator = 'AminFinance';
  workbook.created = new Date(report.generatedAt);

  buildMonthSheet(workbook, report);
  buildCategorySheet(workbook, report);
  buildDataSheet(workbook, report);

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function buildMonthSheet(workbook: Workbook, report: MonthReport): void {
  const sheet = workbook.addWorksheet(report.monthLabel, {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  });

  const money = currencyFormat(report.currency);

  // Column widths: label columns wide, amount columns narrower, gutters thin.
  for (let i = 0; i < COLUMNS; i++) {
    const origin = cardOrigin(i);
    sheet.getColumn(origin).width = 30;
    sheet.getColumn(origin + 1).width = 16;
    if (i < COLUMNS - 1) sheet.getColumn(origin + 2).width = 3;
  }

  // ---- Title -------------------------------------------------------------
  sheet.mergeCells(1, 1, 1, COLUMNS * (CARD_WIDTH + GUTTER));
  const title = sheet.getCell(1, 1);
  title.value = `Monthly expenses — ${report.monthLabel}`;
  title.font = { size: 16, bold: true, color: { argb: 'FF1A1A1A' } };
  sheet.getRow(1).height = 24;

  sheet.mergeCells(2, 1, 2, COLUMNS * (CARD_WIDTH + GUTTER));
  const subtitle = sheet.getCell(2, 1);
  subtitle.value = `Generated ${new Date(report.generatedAt).toLocaleString()} · all amounts in ${report.currency}`;
  subtitle.font = { size: 9, color: { argb: 'FF767676' } };

  // ---- KPI strip ---------------------------------------------------------
  const kpiRow = 4;
  const kpis: Array<[string, number | string, string]> = [
    ['Income', report.summary.income, '#1baf7a'],
    ['Spent', report.summary.expenses, '#e34948'],
    ['Saved', report.summary.saved, '#2a78d6'],
    [
      'Savings rate',
      report.summary.savingsRate === null
        ? '—'
        : `${report.summary.savingsRate.toFixed(1)}%`,
      '#eda100',
    ],
  ];

  kpis.forEach(([label, value, hex], i) => {
    const col = i * 2 + 1;
    const labelCell = sheet.getCell(kpiRow, col);
    labelCell.value = label;
    labelCell.font = { size: 9, bold: true, color: { argb: 'FF767676' } };

    const valueCell = sheet.getCell(kpiRow + 1, col);
    valueCell.value = value;
    valueCell.font = { size: 14, bold: true, color: { argb: argb(hex) } };
    if (typeof value === 'number') valueCell.numFmt = money;
  });

  if (report.summary.deductions > 0) {
    const note = sheet.getCell(kpiRow + 2, 1);
    note.value = `Income is take-home: gross ${report.summary.grossIncome.toLocaleString()} less ${report.summary.deductions.toLocaleString()} withheld.`;
    note.font = { size: 9, italic: true, color: { argb: 'FF767676' } };
  }

  // ---- Cards -------------------------------------------------------------
  // Each grid row is laid out independently and its height is the tallest card
  // in that row, so a short card does not drag the next row up beside it.
  let rowCursor = kpiRow + 4;

  for (let i = 0; i < report.cards.length; i += COLUMNS) {
    const rowCards = report.cards.slice(i, i + COLUMNS);
    let tallest = 0;

    rowCards.forEach((card, columnIndex) => {
      const origin = cardOrigin(columnIndex);
      const used = writeCard(sheet, card, rowCursor, origin, money);
      tallest = Math.max(tallest, used);
    });

    rowCursor += tallest + 2;
  }

  // ---- One-offs ----------------------------------------------------------
  if (report.oneOffs.length > 0) {
    rowCursor += 1;
    const heading = sheet.getCell(rowCursor, 1);
    heading.value = 'One-off entries';
    heading.font = { size: 11, bold: true };
    rowCursor++;

    for (const entry of report.oneOffs) {
      sheet.getCell(rowCursor, 1).value = `${entry.label} · ${new Date(entry.date).toLocaleDateString()}`;
      const amount = sheet.getCell(rowCursor, 2);
      amount.value = entry.kind === 'income' ? entry.amount : -entry.amount;
      amount.numFmt = money;
      rowCursor++;
    }
  }
}

/**
 * Render one card. Returns how many rows it occupied, so the caller can place
 * the next grid row below the tallest card in this one.
 */
function writeCard(
  sheet: Worksheet,
  card: MonthReport['cards'][number],
  top: number,
  left: number,
  money: string,
): number {
  const accent = argb(card.group.hex);
  let row = top;

  // Header: accent fill, white text, spanning both card columns.
  sheet.mergeCells(row, left, row, left + 1);
  const header = sheet.getCell(row, left);
  header.value = card.group.label;
  header.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: accent } };
  header.alignment = { vertical: 'middle', indent: 1 };
  sheet.getRow(row).height = 20;
  row++;

  // Subheading: the same "N of M filled in" the card shows.
  sheet.mergeCells(row, left, row, left + 1);
  const sub = sheet.getCell(row, left);
  sub.value =
    card.filledCount > 0
      ? `${card.filledCount} of ${card.itemCount} filled in`
      : card.group.hint;
  sub.font = { size: 8, italic: true, color: { argb: 'FF767676' } };
  sub.alignment = { indent: 1 };
  row++;

  // Line items. Every row is written, including blanks, so the sheet is a
  // form the user can fill in later rather than only a record of this month.
  for (const item of card.rows) {
    const labelCell = sheet.getCell(row, left);
    labelCell.value = item.isDeduction ? `− ${item.label}` : item.label;
    labelCell.font = {
      size: 10,
      color: { argb: item.amount > 0 ? 'FF1A1A1A' : 'FF9A9A9A' },
    };
    labelCell.alignment = { indent: 1 };

    const amountCell = sheet.getCell(row, left + 1);
    // Blank rather than 0: an empty box on screen must not become a stated
    // zero in the export, which would read as "confirmed nothing".
    amountCell.value = item.amount > 0 ? item.amount : null;
    amountCell.numFmt = money;
    amountCell.font = {
      size: 10,
      color: { argb: item.isDeduction ? 'FFE34948' : 'FF1A1A1A' },
    };
    amountCell.border = {
      bottom: { style: 'hair', color: { argb: 'FFE5E5E5' } },
    };
    labelCell.border = amountCell.border;
    row++;
  }

  // Deduction breakdown, only when something was withheld.
  if (card.withheld > 0) {
    for (const [label, value, color] of [
      ['Gross', card.gross, 'FF767676'],
      ['Deducted', -card.withheld, 'FFE34948'],
    ] as const) {
      sheet.getCell(row, left).value = label;
      sheet.getCell(row, left).font = { size: 9, color: { argb: 'FF767676' } };
      sheet.getCell(row, left).alignment = { indent: 1 };
      const cell = sheet.getCell(row, left + 1);
      cell.value = value;
      cell.numFmt = money;
      cell.font = { size: 9, color: { argb: color } };
      row++;
    }
  }

  // Total row.
  const totalLabel = sheet.getCell(row, left);
  totalLabel.value = card.withheld > 0 ? 'Take-home' : 'Total';
  totalLabel.font = { bold: true, size: 10 };
  totalLabel.alignment = { indent: 1 };

  const totalValue = sheet.getCell(row, left + 1);
  totalValue.value = card.total;
  totalValue.numFmt = money;
  totalValue.font = { bold: true, size: 10, color: { argb: accent } };

  for (const cell of [totalLabel, totalValue]) {
    cell.border = { top: { style: 'thin', color: { argb: accent } } };
  }
  row++;

  return row - top;
}

function buildCategorySheet(workbook: Workbook, report: MonthReport): void {
  const sheet = workbook.addWorksheet('Where it went');
  const money = currencyFormat(report.currency);

  sheet.columns = [
    { header: 'Category', key: 'category', width: 28 },
    { header: 'Amount', key: 'amount', width: 16 },
    { header: 'Share', key: 'share', width: 10 },
    { header: 'Entries', key: 'count', width: 10 },
  ];
  styleHeaderRow(sheet, '#2a78d6');

  for (const row of report.categories) {
    sheet.addRow({
      category: row.label,
      amount: row.amount,
      share: row.share,
      count: row.count,
    });
  }

  sheet.getColumn('amount').numFmt = money;
  sheet.getColumn('share').numFmt = '0.0%';

  if (report.categories.length > 0) {
    const totalRow = sheet.addRow({
      category: 'Total',
      amount: report.summary.expenses,
      share: 1,
      count: report.categories.reduce((s, c) => s + c.count, 0),
    });
    totalRow.font = { bold: true };
  }
}

/** The flat rows, for anyone who wants to pivot rather than read. */
function buildDataSheet(workbook: Workbook, report: MonthReport): void {
  const sheet = workbook.addWorksheet('Data');
  const money = currencyFormat(report.currency);

  sheet.columns = [
    { header: 'Card', key: 'card', width: 24 },
    { header: 'Item', key: 'item', width: 28 },
    { header: 'Kind', key: 'kind', width: 12 },
    { header: 'Amount', key: 'amount', width: 16 },
  ];
  styleHeaderRow(sheet, '#767676');

  for (const card of report.cards) {
    for (const row of card.rows) {
      if (row.amount <= 0) continue;
      sheet.addRow({
        card: card.group.label,
        item: row.label,
        kind: row.isDeduction ? 'deduction' : 'amount',
        amount: row.amount,
      });
    }
  }

  sheet.getColumn('amount').numFmt = money;
  sheet.autoFilter = { from: 'A1', to: 'D1' };
}

function styleHeaderRow(sheet: Worksheet, hex: string): void {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: argb(hex) },
  };
  header.height = 18;
  sheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
}

export async function exportYearToExcel(report: YearReport): Promise<Blob> {
  const ExcelJS = await import('exceljs');
  const workbook: Workbook = new ExcelJS.Workbook();
  workbook.creator = 'AminFinance';
  workbook.created = new Date(report.generatedAt);

  const money = currencyFormat(report.currency);
  const sheet = workbook.addWorksheet(`${report.year}`, {
    views: [{ showGridLines: false }],
  });

  sheet.mergeCells(1, 1, 1, 5);
  const title = sheet.getCell(1, 1);
  title.value = `Annual summary — ${report.year}`;
  title.font = { size: 16, bold: true };
  sheet.getRow(1).height = 24;

  sheet.getCell(2, 1).value = `Generated ${new Date(report.generatedAt).toLocaleString()} · amounts in ${report.currency}`;
  sheet.getCell(2, 1).font = { size: 9, color: { argb: 'FF767676' } };

  // Month-by-month table.
  const headerRow = 4;
  ['Month', 'Income', 'Spent', 'Saved', 'Savings rate'].forEach((label, i) => {
    const cell = sheet.getCell(headerRow, i + 1);
    cell.value = label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: argb('#2a78d6') },
    };
  });

  sheet.getColumn(1).width = 20;
  for (let c = 2; c <= 5; c++) sheet.getColumn(c).width = 16;

  report.months.forEach((month, i) => {
    const row = headerRow + 1 + i;
    sheet.getCell(row, 1).value = month.label;
    sheet.getCell(row, 2).value = month.income;
    sheet.getCell(row, 3).value = month.expenses;
    sheet.getCell(row, 4).value = month.saved;
    sheet.getCell(row, 5).value =
      month.savingsRate === null ? '—' : month.savingsRate / 100;

    for (let c = 2; c <= 4; c++) sheet.getCell(row, c).numFmt = money;
    if (month.savingsRate !== null) sheet.getCell(row, 5).numFmt = '0.0%';

    // Grey out months with nothing recorded, so a reader can tell "no data"
    // from "genuinely zero".
    if (month.income === 0 && month.expenses === 0) {
      for (let c = 1; c <= 5; c++) {
        sheet.getCell(row, c).font = { color: { argb: 'FFB0B0B0' } };
      }
    }
  });

  const totalRow = headerRow + 13;
  sheet.getCell(totalRow, 1).value = 'Year total';
  sheet.getCell(totalRow, 2).value = report.totals.income;
  sheet.getCell(totalRow, 3).value = report.totals.expenses;
  sheet.getCell(totalRow, 4).value = report.totals.saved;
  sheet.getCell(totalRow, 5).value =
    report.totals.savingsRate === null ? '—' : report.totals.savingsRate / 100;
  for (let c = 2; c <= 4; c++) sheet.getCell(totalRow, c).numFmt = money;
  if (report.totals.savingsRate !== null) {
    sheet.getCell(totalRow, 5).numFmt = '0.0%';
  }
  for (let c = 1; c <= 5; c++) {
    const cell = sheet.getCell(totalRow, c);
    cell.font = { bold: true };
    cell.border = { top: { style: 'thin' } };
  }

  // Per-card totals for the year, keeping the card structure.
  let cursor = totalRow + 3;
  sheet.getCell(cursor, 1).value = 'By card';
  sheet.getCell(cursor, 1).font = { size: 12, bold: true };
  cursor++;

  for (const { group, total } of report.cardTotals) {
    const labelCell = sheet.getCell(cursor, 1);
    labelCell.value = group.label;
    labelCell.font = { color: { argb: argb(group.hex) }, bold: true };
    const valueCell = sheet.getCell(cursor, 2);
    valueCell.value = total;
    valueCell.numFmt = money;
    cursor++;
  }

  // Categories for the year.
  cursor += 2;
  sheet.getCell(cursor, 1).value = 'Where it went';
  sheet.getCell(cursor, 1).font = { size: 12, bold: true };
  cursor++;
  for (const category of report.categories) {
    sheet.getCell(cursor, 1).value = category.label;
    sheet.getCell(cursor, 2).value = category.amount;
    sheet.getCell(cursor, 2).numFmt = money;
    sheet.getCell(cursor, 3).value = category.share;
    sheet.getCell(cursor, 3).numFmt = '0.0%';
    cursor++;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** Short month label, re-exported so the PDF module shares one implementation. */
export { formatMonthShort };
