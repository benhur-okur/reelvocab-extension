// Vitrin dosyası üretici — panel dışa aktarımı + gözden geçirme kararı → vitrin.
//
// Kullanım: `node scripts/showcase-from-measure.mjs --help`
//
// Panelin "kopyala" dışa aktarımı (`items.json`) yayın derlemesinde de
// çalışıyor. Özet (`summary.json`) konsol tetikleyicisinin dönüş değerinden
// alınıyorsa GELİŞTİRME DERLEMESİ gerekir (`npm run build:dev`):
// `window.__reelvocabTest` yayın derlemesinde yok.
//
// Girdi : .measure/<koşu>.items.json   (panelin "kopyala" dışa aktarımı)
//         .measure/<koşu>.summary.json (İSTEĞE BAĞLI — koşum özeti)
//         .measure/<koşu>.review.json  (gözden geçirme kararı — aşağıda)
//         `<koşu>` alt klasör içerebilir: `showcase/<videoId>` →
//         `.measure/showcase/<videoId>.items.json`.
//         prompts/annotate_v6.md       (yalnız OKUNUR — promptVersion)
// Çıktı : src/showcase/<videoId>.json          (gerçek)
//         src/showcase/<videoId>.fixture.json  (--fixture)
//
// `.measure/` dosyalarına YAZILMIYOR, yalnız okunuyor.
//
// ── Model: özetten ya da --model'den, ASLA tahminle ─────────────────────────
//
// Özetten okunan TEK alan `model`. Vitrin videoları panelden işlenip yalnız
// "kopyala" dışa aktarımı alındığı için özet dosyası olmayabiliyor:
//   · Özet YOKSA → `--model` ZORUNLU.
//   · Özet VARSA ve `--model` da verildiyse → uyuşmazlık HATA.
//   · Her durumda model `src/lib/models.ts`'teki izinli listeye karşı
//     doğrulanıyor. Varsayılana düşülmüyor — `--source-kind` ile aynı ilke:
//     vitrin dosyası "hangi modelle üretildi" diye yanlış bir şey söylerse
//     eval verisi sessizce bozulur.
//
// ── Gözden geçirme dosyası (.measure/<koşu>.review.json) ────────────────────
//
//   { "remove": [ { "term": "president for crimes", "reason": "cümle parçası" } ] }
//
// · `remove` boş olabilir (`[]`) — "hepsine baktım, hepsi kalıyor" demek.
// · Eşleşme `term`'in BİREBİR yazımıyla. Listede bulunamayan bir `term` HATA:
//   gözden geçirme dosyasındaki bir yazım hatası, silinmesi gereken maddeyi
//   sessizce yayına bırakırdı.
// · Gözden geçirme, tekrar temizliğinden SONRA uygulanıyor: o noktada her
//   yüzey biçiminden yalnız bir kopya kalmış oluyor, yani bir `term`'i silmek
//   tek maddeyi siliyor.
// · Gerçek vitrinde dosya ZORUNLU (karar 8: her maddenin gözden geçirme
//   kararı kaydedilir). Fikstürde isteğe bağlı.
//
// ── Video genelinde tekrar temizliği (OTOMATİK, gözden geçirmeden ÖNCE) ────
//
// Aynı `term` birden çok kez geçiyorsa İLK geçiş tutulur, diğerleri çıkarılır
// ve `review.removed`'a "tekrar (otomatik, bölümler arası)" sebebiyle yazılır.
// Karşılaştırma `surfaceKey()` ile — `src/lib/showcase.ts`'teki fonksiyonun
// KENDİSİ; canlı işlemede panel de aynı fonksiyonu kullanıyor, yani vitrin ve
// canlı liste aynı kuralla tekilleşiyor. `termKey()` DEĞİL: "walked out" ile
// "walks out" ayrı sayılır.
//
// Neden gerekli: 6. kapı yalnız BÖLÜM İÇİNDE tekilleştiriyor, bölümler arası
// tekrar listeye giriyor (ölçülmüş vaka: `madam Speaker`). Gözden geçirme
// dosyası ise bir terimin TÜM kopyalarını siliyor — birini tutup diğerlerini
// atmak o biçimle mümkün değil. Bu yüzden tekrar temizliği gözden geçirmeden
// önce, otomatik yapılıyor.
//
// ── Kurallar ────────────────────────────────────────────────────────────────
//
// 🔴 Gerçek vitrin dosyasında YER TUTUCU YOK. Bir maddede `type`, `difficulty`
//    ya da `register` eksikse dönüştürücü REDDEDİYOR ve hangi maddede neyin
//    eksik olduğunu yazıyor. Yer tutucu yalnız `--fixture` ile ve yalnız
//    `.fixture.json` adlı dosyaya yazılıyor.
// 🔴 `segmentText` ÇIKARILIYOR — vitrin verisinde yasak (karar 8, telif).
//    `confidence` da çıkarılıyor: vitrin şemasında yok.
// 🔴 Yazmadan önce çıktı, eklentinin kullandığı AYNI `parseShowcase()` ile
//    doğrulanıyor (scripts/lib/showcase-validator.mjs). Geçmeyen dosya
//    yazılmıyor; build'e bozuk dosya hiç ulaşmıyor.

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import { loadShowcaseValidator } from "./lib/showcase-validator.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MEASURE_DIR = resolve(ROOT, ".measure");
const SHOWCASE_DIR = resolve(ROOT, "src/showcase");
const PROMPT_PATH = resolve(ROOT, "prompts/annotate_v6.md");
const MODELS_MODULE = resolve(ROOT, "src/lib/models.ts");

/**
 * ⚠️ YER TUTUCU — yalnız `--fixture`. Ölçülmüş ya da modelden gelmiş değerler
 * DEĞİL; eksik alanı doldurmak için. Dışa aktarımda alan varsa o kullanılıyor.
 */
const PLACEHOLDER = { type: "phrase", difficulty: "b2", register: "neutral" };

const FIXTURE_TITLE = "Test fikstürü — eksik tür/zorluk/üslup alanları yer tutucu";

/** Otomatik tekrar temizliğinin `review.removed` sebebi. */
const DUPLICATE_REASON = "tekrar (otomatik, bölümler arası)";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`[showcase] ✗ ${message}`);
  process.exit(1);
}

/** @param {string} path */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} path */
async function readJson(path) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${path}: okunamadı — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) fail(`${path}: kök nesne değil`);
  return parsed;
}

const USAGE = `Kullanım:
  Gerçek vitrin:
    node scripts/showcase-from-measure.mjs <koşu> --source-kind <asr|manual> --title "<başlık>" [--model <model>]
  Test fikstürü:
    node scripts/showcase-from-measure.mjs <koşu> --source-kind <asr|manual> --fixture [--model <model>]

Parametreler:
  <koşu>                     ZORUNLU. .measure/<koşu>.items.json okunur. Alt klasör
                             olabilir: showcase/<videoId> → .measure/showcase/<videoId>.items.json
  --source-kind asr|manual   ZORUNLU. Dışa aktarımda yok; tahmin edilmez.
  --model <model>            .measure/<koşu>.summary.json YOKSA ZORUNLU. Özet varsa
                             isteğe bağlı; verilirse özetteki modelle aynı olmalı.
                             İzinli değerler src/lib/models.ts'ten; varsayılana düşülmez.
  --title "<başlık>"         Gerçek vitrinde ZORUNLU — vitrinde başlıksız video olmaz.
                             --fixture ile yok sayılır (sabit fikstür başlığı).
  --fixture                  Eksik type/difficulty/register için yer tutucuya izin
                             verir; çıktı <videoId>.fixture.json. Gözden geçirme
                             dosyası isteğe bağlı olur.
  -h, --help                 Bu metin.

items.json panelin "kopyala" düğmesinden gelir (her derlemede). summary.json
konsol tetikleyicisinden alınacaksa geliştirme derlemesi gerekir
(npm run build:dev): window.__reelvocabTest yayın derlemesinde yok.

Gerçek vitrin ayrıca .measure/<koşu>.review.json ister:
  { "remove": [ { "term": "...", "reason": "..." } ] }   (boş liste de geçerli)

Çıktı: src/showcase/<videoId>.json  |  --fixture: src/showcase/<videoId>.fixture.json`;

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const run = args[0];
  if (!run || run.startsWith("--")) fail("koşu adı eksik (örn. large-1). Kullanım: --help");

  /** @param {string} flag */
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  const fixture = args.includes("--fixture");

  const sourceKind = valueOf("--source-kind");
  // Kaynak türü dışa aktarımda YOK; tahmin etmek yerine açıkça isteniyor.
  if (sourceKind !== "asr" && sourceKind !== "manual") {
    fail('--source-kind "asr" ya da "manual" olmalı (dışa aktarımda bu bilgi yok)');
  }

  const title = fixture ? FIXTURE_TITLE : valueOf("--title");
  if (title === undefined || title.trim() === "" || title.startsWith("--")) {
    fail('gerçek vitrin için --title "<başlık>" zorunlu — vitrinde başlıksız video olmaz. Kullanım: --help');
  }

  // `--model` yazılıp değeri verilmemişse (son argüman ya da ardından başka
  // bir bayrak) HATA — "verilmedi" sayılıp özete ya da hataya düşmek, yazım
  // hatasını gizlerdi.
  const modelArg = valueOf("--model");
  if (
    args.includes("--model") &&
    (modelArg === undefined || modelArg === "" || modelArg.startsWith("--"))
  ) {
    fail("--model değer bekliyor. Kullanım: --help");
  }

  return { run, sourceKind, title, fixture, modelArg };
}

/**
 * İzinli model listesi — `src/lib/models.ts`'in KENDİSİNDEN.
 *
 * Kopyalanmıyor: esbuild modülü bellekte derliyor ve `data:` URL'siyle içe
 * aktarılıyor (scripts/lib/showcase-validator.mjs ile aynı teknik). Liste
 * eklentide değişirse burada da değişmiş oluyor.
 * @returns {Promise<string[]>}
 */
async function loadAllowedModels() {
  const result = await esbuild.build({
    entryPoints: [MODELS_MODULE],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (!output) fail("models.ts derlenemedi");

  /** @type {Record<string, unknown>} */
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`
  );
  const list = module.ALLOWED_MODELS;
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")) {
    fail("models.ts: ALLOWED_MODELS dize dizisi değil");
  }
  return list;
}

/**
 * Modeli belirler: özet ve/veya --model, izinli listeye karşı.
 * @param {string} summaryFile @param {string | undefined} modelArg
 */
async function resolveModel(summaryFile, modelArg) {
  const allowed = await loadAllowedModels();

  /** @type {string | undefined} */
  let fromSummary;
  if (await exists(summaryFile)) {
    const summary = await readJson(summaryFile);
    if (typeof summary.model !== "string" || summary.model === "") {
      fail(`${summaryFile}: "model" alanı yok`);
    }
    fromSummary = summary.model;
  }

  if (fromSummary === undefined && modelArg === undefined) {
    fail(
      `${summaryFile} yok; --model zorunlu. İzinli: ${allowed.join(", ")}. Kullanım: --help`,
    );
  }

  if (fromSummary !== undefined && modelArg !== undefined && fromSummary !== modelArg) {
    fail(`--model "${modelArg}" özetteki modelle uyuşmuyor ("${fromSummary}", ${summaryFile})`);
  }

  const model = fromSummary ?? modelArg;
  if (model === undefined || !allowed.includes(model)) {
    fail(`model "${model}" izinli listede yok. İzinli: ${allowed.join(", ")}`);
  }
  return model;
}

async function readPromptVersion() {
  const text = await readFile(PROMPT_PATH, "utf8");
  const match = /promptVersion:\s*(\d+)/.exec(text);
  if (!match || match[1] === undefined) fail(`${PROMPT_PATH}: promptVersion bulunamadı`);
  return Number(match[1]);
}

/**
 * Gözden geçirme dosyasını okur.
 * @param {string} path
 * @returns {Promise<{ term: string, reason: string }[]>}
 */
async function readReview(path) {
  const raw = await readJson(path);
  if (!Array.isArray(raw.remove)) fail(`${path}: "remove" dizi değil`);

  return raw.remove.map((entry, index) => {
    const where = `${path} remove[${index}]`;
    if (!isRecord(entry)) fail(`${where}: nesne değil`);
    const { term, reason } = entry;
    if (typeof term !== "string" || term === "") fail(`${where}: "term" boş olmayan dize değil`);
    if (typeof reason !== "string" || reason === "") {
      fail(`${where}: "reason" boş olmayan dize değil — sebepsiz silme eval'e veri değil`);
    }
    return { term, reason };
  });
}

async function main() {
  const { run, sourceKind, title, fixture, modelArg } = parseArgs();

  const itemsFile = resolve(MEASURE_DIR, `${run}.items.json`);
  const summaryFile = resolve(MEASURE_DIR, `${run}.summary.json`);
  const reviewFile = resolve(MEASURE_DIR, `${run}.review.json`);

  const exported = await readJson(itemsFile);
  const model = await resolveModel(summaryFile, modelArg);
  // Tekrar anahtarı ve son doğrulama aynı modülden: eklentinin kendi kodu.
  const { parseShowcase, surfaceKey } = await loadShowcaseValidator();

  const videoId = exported.videoId;
  const exportedAt = exported.exportedAt;
  if (typeof videoId !== "string" || videoId === "") fail(`${itemsFile}: videoId yok`);
  if (typeof exportedAt !== "string") fail(`${itemsFile}: exportedAt yok`);
  if (!Array.isArray(exported.items)) fail(`${itemsFile}: items dizi değil`);

  // ── Gözden geçirme ──
  const hasReview = await exists(reviewFile);
  if (!fixture && !hasReview) {
    fail(
      `${reviewFile} yok. Gerçek vitrin için gözden geçirme dosyası zorunlu ` +
        `(boş da olsa: {"remove": []}) — karar 8.`,
    );
  }
  const removals = hasReview ? await readReview(reviewFile) : [];
  const removeTerms = new Map(removals.map((entry) => [entry.term, entry.reason]));

  // ── Dönüştürme ──
  /** @type {string[]} */
  const missing = [];
  let placeholderCount = 0;
  /** @type {Set<string>} */
  const matchedRemovals = new Set();
  /** @type {Record<string, unknown>[]} */
  const items = [];

  /** Video genelinde görülen yüzey biçimleri (küçük harf + tek boşluk). */
  /** @type {Set<string>} */
  const seenTerms = new Set();
  /** @type {{ term: string, reason: string }[]} */
  const duplicates = [];

  exported.items.forEach((entry, index) => {
    const where = `items[${index}]`;
    if (!isRecord(entry)) fail(`${itemsFile} ${where}: nesne değil`);

    const { term, senseHere, nuance, start, end } = entry;
    if (typeof term !== "string" || typeof senseHere !== "string") {
      fail(`${itemsFile} ${where}: term/senseHere dize değil`);
    }
    if (typeof start !== "number" || typeof end !== "number") {
      fail(`${itemsFile} ${where}: start/end sayı değil`);
    }

    // 1) Tekrar temizliği — gözden geçirmeden ÖNCE: ilk geçiş kalır.
    const surface = surfaceKey(term);
    if (seenTerms.has(surface)) {
      duplicates.push({ term, reason: DUPLICATE_REASON });
      return;
    }
    seenTerms.add(surface);

    // 2) Gözden geçirme kararı.
    if (removeTerms.has(term)) {
      matchedRemovals.add(term);
      return;
    }

    /** @type {Record<string, unknown>} */
    const fields = {};
    /** @type {string[]} */
    const absent = [];
    for (const field of /** @type {const} */ (["type", "difficulty", "register"])) {
      const value = entry[field];
      if (typeof value === "string" && value !== "") {
        fields[field] = value;
      } else if (fixture) {
        fields[field] = PLACEHOLDER[field];
        placeholderCount += 1;
      } else {
        absent.push(field);
      }
    }
    if (absent.length > 0) {
      missing.push(`${where} "${term}": ${absent.join(", ")} eksik`);
      return;
    }

    // `segmentText` ve `confidence` BİLEREK kopyalanmıyor.
    /** @type {Record<string, unknown>} */
    const item = { term, senseHere, ...fields, start, end };
    if (typeof nuance === "string") item.nuance = nuance;
    items.push(item);
  });

  if (missing.length > 0) {
    console.error(
      `[showcase] ✗ ${missing.length} maddede zorunlu alan eksik — gerçek vitrinde yer tutucu YOK:`,
    );
    for (const line of missing) console.error(`  - ${line}`);
    console.error(
      "[showcase]   Dışa aktarımı alanları taşıyan sürümle yeniden alın, ya da test için --fixture kullanın.",
    );
    process.exit(1);
  }

  const unmatched = removals.filter((entry) => !matchedRemovals.has(entry.term));
  if (unmatched.length > 0) {
    fail(
      `${reviewFile}: listede bulunamayan term(ler) — ` +
        unmatched.map((entry) => `"${entry.term}"`).join(", "),
    );
  }

  const showcase = {
    schemaVersion: 1,
    videoId,
    title,
    sourceKind,
    model,
    promptVersion: await readPromptVersion(),
    processedAt: exportedAt,
    items,
    // Otomatik tekrarlar önce, elle verilen kararlar sonra — sıra işlemlerin
    // sırası.
    review: { kept: items.length, removed: [...duplicates, ...removals] },
  };

  // ── Yazmadan önce: eklentinin kendi doğrulayıcısı ──
  const outName = `${videoId}${fixture ? ".fixture" : ""}.json`;
  const checked = parseShowcase(showcase, outName);
  if (!checked.ok) fail(`doğrulama geçmedi, yazılmadı: ${checked.reason}`);

  await mkdir(SHOWCASE_DIR, { recursive: true });
  const outFile = resolve(SHOWCASE_DIR, outName);
  await writeFile(outFile, `${JSON.stringify(showcase, null, 2)}\n`, "utf8");

  console.log(
    `[showcase] ${items.length} madde tutuldu, ${duplicates.length} tekrar + ` +
      `${removals.length} gözden geçirme ile çıkarıldı → ${outFile}`,
  );
  if (fixture) {
    console.log(
      `[showcase] ⚠️ FİKSTÜR: ${placeholderCount} alan yer tutucuyla dolduruldu` +
        (hasReview ? "." : ", gözden geçirme dosyası yok."),
    );
  }

  // Aynı videonun hem fikstürü hem gerçek dosyası varsa build "videoId iki
  // dosyada tanımlı" hatasıyla durur — önceden uyar.
  const other = resolve(SHOWCASE_DIR, `${videoId}${fixture ? "" : ".fixture"}.json`);
  if (await exists(other)) {
    console.warn(
      `[showcase] ⚠️ ${other} de var: aynı videoId iki dosyada — build başarısız olur. Birini silin.`,
    );
  }
}

await main();
