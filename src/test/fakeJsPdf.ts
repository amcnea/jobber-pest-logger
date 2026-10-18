// Recording stand-in for jsPDF (same metrics as pdf.test.ts): splitTextToSize wraps at
// floor(maxWidth / 2) chars; getTextWidth = 2 mm per char. Test-only.
export interface TextCall {
  page: number;
  text: string | string[];
  x: number;
  y: number;
  opts?: Record<string, unknown>;
}

export class FakeJsPDF {
  static instances: FakeJsPDF[] = [];
  options: unknown;
  page = 1;
  pages = 1;
  fontSize = 16;
  font = { fontName: "helvetica", fontStyle: "normal" };
  textColor = "#000000";
  texts: TextCall[] = [];
  lines: { page: number; y: number }[] = [];
  saved: string[] = [];
  constructor(options: unknown) {
    this.options = options;
    FakeJsPDF.instances.push(this);
  }
  splitTextToSize(text: string, maxWidth: number): string[] {
    const n = Math.floor(maxWidth / 2);
    const out: string[] = [];
    for (const para of String(text).split("\n")) {
      if (para.length === 0) out.push("");
      for (let i = 0; i < para.length; i += n) out.push(para.slice(i, i + n));
    }
    return out;
  }
  getTextWidth(s: string) {
    return s.length * 2;
  }
  text(text: string | string[], x: number, y: number, opts?: Record<string, unknown>) {
    this.texts.push({ page: this.page, text, x, y, opts });
    return this;
  }
  line(_x1: number, y1: number) {
    this.lines.push({ page: this.page, y: y1 });
    return this;
  }
  addPage() {
    this.pages += 1;
    this.page = this.pages;
    return this;
  }
  setPage(n: number) {
    this.page = n;
    return this;
  }
  getNumberOfPages() {
    return this.pages;
  }
  getFontSize() {
    return this.fontSize;
  }
  setFontSize(n: number) {
    this.fontSize = n;
    return this;
  }
  getFont() {
    return this.font;
  }
  setFont(fontName: string, fontStyle: string) {
    this.font = { fontName, fontStyle };
    return this;
  }
  getTextColor() {
    return this.textColor;
  }
  setTextColor() {
    return this;
  }
  setDrawColor() {
    return this;
  }
  save(name: string) {
    this.saved.push(name);
  }
}

/** Serializable record of everything drawn. */
export function pdfRecord(doc: FakeJsPDF) {
  return { pages: doc.pages, texts: doc.texts, lines: doc.lines, saved: doc.saved };
}
