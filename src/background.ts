// Service worker — annotasyon çağrısının yapıldığı yer.
//
// 🔴 NEDEN BURADA: BYOK anahtarı `chrome.storage.local` içinde duruyor ve MAIN
// ortamda `chrome.*` API'leri yok. Anahtarı MAIN'e taşımak, YouTube
// sayfasındaki HER kodun (sayfanın kendi JS'i, başka eklentiler, enjekte
// edilmiş her şey) erişebileceği bir yere API anahtarı koymak demektir. Ağa
// çıkan çağrı ve kalıcı veri bu yüzden hep bu tarafta.
//
// Her annotasyon mesajı tek bir chunk taşır; tüm-video kuyruğunu içerik betiği
// yönetir.

import { annotateChunk } from "./lib/annotate";
import type { AnnotateError, AnnotateOk } from "./lib/annotate";
import type { CaptionSegment } from "./lib/captions";
import { STORAGE_KEY_MISTRAL, isStaleCacheKey } from "./lib/storageKeys";
import { MISTRAL_ORIGINS } from "./lib/permissions";
import { ISOLATED_READY_FLAG } from "./lib/injection";
import { DEFAULT_MODEL, asModelId } from "./lib/models";
import type { ModelId } from "./lib/models";
import { parseShowcase } from "./lib/showcase";
import type { ShowcaseEntry, ShowcaseVideo } from "./lib/showcase";

// Vitrin dosyaları derleme zamanında gömülüyor (scripts/build.mjs →
// `__SHOWCASE_FILES__`, `[{ file, text }]`). `unknown` olarak alınıyor:
// içerik ham metin, burada ayrıştırılıp doğrulanıyor.
declare const __SHOWCASE_FILES__: unknown;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export interface AnnotateRequest {
  type: "annotate";
  segments: CaptionSegment[];
  /**
   * İzinli listeden model; `undefined` = mesaj izinli OLMAYAN bir model
   * taşıyordu (alan hiç yoksa varsayılan kullanılıyor, `undefined` değil).
   */
  model: ModelId | undefined;
}

/**
 * Content script'e dönen yanıt.
 *
 * Başarılı dal `AnnotateOk`'un kendisi: süzülmüş sonucun yanında `totalItems`
 * ve `rejections` de mesajla geçiyor. Bu alanları tipte tekrar tanımlamak
 * yerine kaynağından almak, ikisinin ayrışmasını engelliyor — tip eksik
 * kaldığında alanlar çalışma zamanında sessizce taşınıyor ve okuyan taraf
 * onları hiç bilmiyordu.
 */
/**
 * `annotate.ts`'in hata sınıflarına background'ın kendi eklediği tek sınıf:
 * `PERMISSION_MISSING` — anahtar var ama Mistral kökenine izin verilmemiş.
 * `annotate.ts`'e eklenmedi: izin, sağlayıcı adaptörünün değil eklentinin
 * meselesi (kurulumda istenmiyor, ayar sayfasında isteniyor).
 */
export type BackgroundError = AnnotateError | "PERMISSION_MISSING";

export type AnnotateResponse = AnnotateOk | { ok: false; error: BackgroundError };

/**
 * Gelen mesajı doğrular.
 *
 * Mesaj içeriği zincirin ucunda MAIN ortamından geliyor, yani sayfadaki her
 * kodun yazabildiği güvenilmez bir kanaldan geçmiş. Burada biçim yeniden doğrulanıyor;
 * content script'in doğruladığına güvenilmiyor.
 *
 * Yalnız `text` alanı kullanılıyor, ama `start`/`end` de biçim kontrolünden
 * geçiyor: eksikse gelen şey bizim segment listemiz değil demektir.
 */
function parseAnnotateRequest(message: unknown): AnnotateRequest | undefined {
  const raw = asRecord(message);
  if (!raw || raw.type !== "annotate") return undefined;

  if (!Array.isArray(raw.segments)) return undefined;

  const segments: CaptionSegment[] = [];
  for (const candidate of raw.segments) {
    const record = asRecord(candidate);
    if (!record) return undefined;

    const start = asNumber(record.start);
    const end = asNumber(record.end);
    const text = asString(record.text);
    if (start === undefined || end === undefined || text === undefined) {
      return undefined;
    }

    segments.push({ start, end, text });
  }

  if (segments.length === 0) return undefined;

  // Model: alan yoksa varsayılan; varsa İZİNLİ listeden olmak zorunda.
  // Serbest dize kabul edilmiyor — geçersiz model `undefined` olarak işaretlenip
  // açık bir hatayla reddediliyor, varsayılana sessizce düşülmüyor.
  const model = raw.model === undefined ? DEFAULT_MODEL : asModelId(raw.model);

  return { type: "annotate", segments, model };
}

/** Kullanıcının anahtarını okur. Yoksa boş dize — `annotateChunk` eler. */
async function readApiKey(): Promise<string> {
  const stored: unknown = await chrome.storage.local.get(STORAGE_KEY_MISTRAL);
  const value = asRecord(stored)?.[STORAGE_KEY_MISTRAL];
  return typeof value === "string" ? value : "";
}

async function handleAnnotate(request: AnnotateRequest): Promise<AnnotateResponse> {
  let apiKey: string;
  try {
    apiKey = await readApiKey();
  } catch {
    return { ok: false, error: "NO_API_KEY" };
  }

  if (apiKey.trim() === "") return { ok: false, error: "NO_API_KEY" };

  if (request.model === undefined) return { ok: false, error: "UNKNOWN_MODEL" };

  // 🔴 İzin çağrıdan ÖNCE kontrol ediliyor. Mistral kökeni kurulumda
  // istenmiyor (`optional_host_permissions`); kullanıcı anahtarı kaydederken
  // veriyor. İzin yoksa fetch CORS'a takılır ve `API_ERROR`'a düşerdi — sebebi
  // söylemeyen bir sınıf. Burada ayrı sınıf, panelde ne yapılacağını söyleyen
  // metin var.
  if (!(await hasMistralPermission())) return { ok: false, error: "PERMISSION_MISSING" };

  return annotateChunk(request.segments, apiKey, request.model);
}

// ── Vitrin (karar 8) ────────────────────────────────────────────────────────

let showcaseIndex: Map<string, ShowcaseVideo> | undefined;

/**
 * Gömülü vitrin dosyalarını bir kez ayrıştırır.
 *
 * DERİN SAVUNMA. Asıl doğrulama derleme zamanında: bozuk, şemaya uymayan,
 * `segmentText` içeren ya da `videoId`'si çakışan dosya build'i BAŞARISIZ
 * yapıyor (scripts/build.mjs). Buraya yalnız beklenmedik bir şey ulaşırsa
 * (elle düzenlenmiş `dist/`, build'i atlayan bir yol) bu kontroller devreye
 * giriyor: eklenti çökmüyor, o video vitrin dışı sayılıyor ve sebep konsola
 * yazılıyor.
 */
function showcases(): Map<string, ShowcaseVideo> {
  if (showcaseIndex) return showcaseIndex;
  showcaseIndex = new Map();

  const files = Array.isArray(__SHOWCASE_FILES__) ? __SHOWCASE_FILES__ : [];

  for (const entry of files) {
    const record = asRecord(entry);
    const file = asString(record?.file) ?? "(adsız)";
    const text = asString(record?.text);
    if (text === undefined) {
      console.warn(`[reelvocab:bg] vitrin dosyası okunamadı: ${file}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn(`[reelvocab:bg] vitrin dosyası reddedildi: ${file}: JSON değil`);
      continue;
    }

    const result = parseShowcase(parsed, file);
    if (!result.ok) {
      console.warn(`[reelvocab:bg] vitrin dosyası reddedildi: ${result.reason}`);
      continue;
    }

    if (showcaseIndex.has(result.video.videoId)) {
      console.warn(
        `[reelvocab:bg] vitrin dosyası reddedildi: ${file}: ${result.video.videoId} ikinci kez tanımlı`,
      );
      continue;
    }

    showcaseIndex.set(result.video.videoId, result.video);
  }

  console.log(`[reelvocab:bg] ${showcaseIndex.size} vitrin videosu yüklendi`);
  return showcaseIndex;
}

function showcaseEntries(): ShowcaseEntry[] {
  return [...showcases().values()].map((video) => ({
    videoId: video.videoId,
    title: video.title,
  }));
}

/**
 * Anahtar kayıtlı mı? — YALNIZ evet/hayır.
 *
 * İçerik betiği anahtarın kendisini değil, varlığını soruyor. Anahtar
 * `chrome.storage`'dan çıkıp içerik betiği bağlamına taşınmasın: gereken tek
 * bilgi "işleme mümkün mü".
 */
async function hasApiKey(): Promise<boolean> {
  try {
    return (await readApiKey()).trim() !== "";
  } catch {
    return false;
  }
}

/** Mistral kökenine isteğe bağlı izin verilmiş mi? */
async function hasMistralPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: MISTRAL_ORIGINS });
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Gönderen kontrolü: yalnız BU eklentinin kendi bağlamlarından gelen mesaj
  // kabul edilir. `sender.id` farklıysa mesaj başka bir eklentidendir
  // (harici mesajlar ayrı bir olayla gelir, ama kontrol ucuz ve açık).
  if (sender.id !== chrome.runtime.id) return false;

  const envelope = asRecord(message);

  switch (envelope?.type) {
    case "showcase-get": {
      const videoId = asString(envelope.videoId);
      sendResponse(videoId !== undefined ? showcases().get(videoId) ?? null : null);
      return false;
    }
    case "showcase-list": {
      sendResponse(showcaseEntries());
      return false;
    }
    case "key-status": {
      // İzin de burada soruluyor: panel, anahtar var ama izin yokken
      // "Başlat" yerine izin mesajını gösterebilsin — hata ancak Başlat'tan
      // sonra gelmesin. İçerik betiği `chrome.permissions`'a erişemiyor.
      void Promise.all([hasApiKey(), hasMistralPermission()]).then(([hasKey, permitted]) =>
        sendResponse({ hasKey, permitted }),
      );
      return true;
    }
    case "open-options": {
      // İçerik betiği ayar sayfasını kendisi açamıyor; background açıyor.
      void chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;
    }
    default:
      break;
  }

  const request = parseAnnotateRequest(message);
  if (!request) return false;

  handleAnnotate(request).then(sendResponse, (error: unknown) => {
    console.error("[reelvocab:bg] annotasyon hatası", error);
    sendResponse({ ok: false, error: "API_ERROR" } satisfies AnnotateResponse);
  });

  // `true` = yanıt asenkron gelecek; kanal açık tutulur.
  return true;
});

// ── Eklenti ikonu: tıklamada enjeksiyon ─────────────────────────────────────
//
// 🔴 MANİFEST'TE İÇERİK BETİĞİ YOK. Betikler kurulumda hiçbir sayfaya
// girmiyor; yalnız kullanıcı ikona tıklayınca, o SEKMEYE, `activeTab` +
// `scripting` ile enjekte ediliyor. Kurulumda site erişim uyarısı yok, eklenti
// YouTube'da kendiliğinden hiçbir şey yapmıyor.
//
// ⚠️ ÖLÇÜLMEDİ: `activeTab` izninin YouTube'un SPA gezinmesinden
// (`history.pushState`) sonra geçerli kalıp kalmadığı. Enjekte edilen betikler
// sayfada kaldığı için gezinmeden sonra yeniden enjeksiyon gerekmemeli —
// panel, içerik betiğinin kendi SPA algılamasıyla güncelleniyor. İzin düşmüş ve
// bir enjeksiyon/mesaj başarısız olmuşsa kullanıcı ikona tekrar basar: yeni bir
// jest, izni yeniliyor.

/**
 * Enjeksiyonu süren sekmeler. İki hızlı tıklama işaret kontrolünü ikisi de
 * "yok" görerek geçebiliyordu; enjeksiyon sürerken gelen tıklama yok
 * sayılıyor — paneli birincisi zaten açacak. Service worker uykuya geçerse küme boşalıyor
 * — o arada süren bir enjeksiyon da olamaz, zararsız.
 */
const injectingTabs = new Set<number>();

function isYouTubeUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "www.youtube.com" || parsed.hostname === "youtube.com")
    );
  } catch {
    return false;
  }
}

/**
 * Betikler bu sekmede zaten var mı?
 *
 * İşaret içerik betiğinin İZOLE ortamında duruyor — sayfa onu göremiyor,
 * yani sayfaya eklentinin parmak izini bırakmıyor. Kontrol de aynı izole
 * ortamda koşuyor (`executeScript`'in varsayılan ortamı).
 */
async function isInjected(tabId: number): Promise<boolean> {
  try {
    const [first] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (flag: string) =>
        (globalThis as unknown as Record<string, unknown>)[flag] === true,
      args: [ISOLATED_READY_FLAG],
    });
    return first?.result === true;
  } catch {
    return false;
  }
}

/**
 * Sekmeye betikleri enjekte eder (gerekirse) ve paneli açtırır.
 *
 * SIRA BAĞLAYICI: önce MAIN (köprünün sayfa tarafı; "başlat" dinleyicisi
 * hazır olsun), sonra stil, sonra ISOLATED (panel ve köprünün eklenti tarafı),
 * en son "aç" mesajı. İzole taraf MAIN'den önce hazır olursa ilk istek boşa
 * gidebilirdi.
 */
async function injectAndOpen(tabId: number): Promise<void> {
  if (injectingTabs.has(tabId)) return;
  injectingTabs.add(tabId);
  try {
    await injectIfMissing(tabId);
  } finally {
    injectingTabs.delete(tabId);
  }

  await chrome.tabs.sendMessage(tabId, { type: "run" });
}

async function injectIfMissing(tabId: number): Promise<void> {
  if (!(await isInjected(tabId))) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["main-world.js"],
      world: "MAIN",
    });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["overlay.css"] });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
      world: "ISOLATED",
    });
    if (__DEV__) console.log(`[reelvocab:bg] sekme ${tabId}: betikler enjekte edildi`);
  }
}

chrome.action.onClicked.addListener((tab) => {
  const tabId = tab.id;
  if (tabId === undefined) return;

  // YouTube dışında HİÇBİR ŞEY enjekte edilmiyor. Ayar sayfası açılıyor:
  // vitrin listesi orada, kullanıcı nereye gideceğini görüyor.
  if (!isYouTubeUrl(tab.url)) {
    void chrome.runtime.openOptionsPage();
    return;
  }

  injectAndOpen(tabId).catch((error: unknown) => {
    console.warn(
      "[reelvocab:bg] enjeksiyon/panel açma başarısız (ikona tekrar basmak izni yeniler):",
      error instanceof Error ? error.message : String(error),
    );
  });
});

/**
 * Eski sürüm önbellek kayıtlarını siler (`rv-cache:` ile başlayıp `v2`
 * olmayanlar).
 *
 * Sebep: v1 kayıtları `isAsr` ve dışa aktarım alanlarını taşımıyor; okunamıyor
 * ve hiçbir şey onları silmiyordu. Kurulum/güncellemede ve tarayıcı
 * başlangıcında bir kez çalışıyor — yalnız önbellek önekine dokunuyor; anahtar,
 * hata bildirimleri ve panel konumu yerinde kalıyor.
 */
async function purgeStaleCache(): Promise<void> {
  try {
    const all: unknown = await chrome.storage.local.get(null);
    const record = asRecord(all);
    if (!record) return;

    const stale = Object.keys(record).filter(isStaleCacheKey);
    if (stale.length === 0) return;

    await chrome.storage.local.remove(stale);
    console.log(`[reelvocab:bg] ${stale.length} eski önbellek kaydı silindi`);
  } catch (error) {
    console.warn("[reelvocab:bg] eski önbellek temizlenemedi:", error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void purgeStaleCache();
});
chrome.runtime.onStartup.addListener(() => {
  void purgeStaleCache();
});

console.log("[reelvocab:bg] service worker hazır");
