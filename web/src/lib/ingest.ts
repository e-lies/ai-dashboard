/**
 * Lecture des fichiers Excel et CSV en une matrice brute.
 * Aucun typage ici : il est fait par le profilage (profile.ts).
 */
import Papa from 'papaparse';
import * as XLSX from 'xlsx';

export type RawCell = string | number | boolean | Date | null;

export interface RawSheet {
  name: string;
  matrix: RawCell[][];
}

export interface RawWorkbook {
  fileName: string;
  sheets: RawSheet[];
}

export interface RawTable {
  headers: string[];
  rows: RawCell[][];
}

const MAX_FILE_SIZE = 50 * 1024 * 1024;

export async function readFile(file: File): Promise<RawWorkbook> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`Fichier trop volumineux (${Math.round(file.size / 1e6)} Mo, maximum 50 Mo).`);
  }
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    return { fileName: file.name, sheets: [{ name: 'CSV', matrix: await readCsv(file) }] };
  }
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'ods') {
    return { fileName: file.name, sheets: await readExcel(file) };
  }
  throw new Error(`Format non pris en charge : .${ext}`);
}

async function readExcel(file: File): Promise<RawSheet[]> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true, dense: true });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]!;
    const matrix = XLSX.utils.sheet_to_json<RawCell[]>(ws, { header: 1, raw: true, defval: null, blankrows: false });
    return { name, matrix };
  });
}

/**
 * Les CSV produits par Excel en français sont souvent en Windows-1252 avec « ; »
 * comme séparateur. On tente l'UTF-8 strict, puis on se rabat sur Windows-1252.
 */
async function readCsv(file: File): Promise<RawCell[][]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const parsed = Papa.parse<string[]>(text, {
    delimitersToGuess: [';', ',', '\t', '|'],
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
  });
  if (parsed.errors.length > 0 && parsed.data.length === 0) {
    throw new Error(`CSV illisible : ${parsed.errors[0]?.message}`);
  }
  return parsed.data.map((row) => row.map((v) => (v === '' ? null : v)));
}

/**
 * Devine la ligne d'en-tête parmi les 10 premières : celle qui contient le plus
 * de cellules textuelles non vides (les fichiers ont souvent un titre au-dessus).
 */
export function guessHeaderRow(matrix: RawCell[][]): number {
  let best = 0;
  let bestScore = -1;
  matrix.slice(0, 10).forEach((row, i) => {
    const score = row.filter((c) => typeof c === 'string' && c.trim() !== '').length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

export function toTable(matrix: RawCell[][], headerRow: number): RawTable {
  const headerCells = matrix[headerRow] ?? [];
  const body = matrix.slice(headerRow + 1);
  const width = Math.max(headerCells.length, ...body.map((r) => r.length));

  const seen = new Map<string, number>();
  const headers = Array.from({ length: width }, (_, i) => {
    const raw = headerCells[i];
    let name = raw == null || String(raw).trim() === '' ? `Colonne ${i + 1}` : String(raw).trim();
    // Dédoublonne les en-têtes identiques.
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n > 0) name = `${name} (${n + 1})`;
    return name;
  });

  const rows = body
    .map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null))
    .filter((r) => r.some((c) => c !== null && c !== ''));

  return { headers, rows };
}
