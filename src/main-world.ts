// Sayfa ortamı (MAIN) giriş noktası.
//
// Bu betik YouTube'un kendi JS'iyle AYNI ortamda koşuyor: `ytInitialPlayerResponse`
// ve `#movie_player` metodları buradan görünür, ama `chrome.*` API'leri YOK.
//
// Bu dosya YouTube altyazılarını çeker ve sonucu ISOLATED betiğe köprüler.
// Overlay çizmez, veri saklamaz, LLM çağırmaz.
//
// Betik manifest'ten değil, ikon tıklamasında `chrome.scripting` ile enjekte
// ediliyor (background.ts).
//
// 🔴 OTOMATİK TETİKLEME YOK — bilinçli. Sayfa açılışında kendiliğinden
// çalışsaydı her YouTube sekmesi YouTube'a bir `timedtext` isteği atardı ve
// 429 riskini artırırdı: sınır IP bazlı ve endpoint'in tamamını kapsıyor,
// yani kullanıcının KENDİ altyazıları da bozulur. Bu yüzden tetikleyici
// konsoldan elle çağrılıyor.

import { fetchCaptions } from "./lib/captions";
import { ALLOWED_MODELS, DEFAULT_MODEL, asModelId } from "./lib/models";

// ⚠️ Bu global, MAIN betiğinin sayfa global'lerine yazmaması kuralına bilinçli
// bir istisnadır ve YALNIZ GELİŞTİRME DERLEMESİNDE
// (`npm run build:dev`) vardır. Yayın derlemesinde atama `__DEV__` ile
// düşüyor; build.mjs dist/'te bu adın geçmediğini doğruluyor.
declare global {
  interface Window {
    __reelvocabTest?: (options?: TestOptions) => Promise<unknown>;
  }
}

/** Köprü mesajının kimliği. İzole taraf tam olarak bu ikiliyi arar. */
const MESSAGE_SOURCE = "reelvocab";
const MESSAGE_TYPE = "captions-result";

/** İzole tarafın işi bitince geri yolladığı özetin tipi. */
const SUMMARY_TYPE = "annotation-summary";

/** İzole tarafın "koşumu başlat" isteği (eklenti ikonu tetiği). */
const START_TYPE = "start-run";

/** Ayarlanabilir koşum parametreleri — konsoldan verilir, build gerekmez. */
export interface TestOptions {
  /** Chunk başına segment sayısı. Verilmezse izole tarafın varsayılanı. */
  chunkSize?: number;
  /** İşlenecek chunk sayısı üst sınırı — test maliyetini kontrol etmek için. */
  maxChunks?: number;
  /**
   * Model — yalnız izinli listeden (`models.ts`). Verilmezse
   * `mistral-large-2512` (kalibre edilmiş). Serbest dize reddedilir.
   */
  model?: string;
}

/** İstek/yanıt eşleştirme sayacı: birden çok koşum karışmasın. */
let requestCounter = 0;

const LOG_PREFIX = "[reelvocab:main]";

/** Konsola basılacak segment sayısı. Tamamı çok uzun. */
const PREVIEW_COUNT = 5;

/**
 * Yalnız izleme sayfasında altyazı çekilir.
 *
 * Kontrol İSTEK ANINDA yapılıyor, yükleme anında değil: betik ikon
 * tıklamasıyla herhangi bir YouTube sayfasına (ana sayfa, arama) enjekte
 * edilebiliyor ve SPA gezinmesinde sayfada kalıyor. Yükleme anında /watch
 * değilse dinleyiciyi kurmamak, kullanıcı sonradan bir videoya geçtiğinde
 * köprüyü ölü bırakırdı.
 */
function isWatchPage(): boolean {
  return window.location.pathname === "/watch";
}

/**
 * Sonucu izole tarafa geçirir.
 *
 * `targetOrigin` olarak sayfanın kendi origin'i veriliyor: `"*"` mesajı
 * herhangi bir dinleyiciye açık ederdi.
 */
function postToIsolated(
  payload: unknown,
  requestId: string,
  options: TestOptions,
  autoStart: boolean,
  videoId: string | undefined,
): void {
  window.postMessage(
    {
      source: MESSAGE_SOURCE,
      type: MESSAGE_TYPE,
      payload,
      requestId,
      options,
      // 🔴 Sonucun ait olduğu video — çekme BAŞLADIĞINDAKİ adres. SPA
      // gezinmesinde sonuç, kullanıcı başka videoya geçtikten sonra gelebilir;
      // izole taraf bunu aktif videoyla karşılaştırıp bayat sonucu atıyor.
      videoId,
      // 🔴 `autoStart` iki tetikleme yolunu ayırıyor: konsol yolu (bu dosya,
      // `__reelvocabTest`) onay beklemeden koşuyor; eklenti ikonu yolu
      // önizlemede duruyor ve pahalı kısmı kullanıcının "Başlat"ına bırakıyor.
      autoStart,
    },
    window.location.origin,
  );
}

/**
 * İzole tarafın özetini bekler.
 *
 * Dönen değer `unknown`: özet güvenilmez bir kanaldan (`postMessage`, sayfadaki
 * her koda açık) geliyor ve buradaki tek işi konsolda incelenmek. Tam şeklini
 * burada yeniden tiplemek, teşhis yolunda hiçbir şey kazandırmadan tipi iki
 * yerde tutmak olurdu.
 *
 * ⚠️ Zaman aşımı YOK: izole taraf her durumda (başarısız chunk'larda da) özet
 * yolluyor, ama yollamazsa bu promise asılı kalır.
 */
function waitForSummary(requestId: string): Promise<unknown> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;

      const data =
        typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : undefined;
      if (!data) return;
      if (data.source !== MESSAGE_SOURCE || data.type !== SUMMARY_TYPE) return;
      if (data.requestId !== requestId) return;

      window.removeEventListener("message", onMessage);
      resolve(data.summary);
    };

    window.addEventListener("message", onMessage);
  });
}

async function runTest(
  options: TestOptions = {},
  autoStart = true,
): Promise<unknown> {
  requestCounter += 1;
  const requestId = `${Date.now()}-${requestCounter}`;

  // İzleme sayfası değilse altyazı çekmeye hiç kalkışılmıyor; izole tarafa
  // anlaşılır bir hata gidiyor, panel "bir video sayfası açın" diyor.
  if (!isWatchPage()) {
    console.warn(`${LOG_PREFIX} izleme sayfası değil (${window.location.pathname})`);
    const result = { ok: false, error: "NOT_WATCH_PAGE" };
    postToIsolated(result, requestId, options, autoStart, undefined);
    return result;
  }

  // 🔴 Model GİRİŞTE doğrulanıyor: listede olmayan bir ad için altyazı bile
  // çekilmiyor. Varsayılana sessizce düşmek, "medium'u ölçtüm" sanan kişiye
  // large sonucunu gösterirdi.
  if (options.model !== undefined && asModelId(options.model) === undefined) {
    console.error(
      `${LOG_PREFIX} bilinmeyen model: "${options.model}". İzinli: ${ALLOWED_MODELS.join(", ")}`,
    );
    return { ok: false, error: "UNKNOWN_MODEL" };
  }

  console.log(
    `${LOG_PREFIX} fetchCaptions() çağrılıyor… (model: ${options.model ?? DEFAULT_MODEL})`,
  );

  // Çekme BAŞLARKEN hangi videodaydık — sonuç buna etiketleniyor.
  const pageVideoId = new URL(window.location.href).searchParams.get("v") ?? undefined;

  const result = await fetchCaptions();

  if (!result.ok) {
    console.warn(`${LOG_PREFIX} BAŞARISIZ — hata sınıfı: ${result.error}`);
    // Özet beklenmiyor: annotasyon hiç başlamayacak.
    postToIsolated(result, requestId, options, autoStart, pageVideoId);
    return result;
  }

  const { segments, isAsr, languageCode, nativeCaptionsWereOn } = result.data;

  console.log(`${LOG_PREFIX} BAŞARILI`, {
    segmentSayısı: segments.length,
    isAsr,
    languageCode,
    nativeCaptionsWereOn,
  });

  // İlk birkaç segment: zaman damgalarının ve temizliğin gözle kontrolü için.
  // ASR skorları da burada görünüyor — karar için değil, bakmak için.
  // Altyazı metni taşıyor: yalnız geliştirme derlemesinde.
  if (__DEV__) console.table(
    segments.slice(0, PREVIEW_COUNT).map((segment) => ({
      start: segment.start,
      end: segment.end,
      text: segment.text,
      asrConfMin: segment.asrConfMin,
      asrConfAvg: segment.asrConfAvg,
    })),
  );

  // Kullanıcının altyazı durumu `fetchCaptions` dönmeden ÖNCE, başarıda da
  // hatada da geri kuruldu (`captions.ts` → `captureStrategy` → `finally`).
  // Burada yalnız bilgi: önceden bu satır geri yüklemeyi kendisi yapıyordu ve
  // yalnız başarı yolunda — hata yolunda altyazı kapalı kalıyordu.
  if (nativeCaptionsWereOn) {
    console.log(`${LOG_PREFIX} native altyazı geri açıldı (${languageCode})`);
  }

  // Özet dinleyicisi mesajdan ÖNCE kurulur: izole taraf çok hızlı yanıtlarsa
  // (ör. önbellekten dolarsa) mesajı kaçırmayalım.
  const summaryPromise = waitForSummary(requestId);
  postToIsolated(result, requestId, options, autoStart, pageVideoId);

  // ⚠️ Önizleme yolunda (`autoStart: false`) özet, kullanıcı "Başlat"a basana
  // kadar GELMEZ; basmazsa hiç gelmez. Konsol yolu için bekleme anlamlı,
  // ikon yolu için dönen değer kullanılmıyor.
  return summaryPromise;
}

/**
 * Koşumu izole taraftan başlatma yolu.
 *
 * Eklenti ikonu yalnız background'a ulaşıyor, background da yalnız izole
 * tarafa mesaj atabiliyor; altyazı çekme ise MAIN'de olmak zorunda. Zincirin
 * son halkası bu dinleyici.
 *
 * 🔴 Mesaj güvenilmez kanaldan geliyor (`postMessage` sayfadaki her koda
 * açık): burada YALNIZ koşum başlatılıyor, gelen veriden hiçbir şey
 * okunmuyor. Parametreler de bilinçli olarak yok sayılıyor — sayfadaki
 * herhangi bir kod bu mesajı üretebilir, dolayısıyla chunk boyutu gibi
 * maliyeti etkileyen değerleri oradan almıyoruz.
 */
function listenForStart(): void {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    const data =
      typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : undefined;
    if (!data) return;
    if (data.source !== MESSAGE_SOURCE || data.type !== START_TYPE) return;

    // 🔴 ÇİFT ENJEKSİYON KORUMASI — global'siz. Betik iki kez enjekte
    // edildiyse (izole taraf yüklenemeden bir hata olup ikon tekrar
    // tıklandıysa) iki dinleyici var. İlk kurulan önce çağrılıyor ve olayı
    // burada durduruyor; ikincisi hiç görmüyor — tek istek, tek altyazı
    // çekimi. Önceki koruma `__reelvocabTest`'in varlığına bakıyordu; o
    // global yayında yok ve sayfaya işaret bırakmak için yeni bir global
    // açmak, "MAIN global'e yazmaz" kuralını bozardı.
    event.stopImmediatePropagation();

    console.log(`${LOG_PREFIX} koşum isteği alındı (eklenti ikonu)`);
    // Önizleme yolu: altyazı çekilir, işleme kullanıcının onayını bekler.
    void runTest({}, false);
  });
}

// Dinleyici HER ZAMAN kuruluyor — hangi YouTube sayfasında enjekte edilmiş
// olursa olsun (bkz. `isWatchPage`).
//
// Çift enjeksiyon koruması iki katmanlı: background izole taraftaki işarete
// bakıp betik varsa yeniden enjekte etmiyor; yine de ikinci bir kopya
// yüklenirse `listenForStart` içindeki `stopImmediatePropagation` ikinci
// dinleyiciyi susturuyor.
listenForStart();

if (__DEV__) {
  window.__reelvocabTest = runTest;
  console.log(
    `${LOG_PREFIX} hazır (geliştirme derlemesi). Konsola şunu yaz: await window.__reelvocabTest()` +
      ` — parametreli: await window.__reelvocabTest({ chunkSize: 10, maxChunks: 2, model: "mistral-medium-2604" })`,
  );
}
