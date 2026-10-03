import { useAppStore } from '@/app/store'
import type { ExportDecoder } from '../engine/protocol'

/**
 * QA (A/B do benchmark de exportação, G1): `CIALIGHT_QA_EXPORT_DECODER=hardware` com CIALIGHT_QA, fora do pacote, força
 * o decoder de hardware (caminho antigo) na exportação. O main só preenche `appInfo.qaExportDecoder` nesse caso;
 * no uso normal é sempre 'auto' (decoder em software + caminho YUV).
 */
export function qaExportDecoder(): ExportDecoder {
  const info = useAppStore.getState().appInfo
  return info?.isPackaged === false && info.qaExportDecoder === 'hardware' ? 'hardware' : 'auto'
}
