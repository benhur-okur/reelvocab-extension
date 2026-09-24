// ReelVocab paneli — sonucun SAYFADA göründüğü yer.
//
// 🔴 KAPSAM: liste paneli. Altyazı katmanı ve renklendirme YOK. Senkron
// TAKİP var ama zorlamasız: aktif madde vurgulanır, kullanıcı listeye
// dokunursa takip durur.
//
// Panel izole (ISOLATED) ortamda çiziliyor. DOM erişimi orada da var; sayfanın
// JS global'leri gerekmiyor.
//
// Bu dosya YALNIZ GÖRÜNÜMDÜR: depolama, video elementi, hata sınıfları ve
// koşum akışı `content.ts`'te. Panel neyi göstereceğini bilir, ne zaman
// göstereceğini bilmez.

import { msg } from "../lib/i18n";
import { showcaseUrl } from "../lib/showcase";
import type { ShowcaseEntry } from "../lib/showcase";

const PANEL_CLASS = "rv-panel";

// 🔴 KULLANICIYA DÜRÜST ÇERÇEVE — panelin en üstünde (`notice`, metni
// `_locales` → `panelDisclaimer`).
//
// Bu uyarı, otomatik kontrollerin yakalayamadığı kusurlara karşı tasarımın
// karşılığı: maddeler "sözlük gerçeği" gibi değil, "bu sahnede muhtemelen şu
// anlama geliyor" diye sunulmalı. Panel kullanıcının gördüğü ilk yüzey olduğu
// için uyarı orada duruyor ve kapatılamıyor.
//
// Yalnız listede madde varken görünüyor: anahtarsız görünümde ya da "Bu
// videoyu hazırla" beklerken açıklanacak bir şey yok, uyarı orada yalnız
// gürültüydü (gözlendi, 22 Eyl 2026).

/** Panelde gösterilecek tek madde. */
export interface PanelItem {
  term: string;
  senseHere: string;
  /** Uzun açıklama — varsayılan olarak KAPALI (aşağıdaki not). */
  nuance?: string;
  /** Maddenin geçtiği segmentin başlangıcı, saniye. */
  start: number;
  /** Segmentin bitişi — senkron takibinde aktif aralığı belirliyor. */
  end: number;
  /** Segmentin ham metni — hata bildiriminde bağlam olarak kaydediliyor. */
  segmentText: string;

  // ── Yalnız DIŞA AKTARIM için ──────────────────────────────────────────────
  // Panelde gösterilmiyorlar. "kopyala" çıktısı geliştirme ve eval içindir ve
  // tam veri gerektiriyor: bu alanlar olmadan vitrin dosyası üretilemiyordu
  // (dönüştürücü yer tutucu yazmak zorunda kalıyordu). Kaynak model çıktısı
  // şemadan geçmiş hali; vitrin verisinde `confidence` yok.
  type?: string;
  difficulty?: string;
  register?: string;
  confidence?: number;
}

/** Panelin sol üst köşesinin konumu (piksel). */
export interface PanelPosition {
  left: number;
  top: number;
}

export interface PanelOptions {
  /** Maddeye tıklanınca çağrılır; saniye cinsinden hedef konum. */
  onSeek: (seconds: number) => void;
  /** "yanlış" düğmesi — maddeyi yerel hata listesine yazar. */
  onReport: (item: PanelItem) => Promise<void>;
  /** "kopyala" düğmesi — maddeleri panoya JSON olarak yazar. */
  onCopy: () => Promise<void>;
  /** Ana düğme (Başlat / Yeniden işle). */
  onPrimary: () => void;
  /** Küçük ikincil eylem (vitrin videosunda "kendi anahtarınızla yeniden işleyin"). */
  onSecondary: () => void;
  /** Ayar sayfasını aç — içerik betiği bunu kendisi yapamıyor. */
  onOpenOptions: () => void;
  /** Panel kapatıldığında; çağıran tarafın durum bayrağını temizlemesi için. */
  onClose?: () => void;
  /** Sürükleme sonucu yeni konum; `undefined` = varsayılana dönüldü. */
  onMove?: (position: PanelPosition | undefined) => void;
}

export interface Panel {
  /** Durum satırı. `code` verilirse ham hata sınıfı küçük puntoyla eklenir. */
  setStatus(text: string, code?: string): void;
  /** Kaynağa dair ek uyarı (ör. otomatik altyazı). `undefined` gizler. */
  setSourceNote(text: string | undefined): void;
  /** Önizleme satırı (kaç segment, kaç bölüm). `undefined` gizler. */
  setPreview(text: string | undefined): void;
  /** Ana düğme; `label` `undefined` ise düğme hiç görünmez. */
  setPrimary(label: string | undefined, enabled: boolean): void;
  /** Maddeleri listeye EKLER — chunk chunk gelebilir, hepsi beklenmez. */
  addItems(items: PanelItem[]): void;
  /** Listeyi boşaltır. */
  clearItems(): void;
  /** Liste boşken gösterilecek açıklama. `undefined` gizler. */
  setEmptyMessage(title: string | undefined, detail?: string): void;
  /** Alttaki özet satırı. */
  setSummary(text: string | undefined): void;
  /** Kısmi başarısızlık satırı; boş dizi gizler. */
  setFailures(failures: { chunkIndex: number; error: string }[], note?: string): void;
  /** Sonuç önbellekten geldiyse işaretler. */
  setCached(cached: boolean): void;
  /** Liste gözden geçirilmiş vitrin verisi mi? Rozet + açıklama satırı. */
  setReviewed(reviewed: boolean): void;
  /** Küçük ikincil eylem; `undefined` gizler. */
  setSecondary(label: string | undefined): void;
  /**
   * Anahtarsız + vitrin dışı video görünümü. `undefined` gizler; dizi (boş da
   * olabilir) verilirse açıklama, vitrin listesi ve ayar bağlantısı görünür.
   */
  setNoKeyInfo(showcases: ShowcaseEntry[] | undefined): void;
  /** Ayar sayfası bağlantısı (izin/anahtar hatası); `undefined` gizler. */
  setSettingsLink(label: string | undefined): void;
  /** Aktif maddeyi vurgular; `undefined` vurguyu kaldırır. */
  setActiveItem(index: number | undefined): void;
  /** Panel küçültülmüş mü? (Görünmeyen liste kaydırılmaz.) */
  isCollapsed(): boolean;
  /** Kaydedilmiş konumu uygular. */
  setPosition(position: PanelPosition | undefined): void;
  /** Paneli DOM'dan kaldırır ve dinleyicilerini söker. */
  destroy(): void;
}

/** `93.4` → `1:33`. Panelde okunabilir zaman damgası. */
function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function button(className: string, text: string, title?: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.className = className;
  element.type = "button";
  element.textContent = text;
  if (title !== undefined) element.title = title;
  return element;
}

function div(className: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  return element;
}

/** Panel ekran dışına çıkmasın: sürüklemede ve pencere boyutlanmasında. */
function clampPosition(position: PanelPosition, panel: HTMLElement): PanelPosition {
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  // En az bir başlık çubuğu kadarı içeride kalsın; tamamen dışarı kaçan bir
  // panel geri getirilemez olurdu.
  const minVisible = 48;

  const maxLeft = Math.max(0, window.innerWidth - width);
  const maxTop = Math.max(0, window.innerHeight - Math.min(height, minVisible));

  return {
    left: Math.min(Math.max(0, position.left), maxLeft),
    top: Math.min(Math.max(0, position.top), maxTop),
  };
}

/**
 * Paneli kurar ve sayfaya ekler.
 *
 * Aynı anda tek panel olur: yeniden çağrılırsa eskisi kaldırılır. Koşum
 * tekrarlandığında iki panel üst üste binmesin.
 */
export function mountPanel(options: PanelOptions): Panel {
  document.querySelectorAll(`.${PANEL_CLASS}`).forEach((old) => old.remove());

  const panel = div(PANEL_CLASS);

  // ── Başlık (sürükleme tutamacı) ──
  const header = div("rv-header");

  const title = document.createElement("span");
  title.className = "rv-title";
  title.textContent = msg("extName");

  const cachedBadge = document.createElement("span");
  cachedBadge.className = "rv-badge";
  cachedBadge.textContent = msg("panelBadgeCached");
  cachedBadge.hidden = true;

  // 🔴 "gözden geçirildi" — karar 8'in "Dikkat" notu: vitrin maddeleri insan
  // kapısından geçti, BYOK maddeleri geçmedi. Kullanıcı hangisine baktığını
  // bilmeli; rozet yalnız vitrin verisinde görünüyor.
  const reviewedBadge = document.createElement("span");
  reviewedBadge.className = "rv-badge rv-badge-reviewed";
  reviewedBadge.textContent = msg("panelBadgeReviewed");
  reviewedBadge.title = msg("panelBadgeReviewedTitle");
  reviewedBadge.hidden = true;

  const collapse = button("rv-icon", "^", msg("panelCollapse"));
  const close = button("rv-icon", "✕", msg("panelClose"));

  const headerLeft = div("rv-header-left");
  headerLeft.append(title, reviewedBadge, cachedBadge);
  const headerRight = div("rv-header-right");
  headerRight.append(collapse, close);
  header.append(headerLeft, headerRight);

  // ── Gövde ──
  const body = div("rv-body");

  const notice = div("rv-notice");
  notice.textContent = msg("panelDisclaimer");
  // Başlangıçta liste boş: uyarı gizli (`updateNotice`).
  notice.hidden = true;

  const sourceNote = div("rv-notice rv-notice-source");
  sourceNote.hidden = true;

  // Vitrin durumunda TEK satır: iki ayrı uyarı ("otomatik üretildi, yanlış
  // olabilir" + "elle gözden geçirildi") birlikte çelişik okunuyordu. Vitrinde
  // genel uyarının yerini bu alıyor; BYOK durumunda genel uyarı aynen kalıyor.
  const reviewedNote = div("rv-notice rv-notice-reviewed");
  reviewedNote.textContent = msg("panelReviewedNote");
  reviewedNote.hidden = true;

  // Anahtarsız + vitrin dışı video: işlenecek bir şey yok, ama boş panel de
  // yok — nereye gidilebileceği söyleniyor.
  const noKey = div("rv-nokey");
  noKey.hidden = true;

  const status = div("rv-status");
  const statusText = document.createElement("span");
  statusText.className = "rv-status-text";
  statusText.textContent = msg("statusIdle");
  const statusCode = document.createElement("span");
  statusCode.className = "rv-status-code";
  statusCode.hidden = true;
  status.append(statusText, statusCode);

  const preview = div("rv-preview");
  preview.hidden = true;

  // Ana düğme: "Başlat" ya da "Yeniden işle". 🔴 İşlem BU düğmeyle başlıyor,
  // ikonla değil: ikona yanlışlıkla tıklamak ~$0.04 ve ~60 saniye harcıyordu.
  const primaryRow = div("rv-primary-row");
  const primary = button("rv-primary", msg("buttonStart"));
  primaryRow.append(primary);
  primaryRow.hidden = true;

  // İkincil eylem: küçük, bağlantı görünümünde. Vitrin videosunda anahtarı
  // olan kullanıcıya "kendi anahtarınızla yeniden işleyin" seçeneği.
  const secondaryRow = div("rv-secondary-row");
  const secondary = button("rv-secondary", "");
  secondaryRow.append(secondary);
  secondaryRow.hidden = true;

  // Ayar sayfası bağlantısı: izin ya da anahtar eksikken çözüm orada.
  const settingsRow = div("rv-secondary-row");
  const settingsLink = button("rv-secondary", "");
  settingsLink.addEventListener("click", () => options.onOpenOptions());
  settingsRow.append(settingsLink);
  settingsRow.hidden = true;

  const empty = div("rv-empty");
  empty.hidden = true;
  const emptyTitle = div("rv-empty-title");
  const emptyDetail = div("rv-empty-detail");
  empty.append(emptyTitle, emptyDetail);

  const list = document.createElement("ul");
  list.className = "rv-list";

  // "takibe dön": kullanıcı listeyi elle kaydırdığında beliriyor.
  const followRow = div("rv-follow-row");
  followRow.hidden = true;
  const followBack = button("rv-follow", msg("panelFollowBack"));
  followRow.append(followBack);

  // ── Alt çubuk ──
  const footer = div("rv-footer");

  const failures = div("rv-failures");
  failures.hidden = true;
  const failuresLine = button("rv-failures-line", "");
  const failuresDetail = div("rv-failures-detail");
  failuresDetail.hidden = true;
  failures.append(failuresLine, failuresDetail);

  const summary = div("rv-summary");
  summary.hidden = true;

  const actions = div("rv-actions");
  const copy = button("rv-action", msg("panelCopy"), msg("panelCopyTitle"));
  actions.append(copy);

  footer.append(failures, summary, actions);

  body.append(
    notice,
    reviewedNote,
    sourceNote,
    status,
    noKey,
    preview,
    primaryRow,
    secondaryRow,
    settingsRow,
    empty,
    list,
    followRow,
    footer,
  );
  panel.append(header, body);

  // ── Konumlandırma ve tam ekran ──
  //
  // 🔴 TAM EKRAN: `position: fixed` bir eleman, tam ekrana alınan başka bir
  // elemanın (YouTube'da `#movie_player`) İÇİNDE değilse hiç çizilmez. Bu
  // yüzden tam ekrana geçildiğinde panel o elemanın içine taşınıyor, çıkışta
  // `body`'ye geri dönüyor. Taşımadan sonra konum yeniden sınırlanıyor: yeni
  // kapsayıcının ölçüleri farklı olabilir.
  let position: PanelPosition | undefined;

  const applyPosition = (): void => {
    if (!position) {
      panel.style.removeProperty("left");
      panel.style.removeProperty("top");
      panel.style.removeProperty("right");
      return;
    }
    const clamped = clampPosition(position, panel);
    position = clamped;
    panel.style.left = `${clamped.left}px`;
    panel.style.top = `${clamped.top}px`;
    panel.style.right = "auto";
  };

  const attach = (): void => {
    const host = document.fullscreenElement ?? document.body;
    if (panel.parentElement !== host) host.append(panel);
    applyPosition();
  };

  attach();
  document.addEventListener("fullscreenchange", attach);
  window.addEventListener("resize", applyPosition);

  // ── Sürükleme: YALNIZ başlıktan ──
  // Liste alanından sürüklemek kaydırmayı bozuyor, o yüzden tutamaç başlık.
  let dragOffset: { x: number; y: number } | undefined;

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragOffset) return;
    position = clampPosition(
      { left: event.clientX - dragOffset.x, top: event.clientY - dragOffset.y },
      panel,
    );
    applyPosition();
  };

  const onPointerUp = (): void => {
    if (!dragOffset) return;
    dragOffset = undefined;
    panel.classList.remove("rv-dragging");
    options.onMove?.(position);
  };

  header.addEventListener("pointerdown", (event: PointerEvent) => {
    // Düğmelere basıldığında sürükleme başlamasın.
    if (event.target instanceof HTMLButtonElement) return;
    if (event.button !== 0) return;

    const rect = panel.getBoundingClientRect();
    dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    position = { left: rect.left, top: rect.top };
    panel.classList.add("rv-dragging");
    event.preventDefault();
  });

  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);

  // Çift tıklama → varsayılan konum. Küçük ama işe yarar kaçış: panel garip
  // bir yere sürüklendiyse tek hareketle geri geliyor.
  header.addEventListener("dblclick", (event: MouseEvent) => {
    if (event.target instanceof HTMLButtonElement) return;
    position = undefined;
    applyPosition();
    options.onMove?.(undefined);
  });

  // ── Senkron takip durumu ──
  const rows: HTMLLIElement[] = [];

  /** Liste gözden geçirilmiş vitrin verisi mi? Genel uyarının yerini alıyor. */
  let reviewedState = false;
  const updateNotice = (): void => {
    notice.hidden = reviewedState || rows.length === 0;
  };
  let activeIndex: number | undefined;
  let follow = true;
  /** Kendi tetiklediğimiz kaydırmayı "kullanıcı kaydırdı" sanmamak için. */
  let selfScrollUntil = 0;

  list.addEventListener("scroll", () => {
    if (Date.now() < selfScrollUntil) return;
    if (!follow) return;
    // Kullanıcı listeyle etkileşti: takip DURUR. Zorlamasız takip kuralı —
    // kullanıcının okuduğu yeri videonun altından çekmiyoruz.
    follow = false;
    followRow.hidden = false;
  });

  const scrollToActive = (): void => {
    if (!follow) return;
    if (panel.classList.contains("rv-collapsed")) return;
    if (activeIndex === undefined) return;

    const row = rows[activeIndex];
    if (!row) return;

    // Art arda tetiklenip titremesin: kendi kaydırmamızı kısa bir süre
    // "kullanıcı değil" diye işaretliyoruz.
    selfScrollUntil = Date.now() + 700;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  followBack.addEventListener("click", () => {
    follow = true;
    followRow.hidden = true;
    scrollToActive();
  });

  // ── Düğmeler ──
  const destroy = (): void => {
    document.removeEventListener("fullscreenchange", attach);
    window.removeEventListener("resize", applyPosition);
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    panel.remove();
  };

  close.addEventListener("click", () => {
    destroy();
    // Çağıran taraf paneli yeniden kurabilmek için kapanmayı BİLMEK zorunda:
    // yoksa durum bayrağı "panel var" diye kalır ve ikon tetiği sessizce
    // hiçbir şey yapmaz (ölçülmüş hata).
    options.onClose?.();
  });

  collapse.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("rv-collapsed");
    collapse.textContent = collapsed ? "⌄" : "^";
    collapse.title = collapsed ? msg("panelExpand") : msg("panelCollapse");
    // Büyütülünce aktif maddeye geri dön: küçükken kaydırma yapılmıyordu.
    if (!collapsed) scrollToActive();
  });

  primary.addEventListener("click", () => options.onPrimary());
  secondary.addEventListener("click", () => options.onSecondary());

  copy.addEventListener("click", () => {
    void (async () => {
      copy.disabled = true;
      try {
        await options.onCopy();
        copy.textContent = msg("panelCopied");
      } catch {
        copy.textContent = msg("panelCopyFailed");
      } finally {
        copy.disabled = false;
        setTimeout(() => {
          copy.textContent = msg("panelCopy");
        }, 2000);
      }
    })();
  });

  failuresLine.addEventListener("click", () => {
    failuresDetail.hidden = !failuresDetail.hidden;
  });

  return {
    setStatus: (text, code) => {
      statusText.textContent = text;
      if (code === undefined) {
        statusCode.hidden = true;
        statusCode.textContent = "";
        return;
      }
      // Ham hata sınıfı İKİNCİL bilgi: küçük puntoyla, kullanıcı metninin
      // yanında. Hata raporlarken işe yarıyor, okunması gerekmiyor.
      statusCode.textContent = code;
      statusCode.hidden = false;
    },

    setSourceNote: (text) => {
      if (text === undefined) {
        sourceNote.hidden = true;
        sourceNote.textContent = "";
        return;
      }
      sourceNote.textContent = text;
      sourceNote.hidden = false;
    },

    setPreview: (text) => {
      if (text === undefined) {
        preview.hidden = true;
        preview.textContent = "";
        return;
      }
      preview.textContent = text;
      preview.hidden = false;
    },

    setPrimary: (label, enabled) => {
      if (label === undefined) {
        primaryRow.hidden = true;
        return;
      }
      primary.textContent = label;
      primary.disabled = !enabled;
      primaryRow.hidden = false;
    },

    setCached: (isCached) => {
      cachedBadge.hidden = !isCached;
    },

    setReviewed: (reviewed) => {
      reviewedBadge.hidden = !reviewed;
      reviewedNote.hidden = !reviewed;
      // Genel uyarı ve vitrin satırı birbirinin yerine geçiyor, yan yana
      // durmuyor.
      reviewedState = reviewed;
      updateNotice();
    },

    setSecondary: (label) => {
      if (label === undefined) {
        secondaryRow.hidden = true;
        return;
      }
      secondary.textContent = label;
      secondaryRow.hidden = false;
    },

    setNoKeyInfo: (showcaseList) => {
      noKey.replaceChildren();
      if (showcaseList === undefined) {
        noKey.hidden = true;
        return;
      }

      const intro = div("rv-nokey-intro");
      intro.textContent = msg("noKeyIntro");
      noKey.append(intro);

      if (showcaseList.length > 0) {
        const label = div("rv-nokey-label");
        label.textContent = msg("noKeyShowcaseLabel");
        const links = document.createElement("ul");
        links.className = "rv-nokey-list";
        for (const entry of showcaseList) {
          const item = document.createElement("li");
          const link = document.createElement("a");
          link.href = showcaseUrl(entry.videoId);
          link.textContent = entry.title;
          item.append(link);
          links.append(item);
        }
        noKey.append(label, links);
      }

      const byok = div("rv-nokey-byok");
      const settings = button("rv-secondary", msg("noKeyByok"));
      settings.addEventListener("click", () => options.onOpenOptions());
      // Not AYRI bir blok eleman ve kendi cümlesi: satır içi `span` iken
      // bağlantıyla aynı satıra akıyor, kopyalanınca "…işleyinücretli…" diye
      // bitişik çıkıyordu. Blok eleman, kopyalanan metinde de satır sonu.
      const paid = div("rv-nokey-paid");
      // Ölçüldü (21 Eyl 2026): ücretsiz Mistral anahtarı kullanılan modellere
      // erişemiyor; aşağıdaki UI metni bu ölçüme dayanıyor.
      paid.textContent = msg("noKeyPaid");
      byok.append(settings, paid);
      noKey.append(byok);

      const later = div("rv-nokey-note");
      later.textContent = msg("noKeyLater");
      noKey.append(later);

      noKey.hidden = false;
    },

    setSettingsLink: (label) => {
      if (label === undefined) {
        settingsRow.hidden = true;
        return;
      }
      settingsLink.textContent = label;
      settingsRow.hidden = false;
    },

    setEmptyMessage: (titleText, detail) => {
      if (titleText === undefined) {
        empty.hidden = true;
        return;
      }
      emptyTitle.textContent = titleText;
      emptyDetail.textContent = detail ?? "";
      empty.hidden = false;
    },

    clearItems: () => {
      list.replaceChildren();
      rows.length = 0;
      activeIndex = undefined;
      follow = true;
      followRow.hidden = true;
      summary.hidden = true;
      failures.hidden = true;
      failuresDetail.hidden = true;
      updateNotice();
    },

    addItems: (items) => {
      for (const item of items) {
        const row = document.createElement("li");
        row.className = "rv-item";

        // 🔴 MADDENİN TAMAMI bir düğme: tıklanınca video o sahneye atlıyor.
        // Eylem düğmeleri (aşağıda) bunun DIŞINDA — düğme içine düğme
        // konamaz ve konsaydı hangi tıkın ne yaptığı belirsizleşirdi.
        const main = button("rv-item-main", "");
        main.textContent = "";
        main.title = msg("itemGoTitle");

        const head = document.createElement("span");
        head.className = "rv-item-head";

        const term = document.createElement("span");
        term.className = "rv-term";
        term.textContent = item.term;

        const time = document.createElement("span");
        time.className = "rv-time";
        time.textContent = formatTime(item.start);

        head.append(term, time);

        const sense = document.createElement("span");
        sense.className = "rv-sense";
        sense.textContent = item.senseHere;

        const hint = document.createElement("span");
        hint.className = "rv-hint";
        hint.textContent = msg("itemGoHint");

        main.append(head, sense, hint);
        main.addEventListener("click", () => options.onSeek(item.start));
        row.append(main);

        const itemActions = div("rv-item-actions");

        // ⚠️ `nuance` ÖLÇÜLMÜŞ BİÇİMDE UZUN (3-4 cümle). Varsayılan kapalı:
        // liste taranabilir kalmalı.
        let nuance: HTMLParagraphElement | undefined;
        if (item.nuance !== undefined && item.nuance !== "") {
          nuance = document.createElement("p");
          nuance.className = "rv-nuance";
          nuance.textContent = item.nuance;
          nuance.hidden = true;

          const more = button("rv-more", msg("itemMore"));
          more.addEventListener("click", () => {
            if (!nuance) return;
            nuance.hidden = !nuance.hidden;
            more.textContent = nuance.hidden ? msg("itemMore") : msg("itemLess");
          });
          itemActions.append(more);
        } else {
          const spacer = document.createElement("span");
          spacer.className = "rv-spacer";
          itemActions.append(spacer);
        }

        // 🔴 HATA BİLDİRİMİ: eklentide uzman insan kapısı yok ve kusur sınıfı
        // doğrudan kullanıcıya gidiyor. Sunucu YOK.
        const report = button("rv-report", msg("itemReport"), msg("itemReportTitle"));
        report.addEventListener("click", () => {
          void (async () => {
            report.disabled = true;
            try {
              await options.onReport(item);
              report.textContent = msg("itemReportSaved");
            } catch {
              report.textContent = msg("itemReportFailed");
              report.disabled = false;
            }
          })();
        });
        itemActions.append(report);

        row.append(itemActions);
        if (nuance) row.append(nuance);

        list.append(row);
        rows.push(row);
      }
      updateNotice();
    },

    setActiveItem: (index) => {
      if (index === activeIndex) return;

      if (activeIndex !== undefined) {
        rows[activeIndex]?.classList.remove("rv-item-active");
      }
      activeIndex = index;
      if (index === undefined) return;

      rows[index]?.classList.add("rv-item-active");
      scrollToActive();
    },

    setSummary: (text) => {
      if (text === undefined) {
        summary.hidden = true;
        return;
      }
      summary.textContent = text;
      summary.hidden = false;
    },

    setFailures: (list_, note) => {
      if (list_.length === 0) {
        failures.hidden = true;
        return;
      }

      failuresLine.textContent = msg("failuresSummary", list_.length);
      failuresDetail.replaceChildren();

      for (const failure of list_) {
        const line = div("rv-failure");
        line.textContent = msg("failureLine", failure.chunkIndex + 1, failure.error);
        failuresDetail.append(line);
      }

      if (note !== undefined) {
        const noteLine = div("rv-failure rv-failure-note");
        noteLine.textContent = note;
        failuresDetail.append(noteLine);
      }

      failures.hidden = false;
    },

    isCollapsed: () => panel.classList.contains("rv-collapsed"),

    setPosition: (value) => {
      position = value;
      applyPosition();
    },

    destroy,
  };
}
