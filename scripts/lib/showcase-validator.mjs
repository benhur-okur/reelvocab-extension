// `src/lib/showcase.ts` doğrulayıcısını Node betiklerinde kullanılabilir yapar.
//
// 🔴 KOPYALAMA YOK. Build ve vitrin dönüştürücüsü, eklentinin çalışma zamanında
// kullandığı AYNI `parseShowcase()` fonksiyonunu çağırıyor. İki ayrı
// doğrulayıcı zamanla ayrışır: biri bir dosyayı geçirir, diğeri reddeder ve
// hata ancak yayında görünür.
//
// Nasıl: esbuild `showcase.ts`'i bellekte tek bir ESM modülüne derliyor
// (`write: false`) ve modül `data:` URL'siyle içe aktarılıyor. Diske ara dosya
// yazılmıyor. `showcase.ts` `annotate.ts`'ten yalnız TİP içe aktarıyor; tipler
// derlemede siliniyor, yani promptu gömen kod bu pakete girmiyor.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHOWCASE_MODULE = resolve(ROOT, "src/lib/showcase.ts");

/**
 * @typedef {{ ok: true, video: { videoId: string } & Record<string, unknown> }
 *   | { ok: false, reason: string }} ParseResult
 */

/**
 * @returns {Promise<{
 *   parseShowcase: (value: unknown, source: string) => ParseResult,
 *   surfaceKey: (term: string) => string,
 * }>}
 */
export async function loadShowcaseValidator() {
  const result = await esbuild.build({
    entryPoints: [SHOWCASE_MODULE],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });

  const output = result.outputFiles[0];
  if (!output) throw new Error("showcase.ts derlenemedi: çıktı yok");

  const url = `data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`;
  /** @type {Record<string, unknown>} */
  const module = await import(url);

  const parseShowcase = module.parseShowcase;
  if (typeof parseShowcase !== "function") {
    throw new Error("showcase.ts: parseShowcase dışa aktarılmamış");
  }

  // Video genelinde tekrar anahtarı — canlı işlemeyle AYNI fonksiyon.
  const surfaceKey = module.surfaceKey;
  if (typeof surfaceKey !== "function") {
    throw new Error("showcase.ts: surfaceKey dışa aktarılmamış");
  }

  return {
    parseShowcase: /** @type {(value: unknown, source: string) => ParseResult} */ (
      parseShowcase
    ),
    surfaceKey: /** @type {(term: string) => string} */ (surfaceKey),
  };
}
