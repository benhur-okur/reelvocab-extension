// BYOK ayar sayfası — anahtarı al, sakla, bitir.
//
// KAPSAM DAR: sağlayıcı/model seçimi, maliyet tahmini,
// kota göstergesi yok. Anahtar doğrulama (test çağrısı) da bu turda YOK.
//
// 🔴 `chrome.storage.local`, `sync` DEĞİL. `sync` anahtarı kullanıcının Google
// hesabıyla bulut üzerinden eşitler; API anahtarı için yanlış yer. Anahtar bu
// tarayıcıda kalır.

// Anahtar adı paylaşılan sabitten gelir: aynı dizeyi burada ve background'da
// ayrı ayrı yazmak, biri değiştiğinde sessiz hata üretiyordu.
import { STORAGE_KEY_MISTRAL as STORAGE_KEY } from "../lib/storageKeys";
import { readShowcaseEntries, showcaseUrl } from "../lib/showcase";
import type { ShowcaseEntry } from "../lib/showcase";
import { MISTRAL_ORIGINS } from "../lib/permissions";
import { msg } from "../lib/i18n";
import type { MessageKey } from "../lib/i18n";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

/**
 * Elemanları tipleriyle birlikte bulur.
 *
 * `getElementById` `HTMLElement | null` veriyor; `instanceof` ile daraltmak
 * hem `any`'den hem de `as` zorlamasından kurtarıyor. HTML ile TS arasındaki
 * bağ elle kurulduğu için (id'ler iki dosyada tekrar ediyor) eksik eleman
 * sessizce geçmesin: durum satırına yazıp duruyoruz.
 */
function findElements():
  | { input: HTMLInputElement; save: HTMLButtonElement; status: HTMLElement }
  | undefined {
  const input = document.getElementById("api-key");
  const save = document.getElementById("save");
  const status = document.getElementById("status");

  if (
    !(input instanceof HTMLInputElement) ||
    !(save instanceof HTMLButtonElement) ||
    status === null
  ) {
    return undefined;
  }

  return { input, save, status };
}

function setStatus(status: HTMLElement, message: string, isError = false): void {
  status.textContent = message;
  if (isError) {
    status.dataset.kind = "error";
  } else {
    delete status.dataset.kind;
  }
}

/**
 * Saklanan anahtarı okur.
 *
 * `chrome.storage` tipleri değeri `any` olarak veriyor; `unknown` üzerinden
 * alıp daraltıyoruz ki `any` kodun içine sızmasın.
 */
async function readStoredKey(): Promise<string> {
  const stored: unknown = await chrome.storage.local.get(STORAGE_KEY);
  const value = asRecord(stored)?.[STORAGE_KEY];
  return typeof value === "string" ? value : "";
}

/**
 * Vitrin listesini background'dan ister ve gösterir (karar 8).
 *
 * Veri background bundle'ında gömülü; ayar sayfası da içerik betiği gibi
 * mesajla istiyor — `web_accessible_resources` yok. Liste boşsa bölüm gizli
 * kalıyor, hata göstermiyor: sıfır vitrin videosu geçerli bir durum.
 */
async function renderShowcaseList(): Promise<void> {
  const container = document.getElementById("showcase");
  const list = document.getElementById("showcase-list");
  if (!container || !list) return;

  let entries: ShowcaseEntry[] = [];
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: "showcase-list" });
    entries = readShowcaseEntries(response);
  } catch (error) {
    console.warn("[reelvocab:options] vitrin listesi alınamadı", error);
    return;
  }

  if (entries.length === 0) return;

  for (const entry of entries) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = showcaseUrl(entry.videoId);
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = entry.title;
    item.append(link);
    list.append(item);
  }
  container.hidden = false;
}

/**
 * `data-i18n` taşıyan elemanların metnini doldurur.
 *
 * Buradaki anahtar HTML'den okunuyor — derleme zamanında tipi bilinemiyor.
 * Güvence build.mjs'te: HTML'deki her `data-i18n` değeri iki dil dosyasında
 * da aranıyor, yoksa build düşüyor. `msg` boş metin yerine anahtarı gösterdiği
 * için kaçan bir hata sayfada yine görünür.
 */
function applyStaticMessages(): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n;
    if (key === undefined || key === "") continue;
    element.textContent = msg(key as MessageKey); // i18n-dynamic: data-i18n, build.mjs HTML'yi tarıyor
  }
}

async function main(): Promise<void> {
  applyStaticMessages();
  void renderShowcaseList();

  const elements = findElements();
  if (!elements) {
    // Sayfa iskeleti beklenenden farklı — sessiz kalmak yerine konsola yaz.
    console.error("[reelvocab:options] beklenen elemanlar bulunamadı");
    return;
  }

  const { input, save, status } = elements;

  // Mevcut anahtar düz metin olarak gösterilir (maskelenmez): burası yerel bir
  // ayar sayfası ve kullanıcının kendi anahtarını görüp doğrulaması gerekiyor.
  // Alandaki `type="password"` yalnız omuz üstünden bakışa karşı.
  try {
    input.value = await readStoredKey();
  } catch (error) {
    setStatus(status, msg("optionsStatusReadFailed"), true);
    console.error("[reelvocab:options] okuma hatası", error);
  }

  save.addEventListener("click", () => {
    void (async () => {
      const value = input.value.trim();

      try {
        if (value === "") {
          // Boş kayıt = anahtarı SİL. Boş dize yazmak yerine kaydı kaldırmak,
          // "anahtar yok" durumunu okuyan taraf için tek biçimli tutuyor.
          await chrome.storage.local.remove(STORAGE_KEY);

          // Anahtar yoksa Mistral'a erişim izninin de bir gerekçesi yok: geri
          // alınıyor. Anahtar silindi ama izin kaldı — bu yarım durum
          // zararsız (çağrı zaten `NO_API_KEY`'de duruyor), yine de söyleniyor.
          try {
            await chrome.permissions.remove({ origins: MISTRAL_ORIGINS });
            setStatus(status, msg("optionsStatusDeleted"));
          } catch (error) {
            setStatus(status, msg("optionsStatusDeletedPermissionKept"), true);
            console.error("[reelvocab:options] izin geri alma hatası", error);
          }
          return;
        }

        // 🔴 İZİN, `await`'TEN ÖNCE İSTENİYOR. `chrome.permissions.request`
        // yalnız bir kullanıcı jestinin içinde çalışıyor; async gövde ilk
        // `await`'e kadar tıklama olayıyla aynı eşzamanlı adımda koşuyor, yani
        // bu çağrı hâlâ jestin içinde. Önüne bir `await` eklemek istemi
        // bozar.
        //
        // İzin kurulumda istenmiyor (`optional_host_permissions`): yalnız
        // anahtarını kaydeden kullanıcıya, anahtarın kullanılacağı tek köken
        // için.
        const granted = await chrome.permissions.request({ origins: MISTRAL_ORIGINS });
        if (!granted) {
          // Anahtar KAYDEDİLMİYOR: izinsiz anahtar her çağrıda
          // `PERMISSION_MISSING` üretirdi — kayıtlı ama işe yaramaz.
          setStatus(
            status,
            msg("optionsStatusPermissionDenied"),
            true,
          );
          return;
        }

        await chrome.storage.local.set({ [STORAGE_KEY]: value });
        setStatus(status, msg("optionsStatusSaved"));
      } catch (error) {
        setStatus(status, msg("optionsStatusSaveFailed"), true);
        console.error("[reelvocab:options] yazma hatası", error);
      }
    })();
  });
}

void main();
