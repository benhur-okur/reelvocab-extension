// Yayın paketi: releases/reelvocab-<versionName>.zip
//
// Kullanım:  npm run package
//
// 1) YAYIN derlemesi alınır (`scripts/build.mjs`, `--dev` YOK). Build kendi
//    doğrulamalarını yapıyor (sürüm, Mistral kökeni, description uzunluğu,
//    dist/'te geliştirme kodu yok); biri düşerse paket hiç oluşmuyor.
// 2) dist/ zip'lenir. Kaynak haritaları (`*.map`) dışarıda bırakılır —
//    yayın derlemesi zaten üretmiyor, bu ikinci kilit.
// 3) Zip içeriği listelenir.
//
// 🔴 Neden sistemdeki `zip` komutu, Node'un yerleşik araçları değil: Node'da
// zip YAZICISI yok — `node:zlib` yalnız deflate akışı veriyor; kapsayıcıyı
// (yerel başlıklar, merkez dizin, CRC'ler) elle yazmak gerekirdi. O kod bir
// kez yazılıp test edilmeden paketlenen her sürümün bozuk çıkma riskini
// taşırdı. `zip` macOS ve Linux'ta hazır, biçimi onlarca yıldır sabit.
// Karşılığı: Windows'ta yok — betik bunu açık hatayla söylüyor.

import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, "dist");
const RELEASES = resolve(ROOT, "releases");

/** Komutu çalıştırır; başarısızsa çıkış koduyla durur. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) {
    console.error(`[package] ✗ ${command} çalıştırılamadı: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[package] ✗ ${command} ${result.status} koduyla bitti`);
    process.exit(result.status ?? 1);
  }
}

// Dosya adı `versionName`'den (ör. 0.1.0-rc2), `version`'dan değil. rc1 ve
// rc2 aynı `version`'u (0.1.0) taşıdığı için aynı dosya adıyla birbirinin
// üstüne yazılıyor ve ayırt edilemiyordu — test sırasında yanlış paketin
// yüklü kalmasına zemin hazırlayan sorunun dosya düzeyindeki hali
// (manifest'teki `version_name` gerekçesiyle aynı). Mağaza gönderiminde
// versionName "0.1.0" olacağı için son paket yine reelvocab-0.1.0.zip.
const { versionName } = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
if (typeof versionName !== "string" || versionName === "") {
  console.error("[package] ✗ package.json'da versionName yok");
  process.exit(1);
}

run(process.execPath, [resolve(ROOT, "scripts/build.mjs")]);

await mkdir(RELEASES, { recursive: true });
const zipPath = resolve(RELEASES, `reelvocab-${versionName}.zip`);
// Eski arşiv silinmezse `zip` ona EKLER: kaldırılmış bir dosya pakette kalır.
await rm(zipPath, { force: true });

// `-X`: işletim sistemine özgü ek öznitelikler yok. `-r`: klasörler.
// Çalışma dizini dist/ — arşivde yollar dist/ öneki olmadan, manifest kökte.
run("zip", ["-r", "-X", "-q", zipPath, ".", "-x", "*.map", "-x", ".DS_Store"], { cwd: DIST });

console.log(`\n[package] ${zipPath.slice(ROOT.length + 1)} içeriği:`);
run("unzip", ["-l", zipPath]);
