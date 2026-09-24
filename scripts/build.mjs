// Build hattı: src/ → dist/. Eklenti `dist/` klasöründen yüklenir.
//
// İki ayrı esbuild koşusu var ve bu KASITLI — biçimler farklı olmak zorunda:
//
//  · background.js  → ESM. Manifest'te `"type": "module"` yazıyor; service
//    worker modül olarak yükleniyor.
//  · content.js, main-world.js → IIFE. Content script'ler klasik betik olarak
//    çalıştırılıyor, `import`/`export` sözdizimi orada geçersiz. ESM üretmek
//    "Cannot use import statement outside a module" ile sessizce kırılır.
//
// 🔴 İKİ DERLEME: `npm run build` YAYIN derlemesi (`__DEV__` false),
// `npm run build:dev` geliştirme derlemesi (`__DEV__` true). Yayında konsol
// test globali (`window.__reelvocabTest`) ve kullanıcı içeriği basan bilgi
// logları (ham model yanıtı, madde listeleri, segment tabloları, köprü
// yükü) YOK; build dist/'i tarayıp bunu doğruluyor. Ölçüm ve konsol
// tetikleyicisi build:dev ister. `--watch` her zaman geliştirme derlemesi.
//
// Statik dosyalar kopyalanır, derlenmez: manifest, simgeler, ayar sayfası ve
// overlay stilleri. Manifest'in yola bakan alanları dist/ kökünü varsayıyor,
// bu yüzden dosyalar düz kopyalanıp klasör yapısı düzleştiriliyor
// (src/options/options.html → dist/options.html).

import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import { loadShowcaseValidator } from "./lib/showcase-validator.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, "dist");

const WATCH = process.argv.includes("--watch");
const DEV = WATCH || process.argv.includes("--dev");

/** @param {string[]} errors */
function failBuild(title, errors) {
  console.error(`[build] ✗ ${title} — build durduruldu:`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

/** Bir TS modülünü bellekte derleyip içe aktarır (showcase-validator ile aynı yol). */
async function importTs(path) {
  const result = await esbuild.build({
    entryPoints: [path],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`${path} derlenemedi: çıktı yok`);
  const url = `data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`;
  /** @type {Record<string, unknown>} */
  const module = await import(url);
  return module;
}

// ── Manifest tutarlılığı ────────────────────────────────────────────────────
//
// manifest.json yorum ve içe aktarma kabul etmiyor; koddaki değerlerle elle
// eşleşen alanlar burada karşılaştırılıyor. Uyuşmazlık build'i durduruyor —
// yayında sessiz kırılma yerine.
//
//  · `version` — tek doğruluk kaynağı package.json. Manifest'e YAZILMIYOR,
//    karşılaştırılıyor: kaynaktaki manifest ile dist'teki aynı kalsın, biri
//    diğerinden farklı bir sürüm söylemesin.
//  · `version_name` — package.json → `versionName`, aynı kural. Gerekçe: rc1
//    ve rc2 aynı sürümü (0.1.0) taşıyordu; test sırasında yanlış paket
//    yüklüydü ve sürüme bakarak ayırt edilemedi. `version_name`
//    chrome://extensions'da görünüyor, adayları ayırıyor. `version` Chrome'un
//    güncelleme karşılaştırması için yalnız sayı kabul ediyor, "-rc2" oraya
//    yazılamaz.
//  · `optional_host_permissions` — src/lib/permissions.ts → MISTRAL_ORIGINS.
//    Ayrışırsa ayar sayfası bir kökene izin ister, background başka birine
//    bakar ve her çağrı `PERMISSION_MISSING` olur.
//  · `name` / `description` — `__MSG_…__` ile dil dosyalarından geliyor;
//    varlıkları ve 132 karakter sınırı `checkLocales`'ta.

async function checkManifest() {
  const manifest = JSON.parse(await readFile(resolve(ROOT, "manifest.json"), "utf8"));
  const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
  const permissions = await importTs(resolve(ROOT, "src/lib/permissions.ts"));

  /** @type {string[]} */
  const errors = [];

  if (manifest.version !== pkg.version) {
    errors.push(
      `sürüm uyuşmuyor: package.json ${JSON.stringify(pkg.version)}, manifest.json ${JSON.stringify(manifest.version)}`,
    );
  }

  if (manifest.version_name !== pkg.versionName) {
    errors.push(
      `sürüm adı uyuşmuyor: package.json versionName ${JSON.stringify(pkg.versionName)}, manifest.json version_name ${JSON.stringify(manifest.version_name)}`,
    );
  }

  const declared = manifest.optional_host_permissions ?? [];
  if (!isDeepStrictEqual(declared, permissions.MISTRAL_ORIGINS)) {
    errors.push(
      `optional_host_permissions ${JSON.stringify(declared)} ≠ src/lib/permissions.ts MISTRAL_ORIGINS ${JSON.stringify(permissions.MISTRAL_ORIGINS)}`,
    );
  }

  if (errors.length > 0) failBuild("manifest tutarsız", errors);
  return { version: pkg.version, manifestText: JSON.stringify(manifest) };
}

const { version, manifestText } = await checkManifest();

// ── Dil dosyaları (_locales) ────────────────────────────────────────────────
//
// 🔴 `chrome.i18n.getMessage` olmayan bir anahtar için SESSİZCE boş dize
// döndürüyor: yazım hatası panelde boş bir düğme olur ve fark edilmez. Bu
// yüzden build şunları doğruluyor, biri tutmazsa DURUYOR:
//
//  · iki dil dosyası aynı anahtar kümesine sahip;
//  · kaynaktaki her `msg("…")` / `getMessage("…")` çağrısının, her
//    `data-i18n="…"` özniteliğinin ve manifest'teki her `__MSG_…__`
//    başvurusunun anahtarı dil dosyalarında var;
//  · `msg(` ilk argümanı dize sabiti — değişkenden gelen anahtar statik
//    olarak doğrulanamaz. Tek istisna satırında `i18n-dynamic` işareti
//    taşıyor (ayar sayfası, anahtarı HTML'den okuyor; HTML de burada taranıyor);
//  · yer tutucular iki dilde tutarlı: aynı adlar, aynı `$n` içerikleri,
//    mesajda kullanılan her `$AD$` tanımlı, tanımlı her ad kullanılıyor;
//  · `extDescription` iki dilde de ≤ 132 karakter (Web Store sınırı).
//
// ⚠️ Çağrıdaki argüman SAYISI yer tutucu sayısıyla karşılaştırılmıyor —
// argümanlar iç içe çağrı içerebiliyor, düzenli ifadeyle güvenle ayrılamıyor.
const LOCALES_DIR = resolve(ROOT, "_locales");
const LOCALES = ["en", "tr"];
const DESCRIPTION_LIMIT = 132;

/** `$AD$` biçimli yer tutucu başvuruları (`$$` kaçış, `$1` doğrudan başvuru değil). */
function placeholderRefs(message) {
  return new Set([...message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)].map((m) => m[1].toLowerCase()));
}

async function listSourceFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listSourceFiles(path)));
    else if (/\.(ts|html)$/.test(entry.name)) files.push(path);
  }
  return files;
}

async function checkLocales() {
  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, Record<string, { message: string, placeholders?: Record<string, { content: string }> }>>} */
  const locales = {};
  for (const lang of LOCALES) {
    const file = resolve(LOCALES_DIR, lang, "messages.json");
    try {
      locales[lang] = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      failBuild("dil dosyası okunamadı", [
        `_locales/${lang}/messages.json: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }

  const [base, ...others] = LOCALES;
  const baseKeys = new Set(Object.keys(locales[base]));

  // 1) Aynı anahtar kümesi.
  for (const lang of others) {
    const keys = new Set(Object.keys(locales[lang]));
    for (const key of baseKeys) if (!keys.has(key)) errors.push(`${lang}: "${key}" eksik (${base}'de var)`);
    for (const key of keys) if (!baseKeys.has(key)) errors.push(`${lang}: "${key}" fazla (${base}'de yok)`);
  }

  // 2) Yer tutucular.
  for (const key of baseKeys) {
    /** @type {string | undefined} */
    let reference;
    for (const lang of LOCALES) {
      const entry = locales[lang][key];
      if (!entry) continue;
      if (typeof entry.message !== "string") {
        errors.push(`${lang}: "${key}".message dize değil`);
        continue;
      }
      const defined = Object.fromEntries(
        Object.entries(entry.placeholders ?? {}).map(([name, value]) => [name.toLowerCase(), value?.content]),
      );
      const used = placeholderRefs(entry.message);
      for (const name of used) {
        if (!(name in defined)) errors.push(`${lang}: "${key}" $${name.toUpperCase()}$ kullanıyor ama tanımlı değil`);
      }
      for (const name of Object.keys(defined)) {
        if (!used.has(name)) errors.push(`${lang}: "${key}" yer tutucu "${name}" tanımlı ama kullanılmıyor`);
      }
      const signature = JSON.stringify(Object.entries(defined).sort());
      if (reference === undefined) reference = signature;
      else if (signature !== reference) {
        errors.push(`"${key}": yer tutucular dillerde farklı (${base}: ${reference}, ${lang}: ${signature})`);
      }
    }
  }

  // 3) Mağaza açıklaması sınırı.
  for (const lang of LOCALES) {
    const description = locales[lang].extDescription?.message ?? "";
    const length = [...description].length;
    if (length > DESCRIPTION_LIMIT) {
      errors.push(`${lang}: extDescription ${length} karakter (sınır ${DESCRIPTION_LIMIT})`);
    }
  }

  // 4) Kaynaktaki başvurular.
  /** @type {{ key: string, where: string }[]} */
  const references = [];
  for (const file of await listSourceFiles(resolve(ROOT, "src"))) {
    const relative = file.slice(ROOT.length + 1);
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      const where = `${relative}:${index + 1}`;
      const trimmed = line.trim();
      // Yorum satırları atlanıyor: belgeler `msg("…")` gibi örnekler içeriyor.
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;

      // `msg`'nin kendi tanımı (i18n.ts) çağrı değil.
      if (relative !== "src/lib/i18n.ts") {
        for (const match of line.matchAll(/\bmsg\(\s*([^\s)])/g)) {
          if (match[1] === '"' || line.includes("i18n-dynamic")) continue;
          errors.push(`${where}: msg() anahtarı dize sabiti değil — statik doğrulanamaz`);
        }
      }
      for (const match of line.matchAll(/\b(?:msg|getMessage)\(\s*"([^"]+)"/g)) {
        references.push({ key: match[1], where });
      }
      for (const match of line.matchAll(/\bdata-i18n="([^"]*)"/g)) {
        references.push({ key: match[1], where });
      }
    });
  }
  for (const match of manifestText.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) {
    references.push({ key: match[1], where: "manifest.json" });
  }

  const referenced = new Set();
  for (const { key, where } of references) {
    referenced.add(key);
    if (!baseKeys.has(key)) errors.push(`${where}: "${key}" dil dosyalarında yok`);
  }

  if (errors.length > 0) failBuild(`${errors.length} dil dosyası hatası`, errors);

  // Kullanılmayan anahtar HATA DEĞİL (zararsız), ama görünür olsun.
  const unused = [...baseKeys].filter((key) => !referenced.has(key));
  if (unused.length > 0) console.warn(`[build] ⚠ kullanılmayan dil anahtarı: ${unused.join(", ")}`);
  console.log(
    `[build] dil dosyaları doğrulandı: ${LOCALES.join(", ")} · ${baseKeys.size} anahtar · ${references.length} başvuru`,
  );
}

await checkLocales();

// Annotasyon promptu derleme sırasında kodun içine GÖMÜLÜYOR.
//
// Neden inject: `prompts/annotate_v6.md` tek kaynak olarak birebir KALIR,
// ama service worker'da dosya okumak
// `fetch(chrome.runtime.getURL(...))` gerektirir ve promptu ayrıca web
// erişilebilir kaynak yapmak gerekirdi. `define` ile gömmek dosyayı
// değiştirmeden bunların hepsini ortadan kaldırıyor.
//
// ⚠️ Prompt değiştiğinde yeniden build gerekiyor; `--watch` bu dosyayı
// İZLEMİYOR (esbuild yalnız içe aktarılan modülleri izler).
const ANNOTATE_PROMPT_PATH = resolve(ROOT, "prompts/annotate_v6.md");
const annotatePrompt = await readFile(ANNOTATE_PROMPT_PATH, "utf8");

// Vitrin videoları — derleme zamanında GÖMÜLÜYOR.
//
// 🔴 `web_accessible_resources` KULLANILMIYOR. O yol dosyaları HER web
// sayfasının okuyabileceği hale getirir ve eklentinin parmak izini çıkarmaya
// yarar (bir sayfa `chrome-extension://<id>/showcase/...` isteyip eklentinin
// kurulu olduğunu anlayabilir). Veri background bundle'ında duruyor; içerik
// betiği ve ayar sayfası onu `chrome.runtime` mesajıyla istiyor.
//
// 🔴 BOZUK VİTRİN DOSYASI BUILD'İ BAŞARISIZ YAPAR. Önceden bozuk dosya
// çalışma zamanında atlanıyor ve konsola uyarı düşüyordu — yayında bu, bir
// vitrin videosunun sessizce "işlenmemiş" görünmesi demek ve fark edilmez.
// Şimdi gömülmeden önce doğrulanıyor; geçersiz JSON, şemaya uymayan dosya,
// `segmentText` içeren dosya ya da aynı `videoId`'yi taşıyan iki dosya varsa
// build sıfır olmayan çıkış koduyla duruyor ve hangi dosyada ne olduğunu
// söylüyor.
//
// Doğrulama `src/lib/showcase.ts`'teki `parseShowcase()`'in KENDİSİ — kopya
// değil (scripts/lib/showcase-validator.mjs). Çalışma zamanındaki doğrulama da
// kalıyor (derin savunma), ama artık yalnız beklenmedik durum için.
//
// ⚠️ `--watch` bu klasörü İZLEMİYOR; vitrin dosyası değişince yeniden build.
const SHOWCASE_DIR = resolve(ROOT, "src/showcase");

async function readShowcaseFiles() {
  let names = [];
  try {
    names = await readdir(SHOWCASE_DIR);
  } catch {
    // Klasör yoksa sıfır vitrin videosu — kod bununla da çalışıyor.
    return [];
  }

  const files = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    files.push({ file: name, text: await readFile(resolve(SHOWCASE_DIR, name), "utf8") });
  }
  return files;
}

/** @param {{ file: string, text: string }[]} files */
async function validateShowcaseFiles(files) {
  const { parseShowcase } = await loadShowcaseValidator();
  /** @type {string[]} */
  const errors = [];
  /** @type {Map<string, string>} videoId → ilk tanımlandığı dosya */
  const seen = new Map();

  for (const { file, text } of files) {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      errors.push(`${file}: geçersiz JSON — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    // `segmentText` kontrolü `parseShowcase` içinde (karar 8).
    const result = parseShowcase(parsed, file);
    if (!result.ok) {
      errors.push(result.reason);
      continue;
    }

    const videoId = result.video.videoId;
    const first = seen.get(videoId);
    if (first !== undefined) {
      errors.push(`${file}: videoId "${videoId}" zaten ${first} dosyasında tanımlı`);
      continue;
    }
    seen.set(videoId, file);
  }

  if (errors.length > 0) failBuild(`${errors.length} vitrin hatası`, errors);
}

const showcaseFiles = await readShowcaseFiles();
await validateShowcaseFiles(showcaseFiles);
console.log(`[build] ${showcaseFiles.length} vitrin dosyası doğrulandı ve gömülüyor`);

/**
 * Gömülen sabitler. Kullanan dosyalarda `declare const` ile bildiriliyor;
 * ayrı bir `.d.ts` dosyası ya da `.md` için loader tanımı gerekmiyor.
 */
const DEFINE = {
  __ANNOTATE_V6_PROMPT__: JSON.stringify(annotatePrompt),
  // `[{ file, text }]` — yalnız background.ts okuyor.
  __SHOWCASE_FILES__: JSON.stringify(showcaseFiles),
  // `if (__DEV__) { … }` yayında `if (false)` oluyor ve esbuild bloğu atıyor.
  __DEV__: JSON.stringify(DEV),
};

/**
 * Yayın derlemesinde ölü dal eleme. ÖLÇÜLDÜ (22 Eyl 2026): `define` tek başına
 * `if (__DEV__)`'yi `if (false)`'a çeviriyor ama esbuild minify seçeneği
 * olmadan bloğu ATMIYOR — `window.__reelvocabTest` ataması ve "ham content"
 * logu dist/'te duruyordu (`checkReleaseOutput` yakaladı). `minifySyntax`
 * blokları atıyor; `minifyWhitespace` yorumları siliyor (esbuild yorumları
 * koruyor ve yorumlarda da bu adlar geçiyor). Tanımlayıcılar KISALTILMIYOR
 * (`minifyIdentifiers` yok): yayındaki hata yığınları okunabilir kalsın.
 */
const RELEASE_TRANSFORM = DEV ? {} : { minifySyntax: true, minifyWhitespace: true };

// Chrome 114 tabanı manifest.json'daki `minimum_chrome_version` ile aynı;
// ikisi birlikte değişir.
const TARGET = "chrome114";

/** Service worker — ESM. */
const backgroundOptions = {
  entryPoints: { background: resolve(ROOT, "src/background.ts") },
  outdir: DIST,
  bundle: true,
  format: "esm",
  target: TARGET,
  platform: "browser",
  define: DEFINE,
  ...RELEASE_TRANSFORM,
  sourcemap: WATCH ? "inline" : false,
  logLevel: "info",
};

/**
 * Content script'ler + ayar sayfası — IIFE.
 *
 * `main-world` sayfa ortamında (`"world": "MAIN"`) koşuyor, `content` izole
 * ortamda. Aynı biçimi paylaştıkları için tek koşuda derleniyorlar; ortam
 * ayrımı manifest'te yapılıyor, burada değil.
 *
 * `options` normal bir eklenti sayfası olduğu için ESM de çalışırdı
 * (`<script type="module">`). Yine de IIFE seçildi:
 *  · sayfa tek, kendi kendine yeten bir betik yüklüyor — modül grafiği yok,
 *    dinamik import yok, yani ESM'in getirdiği hiçbir özellik kullanılmıyor;
 *  · düz `<script src>` etiketi `type="module"` gerektirmeden çalışıyor,
 *    HTML'de unutulabilecek bir ayrıntı eksiliyor;
 *  · üçüncü bir esbuild yapılandırması açmak yerine mevcut koşuya ekleniyor.
 * ESM yalnız service worker'da kullanılıyor, çünkü manifest orada
 * `"type": "module"` diyor.
 */
const contentOptions = {
  entryPoints: {
    content: resolve(ROOT, "src/content.ts"),
    "main-world": resolve(ROOT, "src/main-world.ts"),
    options: resolve(ROOT, "src/options/options.ts"),
  },
  outdir: DIST,
  bundle: true,
  format: "iife",
  target: TARGET,
  platform: "browser",
  define: DEFINE,
  ...RELEASE_TRANSFORM,
  sourcemap: WATCH ? "inline" : false,
  logLevel: "info",
};

/** [kaynak, dist içindeki hedef] — hedef yolu manifest'in beklediği yol. */
const STATIC_FILES = [
  ["manifest.json", "manifest.json"],
  // Klasör: chrome.i18n dil dosyaları. Manifest `default_locale` istiyor.
  ["_locales", "_locales"],
  ["icons/icon16.png", "icons/icon16.png"],
  ["icons/icon32.png", "icons/icon32.png"],
  ["icons/icon48.png", "icons/icon48.png"],
  ["icons/icon128.png", "icons/icon128.png"],
  ["src/options/options.html", "options.html"],
  ["src/overlay/overlay.css", "overlay.css"],
];

async function copyStaticFiles() {
  for (const [from, to] of STATIC_FILES) {
    const target = resolve(DIST, to);
    await mkdir(dirname(target), { recursive: true });
    await cp(resolve(ROOT, from), target, { recursive: true });
  }
  console.log(`[build] ${STATIC_FILES.length} statik dosya kopyalandı`);
}

// ── Yayın derlemesi doğrulaması ─────────────────────────────────────────────
//
// `__DEV__` bloklarının gerçekten atıldığını KODA güvenmeden, çıktıya bakarak
// doğruluyor. Bir log `if (__DEV__)` dışında kalırsa ya da esbuild bloğu
// atmazsa build başarısız oluyor.
const RELEASE_FORBIDDEN = [
  // Konsol test globali — yalnız geliştirme derlemesinde.
  "__reelvocabTest",
  // Ham model yanıtını basan log (annotate.ts).
  "ham content",
];

async function listFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files;
}

async function checkReleaseOutput() {
  /** @type {string[]} */
  const errors = [];
  for (const file of await listFiles(DIST)) {
    if (file.endsWith(".png")) continue;
    const text = await readFile(file, "utf8");
    for (const needle of RELEASE_FORBIDDEN) {
      if (text.includes(needle)) errors.push(`${file.slice(DIST.length + 1)}: "${needle}" geçiyor`);
    }
  }
  if (errors.length > 0) failBuild("yayın derlemesinde geliştirme kodu var", errors);
  console.log(`[build] yayın doğrulaması: ${RELEASE_FORBIDDEN.map((n) => `"${n}"`).join(", ")} dist/'te yok`);
}

async function main() {
  // Temiz başlangıç: dist/ silinmezse kaldırılan bir giriş noktasının eski
  // çıktısı orada kalır ve manifest onu yüklemeye devam eder.
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  if (!WATCH) {
    await Promise.all([
      esbuild.build(backgroundOptions),
      esbuild.build(contentOptions),
    ]);
    await copyStaticFiles();
    if (!DEV) await checkReleaseOutput();
    console.log(`[build] bitti → dist/ (${DEV ? "GELİŞTİRME" : "YAYIN"} derlemesi, sürüm ${version})`);
    return;
  }

  const contexts = await Promise.all([
    esbuild.context(backgroundOptions),
    esbuild.context(contentOptions),
  ]);
  await Promise.all(contexts.map((context) => context.watch()));
  await copyStaticFiles();

  // ⚠️ Statik dosyalar İZLENMİYOR: manifest.json ya da overlay.css
  // değiştiğinde `npm run build` yeniden koşulmalı. esbuild'in watch'ı yalnız
  // derlediği giriş noktalarını izliyor.
  console.log("[build] izleme modu — statik dosyalar izlenmiyor, TS izleniyor");
}

await main();
