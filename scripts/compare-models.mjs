// Model karşılaştırması — `.measure/` altındaki koşu dosyalarını okur, tablo
// basar. Hiçbir dosyayı DEĞİŞTİRMEZ.
//
// Kullanım:  node scripts/compare-models.mjs
//
// 🔴 Koşuları üretmek GELİŞTİRME DERLEMESİ ister: `npm run build:dev`.
// Konsol tetikleyicisi `window.__reelvocabTest({ model, chunkSize })` ve
// bölüm bazında ayrıntı logları yayın derlemesinde (`npm run build`) yok.
//
// Girdi (her koşu için iki dosya, panelden/konsoldan dışa aktarılmış):
//   <ad>.summary.json — koşum özeti (content.ts → RunSummary)
//     { model, segmentCount, chunkSize, chunkCount, calls, totalItems,
//       totalRejected, totalCorrected, totalKept, gateCounts: {kapı: sayı},
//       failures: [{chunkIndex, error}], durationMs, chunks: [...] }
//   <ad>.items.json — panelden kopyalanan maddeler ("kopyala" düğmesi)
//     { videoId, exportedAt, items: [{term, senseHere, start, end,
//       segmentText, nuance?}], reports: [...] }
//
// Alan adları dosyalardan OKUNDU, tahmin edilmedi. Beklenen bir alan eksik ya
// da yanlış tipteyse betik sessizce varsaymak yerine hangi dosyada neyin
// eksik olduğunu söyleyip duruyor.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MEASURE_DIR = resolve(ROOT, ".measure");

/**
 * Koşular — grup, ortalamanın hangi modelde toplanacağını belirliyor.
 * `medium-free` AYRI grup: aynı model, farklı hesap. Ortalamaya karışırsa
 * hesap farkının etkisi ortalamanın içinde kaybolur (bölüm 5).
 */
const RUNS = [
  { name: "large-1", group: "large" },
  { name: "large-2", group: "large" },
  { name: "medium-1", group: "medium" },
  { name: "medium-2", group: "medium" },
  { name: "small-1", group: "small" },
  { name: "small-2", group: "small" },
  { name: "ministral14-1", group: "ministral14" },
  { name: "ministral14-2", group: "ministral14" },
  { name: "medium-free", group: "medium-free" },
];

/** Karşılaştırılan model grupları; oranlar ilk gruba (`large`) göre. */
const MODEL_GROUPS = ["large", "medium", "small", "ministral14"];
const BASELINE_GROUP = "large";

/**
 * Bilinen kapı adları (src/lib/gates.ts → GateName, `schema` dahil).
 * Veride hiç geçmese de sütun olarak görünüyorlar: "0" ile "sütun yok"
 * aynı şey değil. Veride bu listede olmayan bir kapı çıkarsa o da sütun
 * olarak EKLENİYOR, atılmıyor.
 */
const KNOWN_GATES = [
  "schema",
  "proper_noun",
  "not_in_text",
  "forbidden_example",
  "self_confession",
  "not_a_unit",
  "duplicate_in_scene",
];

// ── Güvenli okuma ────────────────────────────────────────────────────────────

class ShapeError extends Error {}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {Record<string, unknown>} obj @param {string} key @param {string} where */
function readNumber(obj, key, where) {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ShapeError(`${where}: "${key}" sayı değil (${JSON.stringify(value)})`);
  }
  return value;
}

/** @param {Record<string, unknown>} obj @param {string} key @param {string} where */
function readString(obj, key, where) {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new ShapeError(`${where}: "${key}" dize değil (${JSON.stringify(value)})`);
  }
  return value;
}

/** @param {Record<string, unknown>} obj @param {string} key @param {string} where */
function readArray(obj, key, where) {
  const value = obj[key];
  if (!Array.isArray(value)) {
    throw new ShapeError(`${where}: "${key}" dizi değil`);
  }
  return value;
}

/** @param {string} file */
async function readJson(file) {
  const text = await readFile(resolve(MEASURE_DIR, file), "utf8");
  /** @type {unknown} */
  const parsed = JSON.parse(text);
  if (!isRecord(parsed)) throw new ShapeError(`${file}: kök nesne değil`);
  return parsed;
}

/**
 * @typedef {{
 *   model: string, segmentCount: number, chunkSize: number, chunkCount: number,
 *   calls: number, totalItems: number, totalRejected: number,
 *   totalCorrected: number, totalKept: number,
 *   gateCounts: Record<string, number>,
 *   failures: { chunkIndex: number, error: string }[],
 *   durationMs: number,
 * }} Summary
 */

/** @param {string} file @returns {Promise<Summary>} */
async function readSummary(file) {
  const raw = await readJson(file);

  const gatesRaw = raw.gateCounts;
  if (!isRecord(gatesRaw)) throw new ShapeError(`${file}: "gateCounts" nesne değil`);
  /** @type {Record<string, number>} */
  const gateCounts = {};
  for (const [gate, count] of Object.entries(gatesRaw)) {
    if (typeof count !== "number") {
      throw new ShapeError(`${file}: gateCounts.${gate} sayı değil`);
    }
    gateCounts[gate] = count;
  }

  const failures = readArray(raw, "failures", file).map((entry, index) => {
    const where = `${file} failures[${index}]`;
    if (!isRecord(entry)) throw new ShapeError(`${where}: nesne değil`);
    return {
      chunkIndex: readNumber(entry, "chunkIndex", where),
      error: readString(entry, "error", where),
    };
  });

  return {
    model: readString(raw, "model", file),
    segmentCount: readNumber(raw, "segmentCount", file),
    chunkSize: readNumber(raw, "chunkSize", file),
    chunkCount: readNumber(raw, "chunkCount", file),
    calls: readNumber(raw, "calls", file),
    totalItems: readNumber(raw, "totalItems", file),
    totalRejected: readNumber(raw, "totalRejected", file),
    totalCorrected: readNumber(raw, "totalCorrected", file),
    totalKept: readNumber(raw, "totalKept", file),
    gateCounts,
    failures,
    durationMs: readNumber(raw, "durationMs", file),
  };
}

/** @param {string} file @returns {Promise<string[]>} kalan maddelerin term'leri */
async function readTerms(file) {
  const raw = await readJson(file);
  return readArray(raw, "items", file).map((entry, index) => {
    const where = `${file} items[${index}]`;
    if (!isRecord(entry)) throw new ShapeError(`${where}: nesne değil`);
    return readString(entry, "term", where);
  });
}

// ── Biçimlendirme ────────────────────────────────────────────────────────────

/** Tanımsız ya da hesaplanamayan değer. */
const NA = "—";

/** @param {number | undefined} value @param {number} [digits] */
function fmt(value, digits = 0) {
  if (value === undefined || !Number.isFinite(value)) return NA;
  return digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
}

/** @param {number | undefined} ms */
function fmtSeconds(ms) {
  return ms === undefined ? NA : `${(ms / 1000).toFixed(1)} sn`;
}

/** @param {number | undefined} ratio */
function fmtPercent(ratio) {
  return ratio === undefined || !Number.isFinite(ratio) ? NA : `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Düz metin tablo. İlk sütun sola, diğerleri sağa hizalı (sayılar).
 * @param {string[]} headers @param {string[][]} rows
 */
function printTable(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (/** @type {string[]} */ cells) =>
    cells
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
      )
      .join("  ");

  console.log(line(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
}

/** @param {string} title */
function heading(title) {
  console.log("");
  console.log(`=== ${title} ${"=".repeat(Math.max(0, 72 - title.length))}`);
}

// ── Hesaplar ─────────────────────────────────────────────────────────────────

/** @param {number[]} values */
function mean(values) {
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Kapı oranı = o kapıda elenen / modelin ÜRETTİĞİ madde. Hiç madde
 * üretilmemişse oran tanımsız (0 değil) — "hiç üretmedi" ile "hiç elemedi"
 * karışmasın.
 * @param {Summary} summary @param {string} gate
 */
function gateRate(summary, gate) {
  if (summary.totalItems === 0) return undefined;
  return (summary.gateCounts[gate] ?? 0) / summary.totalItems;
}

/**
 * Karşılaştırma anahtarı: küçük harf, kırpılmış, tek boşluklu yüzey biçimi.
 * ⚠️ `termKey()` DEĞİL — o, TS kaynağında taşınmış bir kural ve buraya
 * kopyalanmıyor. Yani "walked out on" ile "walks out on" ayrı sayılır.
 * @param {string} term
 */
function compareKey(term) {
  return term.toLowerCase().trim().replace(/\s+/g, " ");
}

/** @param {string} a @param {string} b */
function byTerm(a, b) {
  return a.localeCompare(b, "en", { sensitivity: "base" });
}

// ── Ana akış ─────────────────────────────────────────────────────────────────

async function main() {
  /** @type {{ name: string, group: string, summary: Summary, terms: string[] }[]} */
  const loaded = [];
  /** @type {string[]} */
  const problems = [];

  for (const run of RUNS) {
    try {
      const summary = await readSummary(`${run.name}.summary.json`);
      const terms = await readTerms(`${run.name}.items.json`);
      loaded.push({ ...run, summary, terms });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`${run.name}: ${message}`);
    }
  }

  if (problems.length > 0) {
    console.log("⚠️  Okunamayan koşular (tablolarda YOK):");
    for (const problem of problems) console.log(`   - ${problem}`);
  }
  if (loaded.length === 0) {
    console.log("Hiç koşu okunamadı.");
    process.exitCode = 1;
    return;
  }

  // Kapı sütunları: bilinenler + veride çıkan bilinmeyenler.
  const gates = [...KNOWN_GATES];
  for (const run of loaded) {
    for (const gate of Object.keys(run.summary.gateCounts)) {
      if (!gates.includes(gate)) gates.push(gate);
    }
  }

  // ── 1. Koşu başına ──
  heading("1. Koşu başına");
  printTable(
    ["koşu", "model", "üretilen", "elenen", "kalan", "taşınan", ...gates, "başarısız bölüm", "süre"],
    loaded.map(({ name, summary }) => [
      name,
      summary.model,
      fmt(summary.totalItems),
      fmt(summary.totalRejected),
      fmt(summary.totalKept),
      fmt(summary.totalCorrected),
      ...gates.map((gate) => fmt(summary.gateCounts[gate] ?? 0)),
      `${summary.failures.length}/${summary.calls}`,
      fmtSeconds(summary.durationMs),
    ]),
  );

  // ── 2. Model başına ortalama + large'a oran ──
  heading("2. Model başına ortalama");

  /** @param {string} group */
  const runsOf = (group) => loaded.filter((run) => run.group === group);

  /** @param {string} group @param {(s: Summary) => number} pick */
  const groupMean = (group, pick) => mean(runsOf(group).map((run) => pick(run.summary)));

  /** @param {string} group @param {string} gate */
  const groupRate = (group, gate) =>
    mean(
      runsOf(group)
        .map((run) => gateRate(run.summary, gate))
        .filter((rate) => rate !== undefined),
    );

  printTable(
    ["model", "koşu", "üretilen", "elenen", "kalan", "taşınan", ...gates, "başarısız bölüm", "süre"],
    MODEL_GROUPS.filter((group) => runsOf(group).length > 0).map((group) => [
      group,
      String(runsOf(group).length),
      fmt(groupMean(group, (s) => s.totalItems), 1),
      fmt(groupMean(group, (s) => s.totalRejected), 1),
      fmt(groupMean(group, (s) => s.totalKept), 1),
      fmt(groupMean(group, (s) => s.totalCorrected), 1),
      ...gates.map((gate) => fmt(groupMean(group, (s) => s.gateCounts[gate] ?? 0), 1)),
      fmt(groupMean(group, (s) => s.failures.length), 1),
      fmtSeconds(groupMean(group, (s) => s.durationMs)),
    ]),
  );

  // Başarısız bölümü olan koşular ortalamaya girdi; işaretleniyor ki ortalama
  // tam koşumların ortalaması sanılmasın.
  const withFailures = loaded.filter(
    (run) => MODEL_GROUPS.includes(run.group) && run.summary.failures.length > 0,
  );
  if (withFailures.length > 0) {
    console.log("");
    console.log(
      "⚠️  Ortalamaya başarısız bölümlü koşular dahil: " +
        withFailures.map((run) => `${run.name} (${run.summary.failures.length}/${run.summary.calls})`).join(", "),
    );
  }

  console.log("");
  console.log(
    `Oran tanımı: kapı oranı = o kapıda elenen / üretilen madde (koşu başına, sonra ortalama). ` +
      `Üretilen 0 olan koşu oran ortalamasına girmez. "large'a oran" = modelin oranı / ${BASELINE_GROUP} oranı.`,
  );

  const ratioGates = ["schema", "not_in_text"];
  printTable(
    ["model", ...ratioGates.flatMap((gate) => [`${gate} oranı`, `${gate} / ${BASELINE_GROUP}`])],
    MODEL_GROUPS.filter((group) => runsOf(group).length > 0).map((group) => [
      group,
      ...ratioGates.flatMap((gate) => {
        const rate = groupRate(group, gate);
        const base = groupRate(BASELINE_GROUP, gate);
        const relative =
          rate === undefined || base === undefined || base === 0 ? undefined : rate / base;
        return [fmtPercent(rate), relative === undefined ? NA : `${relative.toFixed(2)}×`];
      }),
    ]),
  );

  // ── 3. Kalan maddeler ──
  heading("3. Koşu başına kalan maddeler (alfabetik)");
  for (const run of loaded) {
    const sorted = [...run.terms].sort(byTerm);
    console.log("");
    console.log(`${run.name} (${run.summary.model}) — ${sorted.length} madde`);
    if (sorted.length === 0) {
      console.log("   (yok)");
      continue;
    }
    for (const term of sorted) console.log(`   ${term}`);
  }

  // ── 4. Modeller arası kesişim ──
  heading("4. Modeller arası kesişim");
  console.log(
    "Karşılaştırma: küçük harf + tek boşluk yüzey biçimi (termKey DEĞİL). " +
      "Model kümesi = o modelin koşularının birleşimi; medium-free DAHİL DEĞİL.",
  );

  /** @type {Map<string, Map<string, string>>} grup → (anahtar → ilk görülen yazım) */
  const termsByGroup = new Map();
  for (const group of MODEL_GROUPS) {
    const map = new Map();
    for (const run of runsOf(group)) {
      for (const term of run.terms) {
        const key = compareKey(term);
        if (!map.has(key)) map.set(key, term);
      }
    }
    termsByGroup.set(group, map);
  }

  const allKeys = new Set();
  for (const map of termsByGroup.values()) for (const key of map.keys()) allKeys.add(key);

  /** @param {string} key */
  const groupsHaving = (key) =>
    MODEL_GROUPS.filter((group) => termsByGroup.get(group)?.has(key) === true);

  /** @param {string} key */
  const spelling = (key) => {
    for (const map of termsByGroup.values()) {
      const term = map.get(key);
      if (term !== undefined) return term;
    }
    return key;
  };

  const inAll = [...allKeys].filter((key) => groupsHaving(key).length === MODEL_GROUPS.length);
  console.log("");
  console.log(`Tüm ${MODEL_GROUPS.length} modelde de (${inAll.length}):`);
  if (inAll.length === 0) console.log("   (yok)");
  for (const key of inAll.map(spelling).sort(byTerm)) console.log(`   ${key}`);

  for (const group of MODEL_GROUPS) {
    const only = [...allKeys].filter((key) => {
      const having = groupsHaving(key);
      return having.length === 1 && having[0] === group;
    });
    console.log("");
    console.log(`Yalnız ${group} (${only.length}):`);
    if (only.length === 0) console.log("   (yok)");
    for (const term of only.map(spelling).sort(byTerm)) console.log(`   ${term}`);
  }

  // ── 5. medium-free ↔ medium ──
  heading("5. medium-free ↔ medium-1 / medium-2 (aynı model, farklı hesap)");

  const free = loaded.find((run) => run.name === "medium-free");
  const mediumRuns = runsOf("medium");

  if (!free) {
    console.log("medium-free okunamadı.");
  } else if (mediumRuns.length === 0) {
    console.log("medium-1 / medium-2 okunamadı.");
  } else {
    /** @param {Summary} s */
    const row = (s) => [
      s.model,
      fmt(s.totalItems),
      fmt(s.totalRejected),
      fmt(s.totalKept),
      fmt(s.totalCorrected),
      `${s.failures.length}/${s.calls}`,
      fmtSeconds(s.durationMs),
    ];

    const avg = {
      totalItems: groupMean("medium", (s) => s.totalItems),
      totalRejected: groupMean("medium", (s) => s.totalRejected),
      totalKept: groupMean("medium", (s) => s.totalKept),
      totalCorrected: groupMean("medium", (s) => s.totalCorrected),
      failures: groupMean("medium", (s) => s.failures.length),
      durationMs: groupMean("medium", (s) => s.durationMs),
    };

    /** @param {number | undefined} a @param {number | undefined} b */
    const diff = (a, b) => (a === undefined || b === undefined ? NA : fmt(a - b, 1));

    printTable(
      ["koşu", "model", "üretilen", "elenen", "kalan", "taşınan", "başarısız bölüm", "süre"],
      [
        ...mediumRuns.map((run) => [run.name, ...row(run.summary)]),
        [
          "medium ort.",
          mediumRuns[0]?.summary.model ?? NA,
          fmt(avg.totalItems, 1),
          fmt(avg.totalRejected, 1),
          fmt(avg.totalKept, 1),
          fmt(avg.totalCorrected, 1),
          fmt(avg.failures, 1),
          fmtSeconds(avg.durationMs),
        ],
        [free.name, ...row(free.summary)],
        [
          "fark (free − ort.)",
          "",
          diff(free.summary.totalItems, avg.totalItems),
          diff(free.summary.totalRejected, avg.totalRejected),
          diff(free.summary.totalKept, avg.totalKept),
          diff(free.summary.totalCorrected, avg.totalCorrected),
          diff(free.summary.failures.length, avg.failures),
          free.summary.durationMs === undefined || avg.durationMs === undefined
            ? NA
            : `${((free.summary.durationMs - avg.durationMs) / 1000).toFixed(1)} sn`,
        ],
      ],
    );

    if (free.summary.model !== mediumRuns[0]?.summary.model) {
      console.log("");
      console.log(
        `⚠️  Model adları farklı: medium-free = ${free.summary.model}, medium = ${mediumRuns[0]?.summary.model}`,
      );
    }

    if (free.summary.failures.length > 0) {
      console.log("");
      console.log("medium-free başarısız bölümleri:");
      for (const failure of free.summary.failures) {
        console.log(`   bölüm ${failure.chunkIndex + 1}: ${failure.error}`);
      }
    }

    const mediumKeys = termsByGroup.get("medium") ?? new Map();
    const freeKeys = new Map(free.terms.map((term) => [compareKey(term), term]));
    const both = [...freeKeys.keys()].filter((key) => mediumKeys.has(key));
    const onlyFree = [...freeKeys.keys()].filter((key) => !mediumKeys.has(key));
    const onlyMedium = [...mediumKeys.keys()].filter((key) => !freeKeys.has(key));

    console.log("");
    console.log(
      `Madde kesişimi: ikisinde de ${both.length} · yalnız medium-free ${onlyFree.length} · ` +
        `yalnız medium-1/2 ${onlyMedium.length}`,
    );
    if (onlyFree.length > 0) {
      console.log("Yalnız medium-free:");
      for (const key of onlyFree.map((k) => freeKeys.get(k) ?? k).sort(byTerm)) console.log(`   ${key}`);
    }
  }

  console.log("");
}

await main();
