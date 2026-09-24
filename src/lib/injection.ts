// Tıklamada enjeksiyonun paylaşılan sabitleri.
//
// Önceden işaret adı background.ts ve content.ts'te ayrı ayrı yazılıydı; biri
// değişip diğeri kalsaydı background betiği hiç "var" görmez, her tıklamada
// yeniden enjekte ederdi — iki panel, iki dinleyici. Bu dosyada `chrome.*`
// yok: iki bağlamda da güvenle içe aktarılıyor.

/**
 * İçerik betiğinin İZOLE ortamın global'ine koyduğu işaret. Sayfanın JS'i
 * izole ortamı göremiyor; işaret eklentinin varlığını sayfaya sızdırmıyor.
 */
export const ISOLATED_READY_FLAG = "__reelvocabIsolatedReady";
