// Vitrin gözden geçirme istatistikleri — video başına ve toplam.
//
// Kullanım:  node scripts/showcase-review-stats.mjs
//
// Hiçbir dosyayı DEĞİŞTİRMEZ. Markdown istatistik tablosu basar.
//
// Kaynaklar (üçü de okunur, birbiriyle karşılaştırılır):
//   .measure/showcase/<videoId>.items.json  — panel dışa aktarımı: kapılardan
//                                             geçip panelde gösterilen maddeler
//   .measure/showcase/<videoId>.review.json — elle gözden geçirme kararı;
//                                             sebep "ETİKET: açıklama"
//   src/showcase/<videoId>.json             — pakete giren vitrin dosyası:
//                                             kalan maddeler + review.removed
//                                             (otomatik tekrarlar dahil)
//
// ⚠️ "Dışa aktarılan" modelin HAM ürettiği sayı DEĞİL: kapılardan geçmiş
// olanlar. Ham sayı koşum özetinde (summary.json) duruyor ve vitrin
// koşuları için özet dışa aktarılmadı — o sayı buradan çıkarılamaz.
//
// 🔴 Tutarlılık kontrolü: her video için
//   dışa aktarılan − otomatik tekrar − elle silinen = kalan
// ve src/showcase'teki elle silinen terimler = review.json'daki terimler.
// Biri tutmazsa betik sayı basmak yerine DURUYOR: tutarsız veriden tablo
// üretmek, ölçülmüş izlenimi veren yanlış bir sayı demek.

import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MEASURE_DIR = resolve(ROOT, ".measure/showcase");
const SHOWCASE_DIR = resolve(ROOT, "src/showcase");

/** showcase-from-measure.mjs → DUPLICATE_REASON ile aynı dize. */
const DUPLICATE_REASON = "tekrar (otomatik, bölümler arası)";

/**
 * Bilinen etiketler — veride hiç geçmese de sütun olarak görünüyorlar ("0" ile
 * "sütun yok" aynı şey değil). Listede olmayan bir etiket çıkarsa o da sütun
 * olarak EKLENİYOR ve uyarı basılıyor.
 */
const KNOWN_LABELS = [
  "ASR",
  "TAHMİN EDİLEBİLİR",
  "ÇOK TEMEL",
  "PARÇA",
  "ÖZEL İSİM",
  "YANLIŞ ANLAM",
];

function fail(message) {
  console.error(`[stats] ✗ ${message}`);
  process.exit(1);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${path.slice(ROOT.length + 1)}: okunamadı — ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** "ETİKET: açıklama" → "ETİKET". İki nokta yoksa etiket yok sayılıyor. */
function labelOf(reason) {
  const index = reason.indexOf(":");
  return index > 0 ? reason.slice(0, index).trim() : "(etiketsiz)";
}

const files = (await readdir(SHOWCASE_DIR)).filter((name) => name.endsWith(".json")).sort();
if (files.length === 0) fail("src/showcase altında vitrin dosyası yok");

const rows = [];
const labels = [...KNOWN_LABELS];

for (const file of files) {
  const showcase = await readJson(resolve(SHOWCASE_DIR, file));
  const videoId = showcase.videoId;
  const exported = await readJson(resolve(MEASURE_DIR, `${videoId}.items.json`));
  const review = await readJson(resolve(MEASURE_DIR, `${videoId}.review.json`));

  const exportedCount = exported.items.length;
  const removed = showcase.review.removed;
  const duplicates = removed.filter((entry) => entry.reason === DUPLICATE_REASON);
  const manual = removed.filter((entry) => entry.reason !== DUPLICATE_REASON);
  const kept = showcase.items.length;

  // Kontrol 1: elle silinenler iki dosyada aynı terimler.
  const reviewTerms = review.remove.map((entry) => entry.term).sort();
  const manualTerms = manual.map((entry) => entry.term).sort();
  if (JSON.stringify(reviewTerms) !== JSON.stringify(manualTerms)) {
    fail(
      `${videoId}: review.json terimleri ${JSON.stringify(reviewTerms)} ≠ src/showcase elle silinen ${JSON.stringify(manualTerms)}`,
    );
  }

  // Kontrol 2: sayım denkliği.
  if (exportedCount - duplicates.length - manual.length !== kept) {
    fail(
      `${videoId}: ${exportedCount} − ${duplicates.length} − ${manual.length} ≠ ${kept} (dışa aktarılan − tekrar − elle ≠ kalan)`,
    );
  }

  /** @type {Record<string, number>} */
  const byLabel = {};
  for (const entry of review.remove) {
    const label = labelOf(entry.reason);
    byLabel[label] = (byLabel[label] ?? 0) + 1;
    if (!labels.includes(label)) {
      labels.push(label);
      console.warn(`[stats] ⚠ bilinmeyen etiket: "${label}" (${videoId}: ${entry.term})`);
    }
  }

  rows.push({
    videoId,
    sourceKind: showcase.sourceKind,
    exported: exportedCount,
    duplicates: duplicates.length,
    manual: manual.length,
    byLabel,
    kept,
  });
}

const total = {
  videoId: "**Toplam**",
  sourceKind: "",
  exported: rows.reduce((sum, row) => sum + row.exported, 0),
  duplicates: rows.reduce((sum, row) => sum + row.duplicates, 0),
  manual: rows.reduce((sum, row) => sum + row.manual, 0),
  byLabel: Object.fromEntries(
    labels.map((label) => [label, rows.reduce((sum, row) => sum + (row.byLabel[label] ?? 0), 0)]),
  ),
  kept: rows.reduce((sum, row) => sum + row.kept, 0),
};

const header = [
  "Video",
  "Kaynak",
  "Dışa aktarılan",
  "Otomatik tekrar",
  "Elle silinen",
  ...labels.map((label) => `↳ ${label}`),
  "Kalan",
];
const lines = [
  `| ${header.join(" | ")} |`,
  `|${header.map((_, index) => (index < 2 ? "---" : "---:")).join("|")}|`,
];
for (const row of [...rows, total]) {
  lines.push(
    `| ${[
      row.videoId === total.videoId ? row.videoId : `\`${row.videoId}\``,
      row.sourceKind,
      row.exported,
      row.duplicates,
      row.manual,
      ...labels.map((label) => row.byLabel[label] ?? 0),
      row.kept,
    ].join(" | ")} |`,
  );
}

console.log(lines.join("\n"));
console.log(
  `\n[stats] ${rows.length} video · tutarlılık: dışa aktarılan − tekrar − elle = kalan, her videoda tuttu; ` +
    "elle silinen terimler review.json ile src/showcase'te aynı",
);
